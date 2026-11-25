import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { overviewCalibration, playableCalibration, renderOverview } from './overview.mjs';

test('official overview text supplies the three calibration fields', () => {
  const text = '"de_x"\n{\n\t"material"\t"overviews/de_x"\n\t"pos_x"\t\t"-3230"\n\t"pos_y"\t\t"1713"\n\t"scale"\t\t"5.00"\n}';
  assert.deepEqual(overviewCalibration(text), { x: -3230, y: 1713, scale: 5 });
  assert.equal(overviewCalibration('"de_x" { "pos_x" "1" }'), undefined);
});

test('playable bounds come from spawn and objective entities and form a square', () => {
  const calibration = playableCalibration([
    { classname: 'info_player_terrorist', origin: '-1000 -500 0' },
    { classname: 'info_player_counterterrorist', origin: [1000, 1500, 64] },
    { classname: 'prop_static', origin: [90000, 90000, 0] },
  ]);
  // Span 2000 in both axes around (0, 500), widened by 25% plus 512 on each side.
  assert.deepEqual(calibration, { x: -1762, y: 2262, scale: 3.4414, ceiling: 384 });
  assert.equal(playableCalibration([{ classname: 'info_player_terrorist', origin: [0, 0, 0] }]), undefined);
});

test('the render rasterizes upward surfaces below the ceiling into a calibrated PNG', () => {
  // One floor quad covering the left half of the image and one roof above the ceiling.
  const stride = 60;
  const quad = (z, x0, x1) => {
    const v = Buffer.alloc(4 * stride);
    [
      [x0, -500],
      [x1, -500],
      [x1, 500],
      [x0, 500],
    ].forEach(([x, y], i) => {
      v.writeFloatLE(x, i * stride);
      v.writeFloatLE(y, i * stride + 4);
      v.writeFloatLE(z, i * stride + 8);
    });
    const indices = Buffer.alloc(6 * 4);
    [0, 1, 2, 0, 2, 3].forEach((index, i) => indices.writeUInt32LE(index, i * 4));
    return { v, indices, family: 'opaque', sky: false };
  };
  const rendered = renderOverview('de_x', [quad(0, -500, 0), quad(1000, 0, 500)], {
    x: -500,
    y: 500,
    scale: 1000 / 1024,
    ceiling: 300,
  });
  assert.match(rendered.text, /"pos_x"\t\t"-500"/);
  const png = rendered.png;
  assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71]);
  const idat = png.indexOf('IDAT') + 4;
  const rows = inflateSync(png.subarray(idat, png.indexOf('IEND') - 8));
  const alpha = (x, y) => rows[y * (1024 * 4 + 1) + 1 + x * 4 + 3];
  assert.equal(alpha(100, 512), 255);
  // The roof is above the ceiling and stays transparent.
  assert.equal(alpha(900, 512), 0);
  assert.equal(renderOverview('de_x', [], { x: 0, y: 0, scale: 1 }), undefined);
});
