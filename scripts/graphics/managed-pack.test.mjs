import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapPreparerRevision, preparerRevision } from '../../backend/dist/asset-preparer.js';
import {
  latestMapPackId,
  latestMapRequestId,
  latestOfficialSelection,
  mapPackId,
  canonicalMapApproval,
  readMapCatalog,
} from '../../backend/dist/map-catalog.js';
import {
  enqueueLatestMapRequest,
  enqueueMapRequest,
  readMapRequest,
  readMapResult,
  readOfficialMapInventory,
  writeMapJobResult,
  writeOfficialMapInventory,
} from '../../backend/dist/map-jobs.js';
import { readManagedPack, snapshotManagedPack } from './managed-pack.mjs';

test('snapshot only the selected ready generation, source and promotion records; block removals and source changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-managed-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, 'assets'),
    jobs = join(root, 'jobs'),
    catalogFile = join(root, 'catalog.json'),
    map = 'de_fixture',
    at = Math.floor(Date.now() / 1000);
  const identity = {
    map,
    buildNum: 123,
    patchVersion: 456,
    demoVersionGuid: '12345678-1234-1234-1234-123456789012',
    addonPresence: 'none',
  };
  const src = (manifest, hash) => ({
    appId: 730,
    depotId: 2347770,
    manifest,
    mapSha256: hash.repeat(64),
  });
  const source = src('123', 'a'),
    approval = { identity, source: src('101', 'b') };
  const inventory = {
    schemaVersion: 1,
    appId: 730,
    depotId: 2347770,
    updatedAt: at - 86400 * 10,
    manifest: source.manifest,
    maps: [
      { map, sha1: '1'.repeat(40), bytes: 1200 },
      { map: 'de_unrelated', sha1: '2'.repeat(40), bytes: 200 },
    ],
  };
  const json = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await writeOfficialMapInventory(jobs, inventory);
  const selection = latestOfficialSelection(inventory, map),
    latestId = latestMapRequestId(selection),
    packId = latestMapPackId(map, source),
    exactId = mapPackId(approval);
  await enqueueLatestMapRequest(jobs, selection);
  const latestResult = {
    schemaVersion: mapPreparerRevision,
    packId: latestId,
    status: 'ready',
    updatedAt: at,
    assetPackId: packId,
    source,
    sourceCheckedAt: at,
  };
  await writeMapJobResult(jobs, latestResult);
  const markerPath = join(assets, 'packs', packId, 'pack.json');
  await mkdir(join(assets, 'packs', packId), { recursive: true });
  const marker = {
    schemaVersion: mapPreparerRevision,
    kind: 'latest-official',
    packId,
    requestId: latestId,
    selection,
    source,
    preparedAt: at,
  };
  await json(markerPath, marker);
  const sentinel = join(jobs, 'requests', '.' + 'c'.repeat(64) + '-' + 'a'.repeat(24) + '.tmp');
  await writeFile(sentinel, 'operator temporary file');
  const input = { jobs, assets, map, identity };
  const latest = await readManagedPack(input);
  assert.equal(latest.verification, 'latest-official');
  assert.deepEqual(latest.source, source);
  const scratch = (suffix) => ({
    mapJobsDir: join(root, 'scratch' + suffix),
    mapCatalogFile: join(root, 'catalog' + suffix + '.json'),
  });
  const status = { schemaVersion: preparerRevision, categories: {} };
  await json(join(jobs, 'presentation-status-v' + preparerRevision + '.json'), status);
  const first = scratch('1');
  await snapshotManagedPack(latest, jobs, first);
  assert.deepEqual(
    (await readOfficialMapInventory(first.mapJobsDir, at, { allowStale: true })).maps,
    [inventory.maps[0]],
  );
  assert.deepEqual(await readMapResult(first.mapJobsDir, latestId), latestResult);
  assert.deepEqual(await readdir(join(first.mapJobsDir, 'requests')), [latestId + '.json']);
  assert.deepEqual(
    JSON.parse(
      await readFile(join(first.mapJobsDir, 'presentation-status-v' + preparerRevision + '.json')),
    ),
    status,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'operator temporary file');
  await assert.rejects(
    readManagedPack({ ...input, identity: { ...identity, addonPresence: 'present' } }),
  );
  await json(markerPath, { ...marker, source: approval.source });
  await assert.rejects(readManagedPack(input), /marker/);
  await json(markerPath, marker);

  await json(catalogFile, {
    schemaVersion: 1,
    entries: [approval, { ...approval, identity: { ...identity, map: 'de_unused' } }],
  });
  await enqueueMapRequest(jobs, approval);
  const result = {
    schemaVersion: mapPreparerRevision,
    packId: exactId,
    status: 'ready',
    updatedAt: at,
  };
  await writeMapJobResult(jobs, result);
  await mkdir(join(assets, 'packs', exactId));
  await json(join(assets, 'packs', exactId, 'pack.json'), {
    schemaVersion: mapPreparerRevision,
    packId: exactId,
    approval: canonicalMapApproval(approval),
    preparedAt: at,
  });
  const exact = await readManagedPack({ ...input, catalogFile });
  assert.equal(exact.verification, 'operator-approved');
  assert.deepEqual(exact.source, approval.source);
  const second = scratch('2');
  await snapshotManagedPack(exact, jobs, second);
  assert.deepEqual((await readMapCatalog(second.mapCatalogFile)).entries, [approval]);
  assert.deepEqual(await readdir(join(second.mapJobsDir, 'results')), [exactId + '.json']);
  await writeMapJobResult(jobs, { ...result, status: 'failed', code: 'source_unavailable' });
  const fallback = await readManagedPack({ ...input, catalogFile }),
    third = scratch('3');
  assert.equal(fallback.marker.packId, packId);
  await snapshotManagedPack(fallback, jobs, third);
  assert.equal((await readMapResult(third.mapJobsDir, exactId)).code, 'source_unavailable');
  const removal = {
    schemaVersion: 1,
    packId,
    requestId: latestId,
    generation: (await readMapRequest(jobs, latestId)).generation,
    removalId: 'a'.repeat(32),
    map,
    manifest: source.manifest,
    preparedAt: at,
    markerSha256: latest.marker.version,
    requestedAt: at,
  };
  await json(join(jobs, 'removals', packId + '.json'), removal);
  await assert.rejects(readManagedPack(input), /removal/);
  await json(join(jobs, 'removal-results', packId + '.json'), {
    schemaVersion: 1,
    packId,
    removalId: removal.removalId,
    status: 'removed',
    updatedAt: at,
  });
  await assert.rejects(readManagedPack(input), /removal/);
});
