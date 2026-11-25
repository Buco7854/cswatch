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
  const radar = new PNG({ width: 4, height: 1 }),
    render = new PNG({ width: 8, height: 2 });
  // Radar: three playable pixels and one transparent background pixel.
  [255, 255, 255, 0].forEach((alpha, x) => radar.data.set([90, 90, 90, alpha], x * 4));
  // Render at twice the size: material IDs (blue 255) over the first two radar pixels and the background.
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 8; x++)
      render.data.set([1, 0, [0, 1, 2, 3, 6, 7].includes(x) ? 255 : 0, 255], (y * 8 + x) * 4);
  const result = radarCoverage(radar, render);
  assert.deepEqual([result.playable, result.covered, result.percent], [3, 2, 66.67]);
});
