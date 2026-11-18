import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDemoMapAssets,
  mapAcquisitionMessage,
  readMapJSON,
} from '../../frontend/src/demo-map-assets.js';
const map = 'de_qa',
  pack = 'a'.repeat(64),
  empty = { model: null, mobile: null, overview: null, environment: null };
const pending = {
  resolution: { status: 'approved', packId: pack },
  canAcquire: true,
  acquisition: 'unavailable',
  verification: 'unavailable',
  packId: pack,
  assets: empty,
};
const full = {
  model: `/api/map-packs/${pack}/models/${map}/desktop/scene.glb`,
  mobile: `/api/map-packs/${pack}/models/${map}/mobile/scene.glb`,
  overview: {
    image: `/api/map-packs/${pack}/maps/${map}/overview.png`,
    origin: { x: -3230, y: 1713 },
    scale: 5,
    referenceSize: 1024,
    assetVersion: 'original-qa',
  },
  environment: {
    assetVersion: 'original-qa',
    landscape: false,
    sky: {
      faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
        (face) => `/api/map-packs/${pack}/maps/${map}/environment/${face}.png`,
      ),
      brightness: 1,
    },
  },
};
test('demo discovery accepts only matching immutable complete packs and explicit manual provenance', () => {
  assert.equal(validateDemoMapAssets(pending, map).acquisition?.canAcquire, true);
  const ready = {
    ...pending,
    canAcquire: false,
    acquisition: 'ready',
    verification: 'operator-approved',
    assets: full,
  };
  assert.equal(validateDemoMapAssets(ready, map).assets.model, full.model);
  for (const assets of [
    { ...full, model: '/map-assets/de_qa/desktop/scene.glb' },
    {
      ...full,
      overview: { ...full.overview, image: full.overview.image.replace(pack, 'b'.repeat(64)) },
    },
    { ...full, mobile: null },
  ])
    assert.throws(() => validateDemoMapAssets({ ...ready, assets }, map));
  assert.throws(() => validateDemoMapAssets({ ...ready, packId: 'b'.repeat(64) }, map));
  assert.throws(() => validateDemoMapAssets({ ...pending, assets: full }, map));
  const manual = validateDemoMapAssets(
    {
      ...pending,
      resolution: { status: 'unknown' },
      canAcquire: false,
      acquisition: 'disabled',
      verification: 'version-unverified',
      packId: null,
      assets: { ...empty, model: '/map-assets/de_qa/desktop/scene.glb' },
    },
    map,
  );
  assert.equal(manual.acquisition?.verification, 'version-unverified');
  assert.equal(mapAcquisitionMessage(manual), undefined);
});
test('missing identity, failed jobs, queued jobs and disabled policy produce distinct truthful status', () => {
  const unknown = validateDemoMapAssets(
    { ...pending, resolution: { status: 'unknown' }, canAcquire: false, packId: null },
    map,
  );
  assert.match(mapAcquisitionMessage(unknown)!.description, /identity evidence/);
  const queued = validateDemoMapAssets(
    { ...pending, canAcquire: false, acquisition: 'queued' },
    map,
  );
  assert.equal(queued.status, 'pending');
  assert.equal(mapAcquisitionMessage(queued)!.title, 'Map preparation queued');
  assert.equal(
    mapAcquisitionMessage({ ...queued, pollingEnded: true })!.title,
    'Map preparation is still pending',
  );
  assert.equal(
    mapAcquisitionMessage(
      validateDemoMapAssets(
        { ...pending, canAcquire: false, acquisition: 'failed', code: 'source_mismatch' },
        map,
      ),
    )!.title,
    'Map preparation failed',
  );
  for (const change of [
    { canAcquire: true, resolution: { status: 'unknown' } },
    { acquisition: 'fetching' },
    { code: 'raw_native_failure' },
    { verification: 'trusted' },
    { packId: '../escape' },
  ])
    assert.throws(() => validateDemoMapAssets({ ...pending, ...change }, map));
});
test('map response parser bounds streaming UTF-8 before JSON parsing', async () => {
  assert.deepEqual(await readMapJSON(new Response('{"okay":true}'), 32), { okay: true });
  await assert.rejects(() => readMapJSON(new Response('x'.repeat(33)), 32));
  await assert.rejects(() => readMapJSON(new Response(new Uint8Array([255])), 32));
});

test('failed eligibility is accepted only for bounded transient retry codes, never permanent source mismatch', () => {
  for (const code of [
    'source_unavailable',
    'storage_limit',
    'preparation_failed',
    'worker_interrupted',
  ])
    assert.equal(
      validateDemoMapAssets({ ...pending, acquisition: 'failed', code }, map).acquisition
        ?.canAcquire,
      true,
    );
  for (const code of ['source_mismatch', 'approval_removed', undefined])
    assert.throws(() => validateDemoMapAssets({ ...pending, acquisition: 'failed', code }, map));
});
