import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUtilityZones, projectilesAt } from '../../frontend/src/utility-state.js';

test('recorded projectile exists at its first sample and interpolates without requiring a trail', () => {
  const paths = [
    {
      id: 'flight',
      kind: 'smoke',
      points: [
        { tick: 64, x: 0, y: 10, z: 20 },
        { tick: 68, x: 8, y: 14, z: 12 },
      ],
    },
  ];
  assert.deepEqual(projectilesAt(paths, 64, 64)[0].point, paths[0].points[0]);
  assert.deepEqual(projectilesAt(paths, 66, 64)[0].point, { tick: 66, x: 4, y: 12, z: 16 });
  assert.equal(projectilesAt(paths, 64, 64)[0].trail.length, 1);
  assert.equal(projectilesAt(paths, 63, 64).length, 0);
  assert.equal(projectilesAt(paths, 69, 64).length, 0);
});

test('single and chunk-adjacent samples remain seek-safe, with bounded trail context', () => {
  const paths = [
    {
      id: 'flight',
      kind: 'he',
      points: [0, 64, 128, 192, 256].map((tick) => ({ tick, x: tick, y: 0, z: 10 })),
    },
  ];
  assert.deepEqual(
    projectilesAt(paths, 256, 64)[0].trail.map((point) => point.tick),
    [192, 256],
  );
  const left = [{ ...paths[0], points: paths[0].points.slice(0, 4) }];
  const right = [{ ...paths[0], points: paths[0].points.slice(1) }];
  assert.deepEqual(projectilesAt(left, 160, 64)[0].point, projectilesAt(right, 160, 64)[0].point);
  assert.equal(
    projectilesAt([{ id: 'single', kind: 'flash', points: [paths[0].points[0]] }], 0, 64).length,
    1,
  );
  assert.equal(projectilesAt([], 0, 64).length, 0);
});

test('analytical effects use only bounded recorded positions and preserve actual event timing', () => {
  const zones = buildUtilityZones(
    [
      { type: 'smokegrenade_detonate', tick: 640, x: 100, y: 200, z: 8 },
      { type: 'inferno_startburn', tick: 650, x: 110, y: 210, z: 8 },
      { type: 'flashbang_detonate', tick: 660, x: 120, y: 220, z: 90 },
      { type: 'hegrenade_detonate', tick: 670, x: 130, y: 230, z: 40 },
      { type: 'smokegrenade_detonate', tick: 680 },
      { type: 'inferno_startburn', tick: 690, x: Infinity, y: 0, z: 0 },
      { type: 'hegrenade_detonate', tick: 700, x: 1e20, y: 0, z: 0 },
    ],
    64,
  );
  assert.deepEqual(
    zones.map((zone) => [zone.kind, zone.start, zone.x, zone.y, zone.z]),
    [
      ['smoke', 640, 100, 200, 8],
      ['fire', 650, 110, 210, 8],
      ['flash', 660, 120, 220, 90],
      ['he', 670, 130, 230, 40],
    ],
  );
  assert.equal(zones[0].end, 640 + 18 * 64);
});
