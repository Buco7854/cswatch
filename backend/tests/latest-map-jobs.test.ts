import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  chmodSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  officialMapInventorySchema,
  latestOfficialSelection,
  latestMapRequestId,
  latestMapPackId,
  latestMapPackMarkerSchema,
  officialMapInventoryLimits,
} from '../src/map-catalog.js';
import {
  readOfficialMapInventory,
  writeOfficialMapInventory,
  enqueueLatestMapRequest,
  readMapRequest,
  readMapResult,
  retryLatestMapRequest,
  writeMapJobResult,
  mapJobRequestSchema,
  mapJobResultSchema,
  latestMapResultMatches,
  prepareMapJobs,
} from '../src/map-jobs.js';
import type { OfficialMapInventory } from '../../shared/map-acquisition.js';
const at = 1800000000;
const inventory: OfficialMapInventory = {
  schemaVersion: 1,
  appId: 730,
  depotId: 2347770,
  manifest: '18014398509481985',
  updatedAt: at,
  maps: [{ map: 'de_new_official_fixture', sha1: 'a'.repeat(40), bytes: 12345 }],
};
const selection = latestOfficialSelection(inventory, inventory.maps[0].map)!;
const source = {
  appId: 730 as const,
  depotId: 2347770 as const,
  manifest: selection.manifest,
  mapSha256: 'b'.repeat(64),
};
const queueId = latestMapRequestId(selection),
  assetId = latestMapPackId(selection.map, source);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-latest-jobs-'));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('official inventory accepts newly shipped bare names without code registration and rejects duplicate/unsafe/malformed sources', () => {
  assert.equal(officialMapInventorySchema.safeParse(inventory).success, true);
  for (const bad of [
    { ...inventory, maps: [inventory.maps[0], inventory.maps[0]] },
    { ...inventory, appId: 999 },
    { ...inventory, maps: [{ ...inventory.maps[0], map: 'workshop/123/file' }] },
    { ...inventory, maps: [{ ...inventory.maps[0], sha1: 'b'.repeat(64) }] },
    { ...inventory, maps: [{ ...inventory.maps[0], bytes: 2 ** 32 }] },
    { ...inventory, url: 'https://invalid.test' },
  ])
    assert.equal(officialMapInventorySchema.safeParse(bad).success, false);
  assert.equal(latestOfficialSelection(inventory, 'de_user_uploaded_name'), undefined);
  assert.equal(
    latestMapRequestId({ ...selection, manifest: '18014398509481986' }) === queueId,
    false,
  );
  assert.equal(latestMapRequestId({ ...selection, sha1: 'c'.repeat(40) }) === queueId, false);
  assert.notEqual(queueId, assetId);
});

test('inventory storage enforces freshness, ownership modes, no-follow paths and independent byte bounds', async () => {
  const f = fixture();
  try {
    await writeOfficialMapInventory(f.root, inventory);
    assert.deepEqual(await readOfficialMapInventory(f.root, at), inventory);
    assert.equal(
      await readOfficialMapInventory(f.root, at + officialMapInventoryLimits.maxAgeSeconds + 1),
      undefined,
    );
    assert.deepEqual(
      await readOfficialMapInventory(f.root, at + officialMapInventoryLimits.maxAgeSeconds + 1, {
        allowStale: true,
      }),
      inventory,
    );
    assert.equal(await readOfficialMapInventory(f.root, at - 301), undefined);
    const file = join(f.root, 'official-inventory.json');
    chmodSync(file, 0o666);
    assert.equal(await readOfficialMapInventory(f.root, at), undefined);
    chmodSync(file, 0o640);
    const external = join(f.root, 'original.json');
    writeFileSync(external, JSON.stringify(inventory), { mode: 0o600 });
    rmSync(file);
    symlinkSync(external, file);
    assert.equal(await readOfficialMapInventory(f.root, at), undefined);
    await assert.rejects(writeOfficialMapInventory(f.root, inventory));
    assert.equal(readFileSync(external, 'utf8'), JSON.stringify(inventory));
    rmSync(file);
    linkSync(external, file);
    assert.equal(await readOfficialMapInventory(f.root, at), undefined);
    rmSync(file);
    writeFileSync(file, Buffer.alloc(officialMapInventoryLimits.bytes + 1, 32));
    assert.equal(await readOfficialMapInventory(f.root, at), undefined);
    const alias = join(f.root, 'alias');
    symlinkSync(f.root, alias);
    assert.equal(await readOfficialMapInventory(alias, at), undefined);
  } finally {
    f.close();
  }
});

test('latest queue deduplicates a pinned selection, preserves string IDs and uses explicit generation-aware retry', async () => {
  const f = fixture();
  try {
    assert.deepEqual(
      await Promise.all([
        enqueueLatestMapRequest(f.root, selection),
        enqueueLatestMapRequest(f.root, selection),
      ]),
      ['queued', 'existing'],
    );
    const first = await readMapRequest(f.root, queueId);
    assert.equal(first?.kind, 'latest-official');
    assert.equal(first?.approval, undefined);
    if (first?.kind !== 'latest-official') throw Error('Missing latest request');
    assert.deepEqual(first.selection, selection);
    await writeMapJobResult(f.root, {
      schemaVersion: 3,
      packId: queueId,
      status: 'failed',
      code: 'source_unavailable',
      updatedAt: at,
    });
    assert.equal(await retryLatestMapRequest(f.root, selection, at + 299), 'ineligible');
    assert.equal(await retryLatestMapRequest(f.root, selection, at + 300), 'queued');
    assert.equal(await readMapResult(f.root, queueId), undefined);
    assert.notEqual((await readMapRequest(f.root, queueId))?.generation, first.generation);
  } finally {
    f.close();
  }
});

test('latest publication identity requires pinned membership selection and complete post-download source proof', () => {
  const request = {
    schemaVersion: 3 as const,
    kind: 'latest-official' as const,
    packId: queueId,
    generation: 'a'.repeat(32),
    selection,
  };
  assert.equal(mapJobRequestSchema.safeParse(request).success, true);
  assert.equal(
    mapJobRequestSchema.safeParse({ ...request, selection: { ...selection, manifest: '2' } })
      .success,
    false,
  );
  assert.equal(mapJobRequestSchema.safeParse({ ...request, approval: {} }).success, false);
  const result = {
    schemaVersion: 3 as const,
    packId: queueId,
    status: 'ready' as const,
    updatedAt: at,
    assetPackId: assetId,
    source,
    sourceCheckedAt: at,
  };
  assert.equal(mapJobResultSchema.safeParse(result).success, true);
  assert.equal(latestMapResultMatches(request, result), true);
  assert.equal(mapJobResultSchema.safeParse({ ...result, source: undefined }).success, false);
  assert.equal(
    latestMapResultMatches(request, { ...result, source: { ...source, manifest: '2' } }),
    false,
  );
  assert.equal(latestMapResultMatches(request, { ...result, assetPackId: 'f'.repeat(64) }), false);
  const marker = {
    schemaVersion: 3,
    kind: 'latest-official',
    packId: assetId,
    requestId: queueId,
    selection,
    source,
    preparedAt: at,
  };
  assert.equal(latestMapPackMarkerSchema.safeParse(marker).success, true);
  assert.equal(
    latestMapPackMarkerSchema.safeParse({ ...marker, requestId: assetId }).success,
    false,
  );
  assert.equal(
    latestMapPackMarkerSchema.safeParse({
      ...marker,
      source: { ...source, mapSha256: 'c'.repeat(64) },
    }).success,
    false,
  );
});

test('explicit latest retry preserves verified content proof after publishing a fresh generation', async () => {
  const f = fixture();
  try {
    await enqueueLatestMapRequest(f.root, selection);
    const previous = await readMapRequest(f.root, queueId);
    await writeMapJobResult(f.root, {
      schemaVersion: 3,
      packId: queueId,
      status: 'failed',
      code: 'worker_interrupted',
      updatedAt: at,
      assetPackId: assetId,
      source,
      sourceCheckedAt: at,
    });
    let removed = false;
    assert.equal(
      await retryLatestMapRequest(f.root, selection, at + 300, {
        removeResult: async () => {
          removed = true;
          throw Error('Verified recovery proof must not be deleted');
        },
      }),
      'queued',
    );
    assert.equal(removed, false);
    const next = await readMapRequest(f.root, queueId),
      result = await readMapResult(f.root, queueId);
    assert.notEqual(next?.generation, previous?.generation);
    assert.equal(result?.status, 'processing');
    assert.equal(result?.code, undefined);
    assert.equal(result?.assetPackId, assetId);
    assert.deepEqual(result?.source, source);
    assert.equal(result?.sourceCheckedAt, at);
    assert.equal(latestMapResultMatches(next!, result!), true);
  } finally {
    f.close();
  }
});
