import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewPoint, overviewRadius } from '../../frontend/src/tactical-coordinates.js';
import { validateMapAssets } from '../../frontend/src/map-assets.js';

const map = 'de_original_map_qa';
const overview = {
  image: `/api/maps/${map}/overview.png`,
  origin: { x: -1024, y: 1024 },
  scale: 2,
  referenceSize: 1024 as const,
  assetVersion: 'synthetic-original-qa-not-CS2',
};
test('overview calibration maps Source corners, directions and Source-unit radii without replay-derived scaling', () => {
  assert.deepEqual(overviewPoint(overview, { x: -1024, y: 1024 }), { x: 0, y: 0 });
  assert.deepEqual(overviewPoint(overview, { x: 1024, y: -1024 }), { x: 1, y: 1 });
  assert.deepEqual(overviewPoint(overview, { x: 0, y: 0 }), { x: 0.5, y: 0.5 });
  assert.deepEqual(overviewPoint(overview, { x: -512, y: 0 }), { x: 0.25, y: 0.5 });
  assert.equal(overviewRadius(overview, 146), 146 / 2048);
  assert.deepEqual(
    overviewPoint(overview, { x: -2048, y: 0 }),
    { x: -0.5, y: 0.5 },
    'Off-map observations must not silently rescale or clamp calibration',
  );
});
test('map discovery accepts only a demo-scoped native manifest URL and bounded finite calibration', () => {
  const hash = 'b'.repeat(64),
    model = `/api/demos/demo-1/world/manual/${hash}/map.json`;
  assert.deepEqual(
    validateMapAssets({ model, overview }, map, undefined, 'demo-1').overview,
    overview,
  );
  assert.equal(validateMapAssets({ model }, map, undefined, 'demo-1').model, model);
  assert.deepEqual(validateMapAssets({ model: null }, map), {
    model: null,
    overview: null,
  });
  for (const invalid of [
    { ...overview, image: 'https://outside.invalid/map.png' },
    { ...overview, image: `/api/maps/${map}/../another/overview.png` },
    { ...overview, scale: 0 },
    { ...overview, scale: 0.00001 },
    { ...overview, scale: Infinity },
    { ...overview, origin: { x: NaN, y: 0 } },
    { ...overview, origin: { x: 0, y: 1e8 } },
    { ...overview, referenceSize: 512 },
    { ...overview, assetVersion: '' },
    { ...overview, assetVersion: 'x'.repeat(101) },
  ])
    assert.throws(() => validateMapAssets({ model: null, overview: invalid }, map));
  for (const [value, demo] of [
    ['https://outside.invalid/map.json', 'demo-1'],
    [model, undefined],
    [model, 'demo-2'],
    [`/api/demos/demo-1/world/${'a'.repeat(64)}/${hash}/map.json`, 'demo-1'],
    [`/api/demos/demo-1/world/manual/${hash}/../map.json`, 'demo-1'],
    [`/api/demos/demo-1/world/manual/${hash}/${hash}.bin`, 'demo-1'],
  ] as const)
    assert.throws(() => validateMapAssets({ model: value, overview: null }, map, undefined, demo));
  assert.throws(() =>
    validateMapAssets(
      { model: null, mobile: `/map-assets/another/mobile/scene.glb`, overview: null },
      map,
    ),
  );
});
