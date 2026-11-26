import { mapPreparerRevision, preparerRevision } from '../src/asset-preparer.js';
import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';
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
import { initializeFixture } from './fixtures/initialized.js';
import { enqueuePresentationRetry, writePresentationStatus } from '../src/presentation-assets.js';
import { digest } from '../src/security.js';
import { writeNativeWorld } from '../../tools/assets/fixtures/native-world.mjs';
process.env.LOG_LEVEL = 'silent';

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
  await writeMapJobResult(jobs, {
    schemaVersion: mapPreparerRevision,
    packId,
    status: 'ready',
    updatedAt: now(),
  });
  const target = join(assets, 'packs', packId);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, 'pack.json'),
    JSON.stringify({
      schemaVersion: mapPreparerRevision,
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
    db.run(
      'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
      id,
      id,
      null,
      id === 'admin' ? 'admin' : 'member',
      now(),
    );
    insertFixtureSession(db, id + '-session', id, id + '-csrf', now() + 600);
  }
  await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
  const catalog = join(f.root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, entries: [approval] }));
  const worldManifest = writeNativeWorld(join(f.target, 'maps'), 'de_ancient');
  writeNativeWorld(f.assets, 'de_dust2');
  const app = await createApp(
    loadConfig({
      DATA_DIR: db.root,
      MAP_ASSETS_DIR: f.assets,
      MAP_JOBS_DIR: f.jobs,
      MAP_CATALOG_FILE: catalog,
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      MFA_REQUIRED_ROLES: 'none',
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
    cookie: fixtureCookie(`${id}-session`),
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
  const modelUrl = `/api/demos/map-removal-fixture/world/${f.packId}/${createHash('sha256').update(worldManifest).digest('hex')}/map.json`;
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
          headers: headers('member'),
        })
      ).statusCode,
      404,
    );
  assert.equal(await readFile(join(f.target, 'pack.json'), 'utf8').then(Boolean), true);
  const demoUrl = '/api/demos/map-removal-fixture/map-assets';
  let discovery = (await app.inject({ url: demoUrl, headers: headers('member') })).json();
  assert.equal(discovery.code, 'removed_by_admin');
  assert.equal(discovery.canAcquire, false);
  await writeMapJobResult(f.jobs, {
    schemaVersion: mapPreparerRevision,
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
    schemaVersion: preparerRevision,
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
    await readFile(join(f.jobs, `presentation-retry-v${preparerRevision}-agents.json`), 'utf8'),
  );
  assert.match(intent.expectedFailure, /^[a-f0-9]{64}$/);
  const { expectedFailure: _failure, ...selection } = intent;
  assert.deepEqual(selection, {
    schemaVersion: preparerRevision,
    kind: 'agents',
    expectedGeneration: 'a'.repeat(24),
  });
  const adminStatus = (await app.inject({ url: '/api/admin', headers: headers('admin') })).json();
  assert.equal(adminStatus.presentationAssets.categories.agents.status, 'failed');
  assert.equal(JSON.stringify(adminStatus.presentationAssets).includes(f.root), false);
});

test('a revoked administrator cannot receive an outcome from a queued asset retry', async (t) => {
  const f = await fixture(t);
  const db = new Store(join(f.root, 'db'));
  initializeFixture(db);
  db.run(
    'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
    'admin',
    'admin',
    null,
    'admin',
    now(),
  );
  insertFixtureSession(db, 'admin-session', 'admin', 'admin-csrf', now() + 600);
  await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
  await writePresentationStatus(f.jobs, {
    schemaVersion: preparerRevision,
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
  const app = await createApp(
    loadConfig({
      DATA_DIR: db.root,
      MAP_ASSETS_DIR: f.assets,
      MAP_JOBS_DIR: f.jobs,
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      MFA_REQUIRED_ROLES: 'none',
    }),
    db,
  );
  t.after(() => app.close());

  const ahead = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const head = enqueuePresentationRetry(f.jobs, 'agents', undefined, {
    beforeRevalidate: () => {
      ahead.resolve();
      return release.promise;
    },
  });
  t.after(() => release.resolve());
  await ahead.promise;

  const mfaRequiredRoles = db.mfaRequiredRoles.bind(db);
  t.mock.method(db, 'mfaRequiredRoles', (config) => {
    const roles = mfaRequiredRoles(config);
    // The next access check after the admission charge is after reading worker
    // status. The handler then adds its operation to the occupied retry queue.
    if (db.one('SELECT 1 FROM rate_limits WHERE key=?', digest('presentation-retry:admin')))
      admitted.resolve();
    return roles;
  });
  const response = app.inject({
    method: 'POST',
    url: '/api/admin/assets/presentation/equipment/retry',
    headers: {
      host: 'localhost:8000',
      cookie: fixtureCookie('admin-session'),
      origin: 'http://localhost:8000',
      'x-csrf-token': 'admin-csrf',
      'x-session-context': 'admin-csrf',
    },
    payload: {},
  });
  try {
    await Promise.race([
      admitted.promise,
      response.then((early) =>
        assert.fail('Retry returned before joining the queue: ' + early.body),
      ),
    ]);
    db.run('DELETE FROM sessions WHERE user_id=?', 'admin');
  } finally {
    release.resolve();
  }
  assert.equal(await head, 'queued');
  const revoked = await response;
  assert.equal(revoked.statusCode, 409);
  assert.equal(revoked.headers['x-session-changed'], '1');
  await assert.rejects(
    readFile(join(f.jobs, `presentation-retry-v${preparerRevision}-equipment.json`)),
    {
      code: 'ENOENT',
    },
  );
});

test('an administrator revoked after a matching queue lookup cannot receive its outcome', async (t) => {
  const f = await fixture(t);
  const db = new Store(join(f.root, 'db'));
  initializeFixture(db);
  db.run("INSERT INTO users(id,username,role,created_at) VALUES('admin','admin','admin',?)", now());
  await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
  await writePresentationStatus(f.jobs, {
    schemaVersion: preparerRevision,
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
  const app = await createApp(
    loadConfig({
      DATA_DIR: db.root,
      MAP_ASSETS_DIR: f.assets,
      MAP_JOBS_DIR: f.jobs,
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      MFA_REQUIRED_ROLES: 'none',
    }),
    db,
  );
  t.after(() => app.close());
  const [map] = await listManagedMaps(f.assets, f.jobs);
  for (const operation of [
    {
      action: 'assets.retry_requested',
      method: 'POST',
      url: '/api/admin/assets/presentation/agents/retry',
      payload: {},
      queueFile: join(f.jobs, `presentation-retry-v${preparerRevision}-agents.json`),
    },
    {
      action: 'map.removal_requested',
      method: 'DELETE',
      url: `/api/admin/maps/${f.packId}`,
      payload: { version: map.version },
      queueFile: join(f.jobs, 'removals', `${f.packId}.json`),
    },
  ] as const) {
    await t.test(operation.action, async () => {
      const { queueFile, action, ...options } = operation;
      const csrf = `${action}-csrf`;
      insertFixtureSession(db, action, 'admin', csrf, now() + 600);
      const submit = () =>
        app.inject({
          ...options,
          headers: {
            host: 'localhost:8000',
            cookie: fixtureCookie(action),
            origin: 'http://localhost:8000',
            'x-csrf-token': csrf,
            'x-session-context': csrf,
          },
        });
      assert.equal((await submit()).statusCode, 202);
      const queued = await readFile(queueFile);
      // Revoke after the no-op callback records its linked outcome, before the
      // queue promise resolves to the HTTP handler.
      db.db.exec(`CREATE TEMP TRIGGER revoke_after_queue_outcome AFTER INSERT ON audit
        WHEN NEW.outcome='success' AND NEW.intent_id IS NOT NULL
        BEGIN DELETE FROM sessions WHERE user_id=NEW.actor; END;`);
      try {
        const revoked = await submit();
        assert.equal(db.one('SELECT 1 FROM sessions WHERE csrf=?', csrf), undefined);
        assert.equal(revoked.statusCode, 409);
        assert.equal(revoked.headers['x-session-changed'], '1');
        assert.deepEqual(await readFile(queueFile), queued);
        assert.equal(
          db.one(
            `SELECT count(*) AS count FROM audit outcome JOIN audit intent ON intent.id=outcome.intent_id
             WHERE outcome.action=? AND outcome.outcome='success' AND intent.outcome='authorized'`,
            action,
          )?.count,
          2,
        );
      } finally {
        db.db.exec('DROP TRIGGER revoke_after_queue_outcome');
      }
    });
  }
});
