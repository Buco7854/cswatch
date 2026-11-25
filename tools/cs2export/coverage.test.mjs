import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from '../../frontend/node_modules/pngjs/lib/png.js';
import { coveragePose, radarCoverage } from './coverage.mjs';

test('the coverage pose frames the official calibration orthographically from above', () => {
  const pose = coveragePose(
    { bounds: [0, 0, -100, 10, 10, 900] },
    { origin: { x: -2087, y: 3870 }, scale: 4.9, referenceSize: 1024 },
  );
  assert.deepEqual(pose.pos, [-2087 + 512 * 4.9, 3870 - 512 * 4.9, 1412]);
  assert.equal(pose.ortho, 512 * 4.9);
  assert.equal(pose.view, 7);
  assert.equal(pose.skybox3D, false);
  assert.equal(pose.fog, false);
});

test('coverage counts opaque radar pixels that carry a rendered material ID', () => {
  const radar = new PNG({ width: 6, height: 3 }),
    render = new PNG({ width: 12, height: 6 });
  // Radar: a transparent border around three playable pixels and one transparent pixel.
  [255, 255, 255, 0].forEach((alpha, x) => radar.data.set([90, 90, 90, alpha], (6 + x + 1) * 4));
  // Render at twice the size: material IDs over the first two playable pixels and the background.
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 12; x++)
      render.data.set([1, 0, [2, 3, 4, 5, 8, 9].includes(x) ? 255 : 0, 255], (y * 12 + x) * 4);
  const result = radarCoverage(radar, render);
  assert.deepEqual([result.playable, result.covered, result.percent], [3, 2, 66.67]);
});

test('an opaque radar backdrop taken from its border is not playable', () => {
  const radar = new PNG({ width: 8, height: 8 }),
    render = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < 64; i++) {
    const inside = i % 8 >= 2 && i % 8 < 6 && Math.floor(i / 8) >= 2 && Math.floor(i / 8) < 6;
    radar.data.set(inside ? [120, 120, 120, 255] : [20, 30, 40, 255], i * 4);
    render.data.set([1, 0, inside && i % 2 ? 255 : 0, 255], i * 4);
  }
  const result = radarCoverage(radar, render);
  assert.deepEqual([result.playable, result.covered], [16, 8]);
});
