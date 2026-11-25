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
    validateMapAssets({ model, mobile: null, overview }, map, undefined, 'demo-1').overview,
    overview,
  );
  assert.equal(validateMapAssets({ model, mobile: null }, map, undefined, 'demo-1').model, model);
  assert.deepEqual(validateMapAssets({ model: null, mobile: null }, map), {
    model: null,
    mobile: null,
    overview: null,
    environment: null,
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
    assert.throws(() => validateMapAssets({ model: null, mobile: null, overview: invalid }, map));
  for (const [value, demo] of [
    ['https://outside.invalid/map.json', 'demo-1'],
    [model, undefined],
    [model, 'demo-2'],
    [`/api/demos/demo-1/world/${'a'.repeat(64)}/${hash}/map.json`, 'demo-1'],
    [`/api/demos/demo-1/world/manual/${hash}/../map.json`, 'demo-1'],
    [`/api/demos/demo-1/world/manual/${hash}/${hash}.bin`, 'demo-1'],
  ] as const)
    assert.throws(() =>
      validateMapAssets({ model: value, mobile: null, overview: null }, map, undefined, demo),
    );
  assert.throws(() =>
    validateMapAssets(
      { model: null, mobile: `/map-assets/another/mobile/scene.glb`, overview: null },
      map,
    ),
  );
});

test('environment discovery requires six fixed local cube faces and finite recorded brightness', () => {
  const environment = {
    assetVersion: 'original-qa-sky-v1',
    landscape: false,
    sky: {
      faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
        (face) => `/api/maps/${map}/environment/${face}.png`,
      ),
      brightness: 1,
    },
  };
  assert.deepEqual(validateMapAssets({ environment }, map).environment, environment);
  for (const invalid of [
    { ...environment, assetVersion: '' },
    { ...environment, landscape: 'yes' },
    { ...environment, sky: { ...environment.sky, brightness: NaN } },
    { ...environment, sky: { ...environment.sky, brightness: 17 } },
    { ...environment, sky: { ...environment.sky, brightness: -1 } },
    { ...environment, sky: { ...environment.sky, faces: environment.sky.faces.slice(0, 5) } },
    { ...environment, sky: { ...environment.sky, faces: [...environment.sky.faces].reverse() } },
    {
      ...environment,
      sky: {
        ...environment.sky,
        faces: ['https://outside.invalid/sky.png', ...environment.sky.faces.slice(1)],
      },
    },
    {
      ...environment,
      sky: {
        ...environment.sky,
        faces: environment.sky.faces.map((face) => face.replace(map, 'another_map')),
      },
    },
  ])
    assert.throws(() => validateMapAssets({ environment: invalid }, map));
});
