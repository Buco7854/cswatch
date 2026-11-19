import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDemoMapAssets,
  mapAcquisitionMessage,
  readMapJSON,
  mapAcquisitionKey,
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
  assert.throws(() =>
    validateDemoMapAssets(
      {
        ...pending,
        resolution: { status: 'unknown' },
        canAcquire: false,
        acquisition: 'disabled',
        verification: 'version-unverified',
        packId: null,
        assets: { ...empty, environment: full.environment },
      },
      map,
    ),
  );
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

test('failed eligibility is accepted only for bounded explicit retry codes, never permanent source mismatch', () => {
  for (const code of [
    'source_unavailable',
    'storage_limit',
    'preparation_failed',
    'worker_interrupted',
    'removed_by_admin',
  ])
    assert.equal(
      validateDemoMapAssets({ ...pending, acquisition: 'failed', code }, map).acquisition
        ?.canAcquire,
      true,
    );
  for (const code of ['source_mismatch', 'approval_removed', undefined])
    assert.throws(() => validateDemoMapAssets({ ...pending, acquisition: 'failed', code }, map));
});

const selection = {
  map,
  appId: 730,
  depotId: 2347770,
  manifest: '12345678901234567890',
  sha1: 'c'.repeat(40),
  bytes: 128000,
};
const latestPending = {
  ...pending,
  resolution: {
    status: 'latest',
    selection,
    inventoryUpdatedAt: 1795000000,
    source: null,
  },
  packId: null,
};
const source = {
  appId: 730,
  depotId: 2347770,
  manifest: selection.manifest,
  mapSha256: 'd'.repeat(64),
};
const latestReady = {
  ...latestPending,
  resolution: { ...latestPending.resolution, source },
  canAcquire: false,
  acquisition: 'ready',
  verification: 'latest-official',
  packId: pack,
  assets: full,
};
test('latest official selection keeps queue eligibility separate from ready content provenance', () => {
  const pendingState = validateDemoMapAssets(latestPending, map);
  assert.equal(pendingState.acquisition?.packId, null);
  assert.equal(pendingState.acquisition?.latest?.source, null);
  assert.match(mapAcquisitionMessage(pendingState)!.description, /latest official/);
  assert.equal(
    mapAcquisitionMessage({ ...pendingState, pollingEnded: true })!.title,
    'Map preparation is still pending',
  );
  assert.equal(
    mapAcquisitionMessage({ ...pendingState, pollingEnded: true, requesting: true })!.title,
    'Requesting map preparation',
  );
  const queued = validateDemoMapAssets(
    { ...latestPending, acquisition: 'queued', canAcquire: false },
    map,
  );
  assert.equal(queued.status, 'pending');
  assert.match(mapAcquisitionMessage(queued)!.description, /layout may differ/);
  const ready = validateDemoMapAssets(latestReady, map);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.acquisition?.verification, 'latest-official');
  assert.deepEqual(ready.acquisition?.latest?.source, source);
  assert.equal(ready.assets.model, full.model);
  assert.equal(mapAcquisitionMessage(ready), undefined);
  assert.equal(mapAcquisitionKey(pendingState.acquisition), mapAcquisitionKey(ready.acquisition));
  assert.notEqual(
    mapAcquisitionKey(pendingState.acquisition),
    mapAcquisitionKey(validateDemoMapAssets(pending, map).acquisition),
  );
  const refreshed = validateDemoMapAssets(
    {
      ...latestPending,
      resolution: {
        ...latestPending.resolution,
        selection: { ...selection, manifest: '12345678901234567891' },
      },
    },
    map,
  );
  assert.notEqual(
    mapAcquisitionKey(pendingState.acquisition),
    mapAcquisitionKey(refreshed.acquisition),
  );
  const unavailable = validateDemoMapAssets(
    {
      ...latestPending,
      canAcquire: false,
      acquisition: 'failed',
      code: 'source_unavailable',
    },
    map,
  );
  assert.match(mapAcquisitionMessage(unavailable)!.description, /selected official Steam source/);
});
test('latest official discovery rejects malformed selections and unrelated prepared sources', () => {
  for (const change of [
    { map: 'de_other' },
    { appId: 731 },
    { depotId: 2347771 },
    { manifest: 1234567 },
    { manifest: '012345' },
    { manifest: '18446744073709551616' },
    { sha1: 'c'.repeat(39) },
    { bytes: 0 },
    { bytes: 2 * 1024 ** 3 + 1 },
    { bytes: 1.5 },
    { url: 'https://untrusted.invalid/map.vpk' },
  ])
    assert.throws(() =>
      validateDemoMapAssets(
        {
          ...latestPending,
          resolution: { ...latestPending.resolution, selection: { ...selection, ...change } },
        },
        map,
      ),
    );
  for (const changedSource of [
    null,
    undefined,
    { ...source, appId: 731 },
    { ...source, depotId: 2347771 },
    { ...source, manifest: '12345' },
    { ...source, mapSha256: '../escape' },
    { ...source, url: 'https://untrusted.invalid' },
  ])
    assert.throws(() =>
      validateDemoMapAssets(
        { ...latestReady, resolution: { ...latestReady.resolution, source: changedSource } },
        map,
      ),
    );
  for (const inventoryUpdatedAt of [-1, 1.5, Infinity, 8640000000001])
    assert.throws(() =>
      validateDemoMapAssets(
        { ...latestPending, resolution: { ...latestPending.resolution, inventoryUpdatedAt } },
        map,
      ),
    );
});
test('latest official readiness never accepts manual URLs, incomplete assets or exact-version labeling', () => {
  for (const change of [
    { packId: null },
    { packId: 'b'.repeat(64) },
    { verification: 'operator-approved' },
    { verification: 'version-unverified' },
    { assets: { ...full, mobile: null } },
    { assets: { ...full, environment: null } },
    { assets: { ...full, model: '/map-assets/de_qa/desktop/scene.glb' } },
  ])
    assert.throws(() => validateDemoMapAssets({ ...latestReady, ...change }, map));
  assert.throws(() => validateDemoMapAssets({ ...latestPending, packId: pack }, map));
  assert.throws(() =>
    validateDemoMapAssets(
      {
        ...latestPending,
        resolution: latestReady.resolution,
        acquisition: 'processing',
        canAcquire: false,
        packId: pack,
      },
      map,
    ),
  );
});

test('operational map readiness is distinct from historical matching and cannot authorize a new source', () => {
  const empty = { model: null, mobile: null, overview: null, environment: null };
  for (const [reason, description] of [
    ['automatic_disabled', 'enable automatic'],
    ['worker_unavailable', 'assets service'],
    ['inventory_unavailable', 'official map list'],
    ['inventory_stale', 'refresh'],
    ['official_map_unknown', 'does not include'],
    ['owner_required', 'demo owner'],
    ['identity_invalid', 'conflicting or invalid'],
  ]) {
    const input = {
      resolution: { status: 'unmapped' },
      acquisition: reason === 'automatic_disabled' ? 'disabled' : 'unavailable',
      canAcquire: false,
      verification: 'unavailable',
      packId: null,
      assets: empty,
      readinessReason: reason,
    };
    const state = validateDemoMapAssets(input, map);
    assert.equal(state.acquisition?.readinessReason, reason);
    assert.match(mapAcquisitionMessage(state)!.description, new RegExp(description));
    assert.doesNotMatch(
      mapAcquisitionMessage(state)!.description,
      /operator-approved map version matches/,
    );
    assert.throws(() => validateDemoMapAssets({ ...input, canAcquire: true }, map));
  }
  assert.throws(() =>
    validateDemoMapAssets(
      {
        resolution: { status: 'unmapped' },
        acquisition: 'unavailable',
        canAcquire: false,
        verification: 'unavailable',
        packId: null,
        assets: empty,
        readinessReason: 'unknown_private_error',
      },
      map,
    ),
  );
});
