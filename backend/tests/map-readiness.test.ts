import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { COOKIE, digest } from '../src/security.js';
import { initializeFixture } from './fixtures/initialized.js';
import {
  prepareMapJobs,
  writeMapWorkerStatus,
  writeOfficialMapInventory,
  readMapRequest,
} from '../src/map-jobs.js';
import { latestOfficialSelection, latestMapRequestId } from '../src/map-catalog.js';
process.env.LOG_LEVEL = 'silent';
async function fixture(enabled?: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'cswatch-map-readiness-')),
    root = join(directory, 'data'),
    maps = join(directory, 'maps'),
    jobs = join(directory, 'jobs'),
    catalog = join(directory, 'catalog.json');
  mkdirSync(maps);
  writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, entries: [] }), { mode: 0o600 });
  const db = new Store(root);
  initializeFixture(db);
  for (const id of ['member', 'other', 'fixture-instance-admin']) {
    if (id !== 'fixture-instance-admin')
      db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, id, null, 0, now());
    db.run(
      'INSERT INTO sessions VALUES(?,?,?,?)',
      digest(id + '-session'),
      id,
      id + '-csrf',
      now() + 300,
    );
  }
  db.run(
    'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,map,metadata) VALUES(?,?,?,?,?,?,?,?,?)',
    'ancient-demo',
    'member',
    'Original Ancient readiness fixture',
    'upload',
    'ready',
    1,
    now(),
    'de_ancient',
    JSON.stringify({ mapIdentity: { map: 'de_ancient', addonPresence: 'none' } }),
  );
  await prepareMapJobs(jobs);
  const config = loadConfig({
    DATA_DIR: root,
    MAP_ASSETS_DIR: maps,
    MAP_JOBS_DIR: jobs,
    MAP_CATALOG_FILE: catalog,
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    ...(enabled === undefined ? {} : { AUTO_OFFICIAL_MAPS_ENABLED: String(enabled) }),
  });
  const app = await createApp(config, db);
  const request = (
    url = '/api/demos/ancient-demo/map-assets',
    user = 'member',
    method: 'GET' | 'POST' = 'GET',
  ) =>
    app.inject({
      url,
      method,
      headers: {
        host: 'localhost:8000',
        ...(user ? { cookie: `${COOKIE}=${user}-session` } : {}),
        ...(method === 'POST'
          ? { origin: 'http://localhost:8000', 'x-csrf-token': user + '-csrf' }
          : {}),
      },
      ...(method === 'POST' ? { payload: {} } : {}),
    });
  const inventory = (updatedAt = now(), map = 'de_ancient') => ({
    schemaVersion: 1 as const,
    appId: 730 as const,
    depotId: 2347770 as const,
    manifest: '239443625111074552',
    updatedAt,
    maps: [{ map, sha1: 'a'.repeat(40), bytes: 1234 }],
  });
  return {
    directory,
    root,
    maps,
    jobs,
    catalog,
    db,
    app,
    request,
    inventory,
    heartbeat: () =>
      writeMapWorkerStatus(jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() }),
    close: async () => {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('fresh default deployment reports disabled policy and admin diagnostics without suggesting a missing historical approval', async () => {
  const s = await fixture();
  try {
    const before = readdirSync(join(s.jobs, 'requests'));
    const response = (await s.request()).json();
    assert.equal(response.acquisition, 'disabled');
    assert.equal(response.readinessReason, 'automatic_disabled');
    assert.equal(response.canAcquire, false);
    const admin = (await s.request('/api/admin', 'fixture-instance-admin')).json();
    assert.deepEqual(admin.mapReadiness, {
      enabled: false,
      worker: { available: false },
      inventory: { status: 'unavailable', mapCount: 0 },
      catalog: { status: 'empty', entries: 0 },
    });
    assert.equal(admin.flags.auto_official_maps_enabled.locked, false);
    assert.deepEqual(readdirSync(join(s.jobs, 'requests')), before);
    assert.equal((await s.request('/api/admin', 'member')).statusCode, 403);
    assert.equal((await s.request('/api/demos/ancient-demo/map-assets', 'other')).statusCode, 404);
  } finally {
    await s.close();
  }
});
test('Ancient bootstrap distinguishes worker absence, missing/stale inventory and fresh official membership without catalog approval', async () => {
  const s = await fixture(true);
  try {
    assert.equal((await s.request()).json().readinessReason, 'worker_unavailable');
    await s.heartbeat();
    assert.equal((await s.request()).json().readinessReason, 'inventory_unavailable');
    await writeOfficialMapInventory(s.jobs, s.inventory(now() - 86401));
    assert.equal((await s.request()).json().readinessReason, 'inventory_stale');
    await writeOfficialMapInventory(s.jobs, s.inventory());
    const found = (await s.request()).json();
    assert.equal(found.resolution.status, 'latest');
    assert.equal(found.canAcquire, true);
    assert.equal(found.readinessReason, undefined);
    assert.equal(found.packId, null);
    assert.deepEqual(
      readdirSync(join(s.jobs, 'requests')),
      [],
      'Discovery never enqueues a source.',
    );
    const admin = (await s.request('/api/admin', 'fixture-instance-admin')).json();
    assert.equal(admin.mapReadiness.inventory.status, 'fresh');
    assert.equal(admin.mapReadiness.inventory.mapCount, 1);
    assert.equal(admin.mapReadiness.inventory.manifest, '239443625111074552');
    assert.equal(admin.mapReadiness.catalog.status, 'empty');
    const queued = await s.request('/api/demos/ancient-demo/map-assets', 'member', 'POST');
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().acquisition, 'queued');
    const selection = latestOfficialSelection(s.inventory(), 'de_ancient')!;
    assert.equal(
      (await readMapRequest(s.jobs, latestMapRequestId(selection)))?.kind,
      'latest-official',
    );
  } finally {
    await s.close();
  }
});
test('a fresh official list rejects unknown/addon/conflicting maps rather than converting setup diagnostics into source authorization', async () => {
  const s = await fixture(true);
  try {
    await s.heartbeat();
    await writeOfficialMapInventory(s.jobs, s.inventory(now(), 'de_otherofficial'));
    let info = (await s.request()).json();
    assert.equal(info.readinessReason, 'official_map_unknown');
    assert.equal(info.canAcquire, false);
    assert.equal(
      (await s.request('/api/demos/ancient-demo/map-assets', 'member', 'POST')).statusCode,
      200,
    );
    assert.deepEqual(readdirSync(join(s.jobs, 'requests')), []);
    await writeOfficialMapInventory(s.jobs, s.inventory());
    for (const mapIdentity of [
      { map: 'de_ancient', addonPresence: 'present' },
      { map: 'de_ancient', conflicted: true },
      { map: 'de_mirage', addonPresence: 'none' },
    ]) {
      s.db.run(
        'UPDATE demos SET metadata=? WHERE id=?',
        JSON.stringify({ mapIdentity }),
        'ancient-demo',
      );
      info = (await s.request()).json();
      assert.equal(info.canAcquire, false);
      assert.ok(info.resolution.status === 'addon' || info.readinessReason === 'identity_invalid');
    }
  } finally {
    await s.close();
  }
});
test('invalid or linked local metadata stays unavailable and admin diagnostics reveal no configured filesystem paths', async () => {
  const s = await fixture(true);
  try {
    await s.heartbeat();
    writeFileSync(join(s.jobs, 'official-inventory.json'), 'malformed', { mode: 0o600 });
    let response = (await s.request()).json();
    assert.equal(response.readinessReason, 'inventory_unavailable');
    rmSync(join(s.jobs, 'official-inventory.json'));
    const external = join(s.directory, 'external.json');
    writeFileSync(external, JSON.stringify(s.inventory()), { mode: 0o600 });
    symlinkSync(external, join(s.jobs, 'official-inventory.json'));
    response = (await s.request()).json();
    assert.equal(response.canAcquire, false);
    assert.equal(response.readinessReason, 'inventory_unavailable');
    const data = (await s.request('/api/admin', 'fixture-instance-admin')).json().mapReadiness;
    assert.equal(data.inventory.status, 'unavailable');
    assert.equal(JSON.stringify(data).includes(s.directory), false);
    assert.deepEqual(readdirSync(join(s.jobs, 'requests')), []);
  } finally {
    await s.close();
  }
});

test('administrator diagnostics follow saved policy while environment overrides stay authoritative', async () => {
  for (const locked of [false, true]) {
    const s = await fixture(locked ? false : undefined);
    try {
      const saved = await s.app.inject({
        method: 'PATCH',
        url: '/api/admin',
        headers: {
          host: 'localhost:8000',
          origin: 'http://localhost:8000',
          cookie: `${COOKIE}=fixture-instance-admin-session`,
          'x-csrf-token': 'fixture-instance-admin-csrf',
        },
        payload: { auto_official_maps_enabled: true },
      });
      assert.equal(saved.statusCode, 200);
      const info = (await s.request('/api/admin', 'fixture-instance-admin')).json();
      assert.equal(info.flags.auto_official_maps_enabled.locked, locked);
      assert.equal(info.mapReadiness.enabled, !locked);
      assert.equal(
        (await s.request()).json().readinessReason,
        locked ? 'automatic_disabled' : 'worker_unavailable',
      );
      assert.deepEqual(readdirSync(join(s.jobs, 'requests')), []);
    } finally {
      await s.close();
    }
  }
});

test('inventory failure details are strict, admin-only, retained for stopped workers and cleared by a healthy refresh', async () => {
  const s = await fixture(true);
  try {
    const at = now(),
      inventoryFailure = {
        phase: 'downloader' as const,
        code: 'steam_rate_limited' as const,
        at,
        retryAt: at + 900,
        exitCode: 4,
      };
    await writeMapWorkerStatus(s.jobs, {
      schemaVersion: 1,
      status: 'idle',
      updatedAt: at,
      inventoryFailure,
    });
    let diagnostics = (await s.request('/api/admin', 'fixture-instance-admin')).json().mapReadiness;
    assert.deepEqual(diagnostics.worker, { available: true, inventoryFailure });
    assert.equal((await s.request('/api/admin', 'member')).statusCode, 403);
    const publicDescriptor = (await s.request()).json();
    assert.equal(publicDescriptor.readinessReason, 'inventory_unavailable');
    assert.equal(JSON.stringify(publicDescriptor).includes('steam_rate_limited'), false);
    assert.equal(JSON.stringify(diagnostics).includes(s.directory), false);
    await writeMapWorkerStatus(s.jobs, {
      schemaVersion: 1,
      status: 'idle',
      updatedAt: 0,
      inventoryFailure,
    });
    diagnostics = (await s.request('/api/admin', 'fixture-instance-admin')).json().mapReadiness;
    assert.deepEqual(diagnostics.worker, { available: false, inventoryFailure });
    for (const invalid of [
      { ...inventoryFailure, code: '/private/raw/error' },
      { ...inventoryFailure, phase: 'https://private.invalid' },
      { ...inventoryFailure, exitCode: 256 },
      { ...inventoryFailure, retryAt: at + 3601 },
      { ...inventoryFailure, message: 'never-publish-raw-output' },
    ]) {
      writeFileSync(
        join(s.jobs, 'worker-status.json'),
        JSON.stringify({
          schemaVersion: 1,
          status: 'idle',
          updatedAt: at,
          inventoryFailure: invalid,
        }),
        { mode: 0o640 },
      );
      diagnostics = (await s.request('/api/admin', 'fixture-instance-admin')).json().mapReadiness;
      assert.deepEqual(diagnostics.worker, { available: false });
    }
    await writeOfficialMapInventory(s.jobs, s.inventory());
    await s.heartbeat();
    diagnostics = (await s.request('/api/admin', 'fixture-instance-admin')).json().mapReadiness;
    assert.deepEqual(diagnostics.worker, { available: true });
    assert.equal(diagnostics.inventory.status, 'fresh');
    assert.equal((await s.request()).json().canAcquire, true);
    assert.deepEqual(readdirSync(join(s.jobs, 'requests')), []);
  } finally {
    await s.close();
  }
});
