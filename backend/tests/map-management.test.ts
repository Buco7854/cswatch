import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ApprovedMapEntry } from '../../shared/map-acquisition.js';
import { canonicalMapApproval, mapPackId } from '../src/map-catalog.js';
import {
  canRetryMapResult,
  enqueueMapRequest,
  prepareMapJobs,
  readMapResult,
  readMapRequest,
  cleanupMapRequestTemps,
  writeMapJobResult,
  writeMapWorkerStatus,
} from '../src/map-jobs.js';
import {
  enqueueMapRemoval,
  listManagedMaps,
  readMapRemoval,
  unsettledMapRemoval,
  readMapRemovalResult,
  mapQueueIds,
  writeMapRemovalResult,
} from '../src/map-removals.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { COOKIE, digest } from '../src/security.js';
import { initializeFixture } from './fixtures/initialized.js';
import { writePresentationStatus } from '../src/presentation-assets.js';
process.env.LOG_LEVEL = 'silent';

function originalGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }).padEnd(32, ' '));
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}

const approval: ApprovedMapEntry = {
  identity: {
    map: 'de_ancient',
    buildNum: 1,
    patchVersion: 1,
    demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
    addonPresence: 'none',
  },
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: '807392217824910805',
    mapSha256: 'a'.repeat(64),
  },
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-map-management-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, 'assets'),
    jobs = join(root, 'jobs'),
    packId = mapPackId(approval);
  await prepareMapJobs(jobs);
  await enqueueMapRequest(jobs, approval);
  await writeMapJobResult(jobs, { schemaVersion: 2, packId, status: 'ready', updatedAt: now() });
  const target = join(assets, 'packs', packId);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, 'pack.json'),
    JSON.stringify({
      schemaVersion: 2,
      packId,
      approval: canonicalMapApproval(approval),
      preparedAt: now(),
    }),
  );
  return { root, assets, jobs, packId, target };
}

test('management lists only ready worker-owned immutable snapshots and binds deletion to reviewed bytes', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.assets, 'de_mirage'));
  await writeFile(join(f.assets, 'de_mirage', 'operator-note'), 'operator data');
  const [map] = await listManagedMaps(f.assets, f.jobs);
  assert.equal(map.map, 'de_ancient');
  assert.equal(map.manifest, approval.source.manifest);
  assert.equal(await enqueueMapRemoval(f.assets, f.jobs, f.packId, 'f'.repeat(64)), 'changed');
  assert.equal(await readMapRemoval(f.jobs, f.packId), undefined);
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 4 }, () => enqueueMapRemoval(f.assets, f.jobs, f.packId, map.version)),
    ),
    ['queued', 'queued', 'queued', 'queued'],
  );
  const queued = await readMapRemoval(f.jobs, f.packId);
  assert.equal(queued?.markerSha256, map.version);
  assert.equal(queued?.generation, (await readMapRequest(f.jobs, f.packId))?.generation);
  assert.equal((await listManagedMaps(f.assets, f.jobs))[0].removal, 'queued');
  assert.equal(
    await readFile(join(f.assets, 'de_mirage', 'operator-note'), 'utf8'),
    'operator data',
  );
});

test('linked or forged markers cannot create deletion authority and revoked authorization leaves no job', async (t) => {
  const f = await fixture(t),
    [map] = await listManagedMaps(f.assets, f.jobs);
  await assert.rejects(
    enqueueMapRemoval(f.assets, f.jobs, f.packId, map.version, () => {
      throw Error('Original revoked fixture authority');
    }),
    /revoked/,
  );
  assert.equal(await readMapRemoval(f.jobs, f.packId), undefined);
  const bytes = await readFile(join(f.target, 'pack.json'));
  await rm(join(f.target, 'pack.json'));
  await writeFile(join(f.root, 'outside.json'), bytes);
  await symlink(join(f.root, 'outside.json'), join(f.target, 'pack.json'));
  assert.deepEqual(await listManagedMaps(f.assets, f.jobs), []);
  assert.equal(await enqueueMapRemoval(f.assets, f.jobs, f.packId, map.version), 'changed');
  assert.deepEqual(await readFile(join(f.root, 'outside.json')), bytes);
});

test('administrator removal stays an explicit cooldown-bound retry and unsettled cleanup remains distinct', async (t) => {
  const f = await fixture(t),
    [map] = await listManagedMaps(f.assets, f.jobs);
  await enqueueMapRemoval(f.assets, f.jobs, f.packId, map.version);
  assert.equal(await unsettledMapRemoval(f.jobs, f.packId), true);
  const removed = {
    ...(await readMapResult(f.jobs, f.packId)!),
    packId: f.packId,
    schemaVersion: 1 as const,
    status: 'failed' as const,
    code: 'removed_by_admin' as const,
    updatedAt: now(),
  };
  assert.equal(canRetryMapResult(removed, removed.updatedAt + 299), false);
  assert.equal(canRetryMapResult(removed, removed.updatedAt + 300), true);
});

test('corrupt queue entries fail closed and single-web startup cleans only its own removal intent temporaries', async (t) => {
  const f = await fixture(t);
  const temporary = `.${f.packId}-${'a'.repeat(24)}.tmp`;
  await writeFile(join(f.jobs, 'removals', temporary), 'original abandoned web intent', {
    mode: 0o600,
  });
  await writeFile(
    join(f.jobs, 'removal-results', temporary),
    'original potentially live worker result',
    { mode: 0o600 },
  );
  await writeFile(join(f.jobs, 'removals', 'operator.keep'), 'operator fixture');
  await assert.rejects(mapQueueIds(f.jobs, 'removals'), /invalid/);
  assert.equal(await cleanupMapRequestTemps(f.jobs), 1);
  assert.equal(
    await readFile(join(f.jobs, 'removal-results', temporary), 'utf8'),
    'original potentially live worker result',
  );
  assert.equal(
    await readFile(join(f.jobs, 'removals', 'operator.keep'), 'utf8'),
    'operator fixture',
  );
  assert.equal(await readMapRemovalResult(f.jobs, f.packId), undefined);
});

test('new deletions and explicit failed-cleanup retries reserve the same bounded pending capacity', async (t) => {
  for (const retry of [false, true])
    await t.test(retry ? 'retry' : 'new', async (t) => {
      const f = await fixture(t),
        [map] = await listManagedMaps(f.assets, f.jobs);
      if (retry) {
        await enqueueMapRemoval(f.assets, f.jobs, f.packId, map.version);
        const removal = (await readMapRemoval(f.jobs, f.packId))!;
        await writeMapRemovalResult(f.jobs, {
          schemaVersion: 1,
          packId: f.packId,
          removalId: removal.removalId,
          status: 'failed',
          code: 'removal_failed',
          updatedAt: now(),
        });
      }
      for (let index = 0; index < 32; index++) {
        const id = createHash('sha256').update(`Original pending removal ${index}`).digest('hex');
        await writeFile(
          join(f.jobs, 'removals', id + '.json'),
          JSON.stringify({
            schemaVersion: 1,
            packId: id,
            requestId: f.packId,
            generation: 'b'.repeat(32),
            removalId: 'a'.repeat(32),
            map: 'de_ancient',
            manifest: approval.source.manifest,
            preparedAt: now(),
            markerSha256: map.version,
            requestedAt: now(),
          }),
          { mode: 0o600 },
        );
      }
      assert.equal(await enqueueMapRemoval(f.assets, f.jobs, f.packId, map.version), 'full');
      assert.equal(
        (await readMapRemovalResult(f.jobs, f.packId))?.status,
        retry ? 'failed' : undefined,
      );
    });
});

test('map administration requires current admin, exact Origin, CSRF and reviewed snapshot identity', async (t) => {
  const f = await fixture(t),
    db = new Store(join(f.root, 'db'));
  initializeFixture(db);
  for (const id of ['admin', 'member']) {
    db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, id, null, id === 'admin' ? 1 : 0, now());
    db.run(
      'INSERT INTO sessions VALUES(?,?,?,?)',
      digest(id + '-session'),
      id,
      id + '-csrf',
      now() + 600,
    );
  }
  await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
  const catalog = join(f.root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, entries: [approval] }));
  await mkdir(join(f.target, 'maps/de_ancient/desktop'), { recursive: true });
  await writeFile(join(f.target, 'maps/de_ancient/desktop/scene.glb'), originalGlb());
  await mkdir(join(f.assets, 'de_dust2/desktop'), { recursive: true });
  await writeFile(join(f.assets, 'de_dust2/desktop/scene.glb'), originalGlb());
  const app = await createApp(
    loadConfig({
      DATA_DIR: db.root,
      MAP_ASSETS_DIR: f.assets,
      MAP_JOBS_DIR: f.jobs,
      MAP_CATALOG_FILE: catalog,
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      PUBLIC_ACCESS: 'true',
      AUTO_OFFICIAL_MAPS_ENABLED: 'true',
    }),
    db,
  );
  t.after(async () => {
    await app.close();
  });
  const headers = (id: string) => ({
    host: 'localhost:8000',
    cookie: `${COOKIE}=${id}-session`,
    origin: 'http://localhost:8000',
    'x-csrf-token': id + '-csrf',
  });
  const [map] = await listManagedMaps(f.assets, f.jobs),
    url = `/api/admin/maps/${f.packId}`;
  assert.equal(
    (await app.inject({ url: '/api/admin/maps', headers: { host: 'localhost:8000' } })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: '/api/admin/maps', headers: headers('member') })).statusCode,
    403,
  );
  const list = await app.inject({ url: '/api/admin/maps', headers: headers('admin') });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().maps[0].version, map.version);
  assert.deepEqual(list.json().operatorMaps, [{ map: 'de_dust2' }]);
  assert.equal(JSON.stringify(list.json()).includes(f.root), false);
  for (const change of [{ origin: 'https://other.invalid' }, { 'x-csrf-token': 'wrong' }]) {
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers: { ...headers('admin'), ...change },
          payload: { version: map.version },
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: headers('member'),
        payload: { version: map.version },
      })
    ).statusCode,
    403,
  );
  const modelUrl = `/api/map-packs/${f.packId}/models/de_ancient/desktop/scene.glb`;
  assert.equal((await app.inject({ url: modelUrl, headers: headers('member') })).statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: headers('admin'),
        payload: { version: map.version, path: '/arbitrary' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: headers('admin'),
        payload: { version: 'f'.repeat(64) },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: headers('admin'),
        payload: { version: map.version },
      })
    ).statusCode,
    202,
  );
  for (const method of ['GET', 'HEAD'] as const)
    assert.equal(
      (
        await app.inject({
          method,
          url: modelUrl,
          headers: { ...headers('member'), range: 'bytes=0-23' },
        })
      ).statusCode,
      404,
    );
  assert.equal(await readFile(join(f.target, 'pack.json'), 'utf8').then(Boolean), true);
  db.run(
    'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,map,metadata) VALUES(?,?,?,?,?,?,?,?,?)',
    'map-removal-fixture',
    'member',
    'Original map management fixture',
    'upload',
    'ready',
    100,
    now(),
    'de_ancient',
    JSON.stringify({ mapIdentity: approval.identity }),
  );
  const demoUrl = '/api/demos/map-removal-fixture/map-assets';
  let discovery = (await app.inject({ url: demoUrl, headers: headers('member') })).json();
  assert.equal(discovery.code, 'removed_by_admin');
  assert.equal(discovery.canAcquire, false);
  await writeMapJobResult(f.jobs, {
    schemaVersion: 2,
    packId: f.packId,
    status: 'failed',
    code: 'removed_by_admin',
    updatedAt: now() - 301,
  });
  discovery = (await app.inject({ url: demoUrl, headers: headers('member') })).json();
  assert.equal(
    discovery.canAcquire,
    false,
    'unfinished removal still blocks a fresh acquisition generation',
  );
  const removal = (await readMapRemoval(f.jobs, f.packId))!;
  await writeMapRemovalResult(f.jobs, {
    schemaVersion: 1,
    packId: f.packId,
    removalId: removal.removalId,
    status: 'removed',
    updatedAt: now(),
  });
  discovery = (await app.inject({ url: demoUrl, headers: headers('member') })).json();
  assert.equal(
    discovery.canAcquire,
    true,
    'completed removal permits a cooldown-bound explicit retry',
  );
  assert.equal(
    (await readMapResult(f.jobs, f.packId))?.status,
    'failed',
    'read-only discovery must not reacquire a deleted map',
  );

  await writePresentationStatus(f.jobs, {
    schemaVersion: 2,
    categories: {
      agents: {
        manifest: approval.source.manifest,
        generation: 'a'.repeat(24),
        status: 'failed',
        attempts: 3,
        updatedAt: now(),
        code: 'preparation_failed',
      },
    },
  });
  const retry = '/api/admin/assets/presentation/agents/retry';
  assert.equal(
    (await app.inject({ method: 'POST', url: retry, headers: headers('member'), payload: {} }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: retry,
        headers: { ...headers('admin'), origin: 'https://other.invalid' },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: retry,
        headers: { ...headers('admin'), 'x-csrf-token': 'wrong' },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: retry,
        headers: headers('admin'),
        payload: { manifest: '1' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: retry.replace('agents', 'unknown'),
        headers: headers('admin'),
        payload: {},
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: retry, headers: headers('admin'), payload: {} }))
      .statusCode,
    202,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: retry, headers: headers('admin'), payload: {} }))
      .statusCode,
    202,
  );
  const intent = JSON.parse(
    await readFile(join(f.jobs, 'presentation-retry-v2-agents.json'), 'utf8'),
  );
  assert.match(intent.expectedFailure, /^[a-f0-9]{64}$/);
  const { expectedFailure: _failure, ...selection } = intent;
  assert.deepEqual(selection, {
    schemaVersion: 2,
    kind: 'agents',
    expectedGeneration: 'a'.repeat(24),
  });
  const adminStatus = (await app.inject({ url: '/api/admin', headers: headers('admin') })).json();
  assert.equal(adminStatus.presentationAssets.categories.agents.status, 'failed');
  assert.equal(JSON.stringify(adminStatus.presentationAssets).includes(f.root), false);
});
