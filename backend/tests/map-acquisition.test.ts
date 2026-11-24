import { test } from 'node:test';
import { mapPreparerRevision } from '../src/asset-preparer.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  linkSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeReplay, validateReplayArtifacts } from '../src/replay.js';
import type { Playback } from '../../shared/playback.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoReader } from 'cs2parser';
import type { ApprovedMapEntry, MapCatalog } from '../../shared/map-acquisition.js';
import { recordedMapIdentity, observeMapIdentity } from '../src/map-identity.js';
import {
  readMapCatalog,
  resolveMap,
  mapPackId,
  canonicalMapApproval,
  mapCatalogLimits,
  approvedMapEntrySchema,
} from '../src/map-catalog.js';
import {
  enqueueMapRequest,
  readMapRequest,
  readMapResult,
  mapJobRequestSchema,
  mapJobResultSchema,
  mapWorkerAvailable,
  writeMapWorkerStatus,
  writeMapJobResult,
  mapJobLimits,
  prepareMapJobs,
  retryMapRequest,
  canRetryMapResult,
  mapJobRetrySeconds,
  mapJobTemporaryName,
  cleanupMapRequestTemps,
} from '../src/map-jobs.js';
const approval: ApprovedMapEntry = {
  identity: {
    map: 'de_mirage',
    buildNum: 9842,
    patchVersion: 13984,
    demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
    addonPresence: 'none',
  },
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: '6678473446694075055',
    mapSha256: 'a'.repeat(64),
  },
};
const catalog: MapCatalog = { schemaVersion: 1, entries: [approval] };
const header = {
  map_name: 'de_mirage',
  build_num: 9842,
  patch_version: 13984,
  demo_version_guid: approval.identity.demoVersionGuid,
  addons: '',
};
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-map-jobs-'));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('recorded map identity retains raw bounded fields without protocol/path/Steam build inference', () => {
  assert.deepEqual(recordedMapIdentity(header), approval.identity);
  assert.deepEqual(
    recordedMapIdentity({
      ...header,
      build_num: '9842',
      patch_version: null,
      demo_version_guid: 'bad',
      addons: undefined,
    }),
    { map: 'de_mirage' },
  );
  assert.equal(recordedMapIdentity({ ...header, map_name: '../../de_mirage' }), undefined);
  assert.equal(
    recordedMapIdentity({ ...header, addons: ' '.repeat(4097) })?.addonPresence,
    'present',
  );
  assert.equal(recordedMapIdentity({ ...header, build_num: 2147483648 })?.buildNum, undefined);
});
test('header and ServerInfo conflicts fail closed while explicit network addon absence remains recorded evidence', () => {
  const reader = new EventEmitter(),
    finish = observeMapIdentity(reader as unknown as Pick<DemoReader, 'on'>);
  reader.emit('header', { ...header, addons: undefined });
  reader.emit('serverinfo', { map_name: 'de_mirage', protocol: 13984, addon_name: '' });
  assert.deepEqual(finish(), approval.identity);
  reader.emit('serverinfo', { map_name: 'de_dust2', protocol: 13984, addon_name: '' });
  assert.equal(finish()?.conflicted, true);
  assert.deepEqual(resolveMap(finish(), catalog), { status: 'unknown' });
  const workshop = new EventEmitter(),
    end = observeMapIdentity(workshop as unknown as Pick<DemoReader, 'on'>);
  workshop.emit('header', header);
  workshop.emit('serverinfo', { addon_name: '123456' });
  assert.equal(end()?.conflicted, true);
});
test('full identity catalog is provenance-bound, distinct source manifests are ambiguous, exact duplicate rows deduplicate', () => {
  assert.equal(resolveMap(approval.identity, catalog).status, 'approved');
  const training = { ...approval, identity: { ...approval.identity, map: 'training1' } };
  assert.equal(
    resolveMap(training.identity, { schemaVersion: 1, entries: [training] }).status,
    'approved',
  );
  for (const field of ['buildNum', 'patchVersion', 'demoVersionGuid', 'addonPresence'] as const) {
    const partial = { ...approval.identity };
    delete partial[field];
    assert.equal(resolveMap(partial, catalog).status, 'unknown');
  }
  assert.equal(
    resolveMap({ ...approval.identity, addonPresence: 'present' }, catalog).status,
    'addon',
  );
  assert.equal(resolveMap({ ...approval.identity, buildNum: 9843 }, catalog).status, 'unmapped');
  assert.equal(
    resolveMap(approval.identity, {
      schemaVersion: 1,
      entries: [approval, JSON.parse(JSON.stringify(approval))],
    }).status,
    'approved',
  );
  const another = { ...approval, source: { ...approval.source, manifest: '123' } };
  assert.equal(
    resolveMap(approval.identity, { schemaVersion: 1, entries: [approval, another] }).status,
    'ambiguous',
  );
  assert.notEqual(mapPackId(approval), mapPackId(another));
  assert.notEqual(
    mapPackId(approval),
    mapPackId({ ...approval, assetVersion: 'alternate-export' }),
  );
  assert.equal(
    canonicalMapApproval(approval),
    canonicalMapApproval(JSON.parse(JSON.stringify(approval))),
  );
  assert.equal(
    approvedMapEntrySchema.safeParse({
      ...approval,
      source: { ...approval.source, url: 'https://example.org' },
    }).success,
    false,
  );
  assert.equal(
    approvedMapEntrySchema.safeParse({
      ...approval,
      source: { ...approval.source, manifest: '18446744073709551616' },
    }).success,
    false,
  );
});
test('a new map preparer queues the current source without changing the earlier job files', async () => {
  const f = directory();
  try {
    await prepareMapJobs(f.root);
    const priorId = createHash('sha256')
      .update('preparer:3:')
      .update(canonicalMapApproval(approval))
      .digest('hex');
    const currentId = mapPackId(approval);
    assert.notEqual(currentId, priorId);
    const requestPath = join(f.root, 'requests', priorId + '.json');
    const request = JSON.stringify({
      schemaVersion: 3,
      packId: priorId,
      generation: '0'.repeat(32),
      approval,
    });
    writeFileSync(requestPath, request);
    const resultPath = join(f.root, 'results', priorId + '.json');
    const result = JSON.stringify({
      schemaVersion: 3,
      packId: priorId,
      status: 'ready',
      updatedAt: 1,
    });
    writeFileSync(resultPath, result);
    assert.equal(await readMapRequest(f.root, priorId), undefined);
    assert.equal(await enqueueMapRequest(f.root, approval), 'queued');
    assert.equal((await readMapRequest(f.root, currentId))?.schemaVersion, mapPreparerRevision);
    assert.equal(readFileSync(requestPath, 'utf8'), request);
    assert.equal(readFileSync(resultPath, 'utf8'), result);
  } finally {
    f.close();
  }
});
test('operator catalog reader bounds files, rejects links/writeable/malformed catalogs and treats absent catalog as unmapped', async () => {
  const fixture = directory(),
    file = join(fixture.root, 'catalog.json');
  try {
    assert.deepEqual(await readMapCatalog(file), { schemaVersion: 1, entries: [] });
    writeFileSync(file, JSON.stringify(catalog), { mode: 0o600 });
    assert.deepEqual(await readMapCatalog(file), catalog);
    const linked = join(fixture.root, 'linked.json');
    symlinkSync(file, linked);
    assert.equal(await readMapCatalog(linked), undefined);
    const hard = join(fixture.root, 'hard.json');
    linkSync(file, hard);
    assert.equal(await readMapCatalog(file), undefined);
    rmSync(hard);
    writeFileSync(file, ' '.repeat(mapCatalogLimits.bytes + 1));
    assert.equal(await readMapCatalog(file), undefined);
    writeFileSync(file, JSON.stringify({ ...catalog, url: 'https://invalid' }));
    assert.equal(await readMapCatalog(file), undefined);
  } finally {
    fixture.close();
  }
});
test('job requests bind immutable approval hash, coalesce concurrent authorization and use bounded terminal results', async () => {
  const fixture = directory();
  try {
    const id = mapPackId(approval),
      queued = await Promise.all(
        Array.from({ length: 8 }, () => enqueueMapRequest(fixture.root, approval)),
      );
    assert.equal(queued.filter((v) => v === 'queued').length, 1);
    assert.equal(queued.filter((v) => v === 'existing').length, 7);
    const initialRequest = await readMapRequest(fixture.root, id);
    assert.match(initialRequest?.generation || '', /^[a-f0-9]{32}$/);
    assert.deepEqual(
      { ...initialRequest, generation: undefined },
      { schemaVersion: mapPreparerRevision, packId: id, approval, generation: undefined },
    );
    assert.equal(
      mapJobRequestSchema.safeParse({ schemaVersion: mapPreparerRevision, packId: id, approval })
        .success,
      false,
    );
    assert.equal(
      mapJobRequestSchema.safeParse({
        schemaVersion: mapPreparerRevision,
        packId: id,
        approval,
        generation: 'A'.repeat(32),
      }).success,
      false,
    );
    assert.equal(
      mapJobRequestSchema.safeParse({
        schemaVersion: mapPreparerRevision,
        packId: 'b'.repeat(64),
        approval,
        generation: 'a'.repeat(32),
      }).success,
      false,
    );
    assert.equal(
      mapJobResultSchema.safeParse({
        schemaVersion: mapPreparerRevision,
        packId: id,
        status: 'failed',
        updatedAt: 1,
      }).success,
      false,
    );
    assert.equal(
      mapJobResultSchema.safeParse({
        schemaVersion: mapPreparerRevision,
        packId: id,
        status: 'ready',
        updatedAt: 1,
        code: 'preparation_failed',
      }).success,
      false,
    );
    await writeMapJobResult(fixture.root, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'processing',
      updatedAt: 1,
    });
    assert.equal((await readMapResult(fixture.root, id))?.status, 'processing');
    await writeMapJobResult(fixture.root, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'failed',
      updatedAt: 2,
      code: 'source_mismatch',
    });
    assert.equal((await readMapResult(fixture.root, id))?.code, 'source_mismatch');
    assert.equal(await readMapRequest(fixture.root, '../catalog'), undefined);
    const saved = readFileSync(join(fixture.root, 'requests', id + '.json'), 'utf8');
    assert.ok(!saved.includes('demoId'));
    assert.ok(!saved.includes('owner'));
  } finally {
    fixture.close();
  }
});
test('global queue cap and no-link root/child boundaries fail closed without touching external targets', async () => {
  const fixture = directory();
  try {
    for (let i = 0; i < mapJobLimits.jobs; i++)
      assert.equal(
        await enqueueMapRequest(fixture.root, { ...approval, assetVersion: 'version' + i }),
        'queued',
      );
    assert.equal(
      await enqueueMapRequest(fixture.root, { ...approval, assetVersion: 'overflow' }),
      'full',
    );
    const outside = join(fixture.root, 'outside'),
      linked = join(fixture.root, 'linked');
    mkdirSync(outside);
    symlinkSync(outside, linked);
    await assert.rejects(() => prepareMapJobs(join(linked, 'child')));
    assert.equal(
      readFileSync(
        join(
          fixture.root,
          'requests',
          mapPackId({ ...approval, assetVersion: 'version0' }) + '.json',
        ),
        'utf8',
      ).includes('version0'),
      true,
    );
    const other = join(fixture.root, 'new');
    mkdirSync(other);
    symlinkSync(outside, join(other, 'requests'));
    await assert.rejects(() => prepareMapJobs(other));
  } finally {
    fixture.close();
  }
});
test('worker availability is an explicit bounded atomic heartbeat, never inferred from queued data', async () => {
  const fixture = directory();
  try {
    await prepareMapJobs(fixture.root);
    assert.equal(await mapWorkerAvailable(fixture.root, 1000), false);
    await writeMapWorkerStatus(fixture.root, { schemaVersion: 1, status: 'idle', updatedAt: 1000 });
    assert.equal(await mapWorkerAvailable(fixture.root, 1000), true);
    assert.equal(await mapWorkerAvailable(fixture.root, 1091), false);
    assert.equal(await mapWorkerAvailable(fixture.root, 990), false);
    const file = join(fixture.root, 'worker-status.json');
    rmSync(file);
    symlinkSync(join(fixture.root, 'requests'), file);
    assert.equal(await mapWorkerAvailable(fixture.root, 1000), false);
  } finally {
    fixture.close();
  }
});

test('global map identity is retained by bounded replay publication and rejects malformed or mismatched artifact evidence', async () => {
  const f = directory();
  try {
    const player = {
      id: '76561198000000001',
      x: 1,
      y: 2,
      z: 3,
      yaw: 0,
      pitch: 0,
      health: 100,
      team: 3,
      alive: true,
      weapon: 'ak47',
    };
    const data: Playback = {
      map: 'de_mirage',
      mapIdentity: approval.identity,
      sample: false,
      tickRate: 64,
      players: [{ id: player.id, name: 'Synthetic player', team: 3 }],
      rounds: [],
      events: [],
      frames: [
        { tick: 0, players: [player] },
        { tick: 8, players: [player] },
      ],
    };
    await writeReplay(f.root, data);
    assert.deepEqual(validateReplayArtifacts(f.root).manifest.mapIdentity, approval.identity);
    const filename = join(f.root, 'manifest.json.gz'),
      manifest = JSON.parse(gunzipSync(readFileSync(filename)).toString('utf8'));
    manifest.mapIdentity.buildNum = '9842';
    writeFileSync(filename, gzipSync(JSON.stringify(manifest)));
    assert.throws(() => validateReplayArtifacts(f.root));
    manifest.mapIdentity = { ...approval.identity, map: 'de_dust2' };
    writeFileSync(filename, gzipSync(JSON.stringify(manifest)));
    assert.throws(() => validateReplayArtifacts(f.root), /Recorded map identity/);
  } finally {
    f.close();
  }
});

test('explicit transient retries require cooldown, preserve immutable requests and reserve the same global pending capacity', async () => {
  const fixture = directory();
  try {
    const at = 10000,
      id = mapPackId(approval);
    await enqueueMapRequest(fixture.root, approval);
    const failure = {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'failed' as const,
      updatedAt: at - mapJobRetrySeconds + 1,
      code: 'source_unavailable' as const,
    };
    assert.equal(canRetryMapResult(failure, at), false);
    await writeMapJobResult(fixture.root, failure);
    assert.equal(await retryMapRequest(fixture.root, approval, at), 'ineligible');
    for (const code of ['source_mismatch', 'approval_removed'] as const) {
      const result = { ...failure, updatedAt: 0, code };
      assert.equal(canRetryMapResult(result, at), false);
      await writeMapJobResult(fixture.root, result);
      assert.equal(await retryMapRequest(fixture.root, approval, at), 'ineligible');
    }
    const eligible = { ...failure, updatedAt: at - mapJobRetrySeconds };
    await writeMapJobResult(fixture.root, eligible);
    const previousRequest = await readMapRequest(fixture.root, id);
    const requests = await Promise.all(
      Array.from({ length: 8 }, () => retryMapRequest(fixture.root, approval, at)),
    );
    assert.equal(requests.filter((status) => status === 'queued').length, 1);
    assert.equal(requests.filter((status) => status === 'ineligible').length, 7);
    assert.equal(await readMapResult(fixture.root, id), undefined);
    const renewed = await readMapRequest(fixture.root, id);
    assert.deepEqual(renewed?.approval, approval);
    assert.equal(renewed?.packId, id);
    assert.match(renewed?.generation || '', /^[a-f0-9]{32}$/);
    assert.notEqual(renewed?.generation, previousRequest?.generation);
    await writeMapJobResult(fixture.root, eligible);
    for (let i = 0; i < mapJobLimits.jobs; i++)
      assert.equal(
        await enqueueMapRequest(fixture.root, { ...approval, assetVersion: 'retry-cap-' + i }),
        'queued',
      );
    assert.equal(await retryMapRequest(fixture.root, approval, at), 'full');
    assert.deepEqual(await readMapResult(fixture.root, id), eligible);
  } finally {
    fixture.close();
  }
});

test('a retry whose caller revokes publication leaves the request generation and failure intact', async () => {
  const f = directory();
  try {
    const id = mapPackId(approval);
    await enqueueMapRequest(f.root, approval);
    const request = await readMapRequest(f.root, id);
    const at = 10000;
    const failure = {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'failed' as const,
      updatedAt: at - 301,
      code: 'worker_interrupted' as const,
    };
    await writeMapJobResult(f.root, failure);
    const changed = Error('The caller withdrew its authorization');
    await assert.rejects(
      retryMapRequest(f.root, approval, at, {
        publish: () => {
          throw changed;
        },
      }),
      changed,
    );
    assert.deepEqual(await readMapRequest(f.root, id), request);
    assert.deepEqual(await readMapResult(f.root, id), failure);
  } finally {
    f.close();
  }
});

test('failed retry removal preserves the terminal result after safely publishing a fresh immutable request generation', async () => {
  const f = directory();
  try {
    await enqueueMapRequest(f.root, approval);
    const id = mapPackId(approval),
      previous = await readMapRequest(f.root, id),
      at = 10000;
    const failure = {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'failed' as const,
      updatedAt: at - 301,
      code: 'worker_interrupted' as const,
    };
    await writeMapJobResult(f.root, failure);
    let removals = 0;
    const status = await retryMapRequest(f.root, approval, at, {
      removeResult: (path) => {
        removals++;
        assert.ok(path.endsWith('/' + id + '.json'));
        const current = JSON.parse(readFileSync(join(f.root, 'requests', id + '.json'), 'utf8'));
        assert.notEqual(current.generation, previous?.generation);
        assert.deepEqual(current.approval, approval);
        assert.equal(current.packId, id);
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), failure);
        throw Object.assign(new Error('Synthetic removal denied'), { code: 'EACCES' });
      },
    });
    assert.equal(status, 'ineligible');
    assert.equal(removals, 1);
    assert.deepEqual(await readMapResult(f.root, id), failure);
    const blocked = await readMapRequest(f.root, id);
    assert.equal(await retryMapRequest(f.root, approval, at), 'queued');
    const retried = await readMapRequest(f.root, id);
    assert.notEqual(retried?.generation, blocked?.generation);
    assert.deepEqual(retried?.approval, approval);
    assert.equal(retried?.packId, id);
  } finally {
    f.close();
  }
});

test('atomic request temporaries do not block queue reservation and single-web startup cleans only exact safe orphans', async () => {
  const f = directory();
  try {
    await prepareMapJobs(f.root);
    const filename = '.' + 'a'.repeat(64) + '-' + 'b'.repeat(24) + '.tmp',
      requests = join(f.root, 'requests');
    assert.equal(mapJobTemporaryName.test(filename), true);
    assert.equal(mapJobTemporaryName.test(filename + '.json'), false);
    const orphan = join(requests, filename);
    writeFileSync(orphan, 'partial');
    assert.equal(await enqueueMapRequest(f.root, approval), 'queued');
    const unknown = join(requests, 'operator-note.txt');
    writeFileSync(unknown, 'preserved');
    const hard = join(requests, '.' + 'c'.repeat(64) + '-' + 'd'.repeat(24) + '.tmp');
    linkSync(unknown, hard);
    const linked = join(requests, '.' + 'e'.repeat(64) + '-' + 'f'.repeat(24) + '.tmp');
    symlinkSync(unknown, linked);
    const writable = join(requests, '.' + '1'.repeat(64) + '-' + '2'.repeat(24) + '.tmp');
    writeFileSync(writable, 'not-private');
    chmodSync(writable, 0o666);
    assert.equal(await cleanupMapRequestTemps(f.root), 1);
    assert.equal(existsSync(orphan), false);
    assert.equal(readFileSync(unknown, 'utf8'), 'preserved');
    assert.equal(existsSync(hard), true);
    assert.equal(existsSync(linked), true);
    assert.equal(existsSync(writable), true);
    assert.deepEqual((await readMapRequest(f.root, mapPackId(approval)))?.approval, approval);
    const alias = join(f.root, 'alias');
    symlinkSync(f.root, alias);
    await assert.rejects(() => cleanupMapRequestTemps(join(alias, 'requests')));
  } finally {
    f.close();
  }
});
test('request scans count ignored temporaries and preserve the fixed global scan bound before adding a new file', async () => {
  const f = directory();
  try {
    await prepareMapJobs(f.root);
    for (let i = 0; i < mapJobLimits.scanned; i++)
      writeFileSync(
        join(
          f.root,
          'requests',
          '.' + i.toString(16).padStart(64, '0') + '-' + 'a'.repeat(24) + '.tmp',
        ),
        '',
      );
    assert.equal(await enqueueMapRequest(f.root, approval), 'full');
    assert.equal(await cleanupMapRequestTemps(f.root), mapJobLimits.scanned);
    assert.equal(await enqueueMapRequest(f.root, approval), 'queued');
  } finally {
    f.close();
  }
});
