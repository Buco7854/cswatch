import { readFileSync } from 'node:fs';
import { writeNativeWorld, vertexFile } from '../../tools/assets/fixtures/native-world.mjs';
import { mapPreparerRevision } from '../src/asset-preparer.js';
import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { ApprovedMapEntry } from '../../shared/map-acquisition.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { guestCookieName } from '../src/guest.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';
import { initializeFixture } from './fixtures/initialized.js';
import {
  mapPackId,
  latestMapRequestId,
  latestMapPackId,
  latestOfficialSelection,
} from '../src/map-catalog.js';
import {
  prepareMapJobs,
  writeMapWorkerStatus,
  writeMapJobResult,
  enqueueMapRequest,
  enqueueLatestMapRequest,
  readMapRequest,
  writeOfficialMapInventory,
} from '../src/map-jobs.js';
process.env.LOG_LEVEL = 'silent';
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
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function png() {
  const part = (name: string, data: Buffer) => {
    const size = Buffer.alloc(4),
      crc = Buffer.alloc(4),
      body = Buffer.concat([Buffer.from(name), data]);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    part('IHDR', ihdr),
    part('IDAT', deflateSync(Buffer.alloc(68))),
    part('IEND', Buffer.alloc(0)),
  ]);
}
function glb() {
  const raw = JSON.stringify({ asset: { version: '2.0' } }),
    json = Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4, ' ')),
    header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}
function install(root: string, map = 'de_mirage', assetVersion = 'Synthetic-version') {
  const image = png(),
    model = writeNativeWorld(root, map, approval.source.manifest);
  const overview = join(root, 'overviews', map);
  mkdirSync(overview, { recursive: true });
  writeFileSync(join(overview, 'overview.png'), image);
  writeFileSync(
    join(overview, 'overview.json'),
    JSON.stringify({
      schemaVersion: 1,
      map,
      origin: { x: 1, y: 2 },
      scale: 4,
      referenceSize: 1024,
      assetVersion,
      imageSha256: sha(image),
    }),
  );
  return { image, model };
}
function expectManual(root: string) {
  return (
    '/api/demos/private-demo/world/manual/' +
    sha(readFileSync(join(root, 'de_mirage', 'map.json'))) +
    '/map.json'
  );
}
async function fixture(enabled = true, privateInstance = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cswatch-demo-assets-')),
    root = join(directory, 'data'),
    maps = join(directory, 'separate-readonly-maps'),
    catalog = join(directory, 'catalog.json'),
    jobs = join(directory, 'jobs');
  mkdirSync(maps);
  writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, entries: [approval] }), {
    mode: 0o600,
  });
  const db = new Store(root);
  initializeFixture(db);
  for (const id of ['member', 'other']) {
    db.run(
      'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
      id,
      id,
      null,
      'member',
      now(),
    );
    insertFixtureSession(db, id + '-session', id, id + '-csrf', now() + 120);
  }
  db.run(
    'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,map,metadata) VALUES(?,?,?,?,?,?,?,?,?)',
    'private-demo',
    'member',
    'Fixture',
    'upload',
    'ready',
    100,
    now(),
    'de_mirage',
    JSON.stringify({ mapIdentity: approval.identity }),
  );
  const config = loadConfig({
    DATA_DIR: root,
    MAP_ASSETS_DIR: maps,
    MAP_CATALOG_FILE: catalog,
    MAP_JOBS_DIR: jobs,
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    AUTO_OFFICIAL_MAPS_ENABLED: String(enabled),
    PUBLIC_ACCESS: String(!privateInstance),
  });
  const app = await createApp(config, db);
  const request = (
    url = '/api/demos/private-demo/map-assets',
    user = 'member',
    method: 'GET' | 'POST' | 'HEAD' = 'GET',
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: 'localhost:8000',
        ...(user ? { cookie: fixtureCookie(`${user}-session`) } : {}),
        ...(method === 'POST'
          ? { origin: 'http://localhost:8000', 'x-csrf-token': user + '-csrf' }
          : {}),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  return {
    directory,
    root,
    maps,
    catalog,
    jobs,
    db,
    app,
    config,
    request,
    close: async () => {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function latestInventory(at = now(), manifest = '18014398509481985') {
  return {
    schemaVersion: 1 as const,
    appId: 730 as const,
    depotId: 2347770 as const,
    manifest,
    updatedAt: at,
    maps: [{ map: 'de_mirage', sha1: 'c'.repeat(40), bytes: 12345 }],
  };
}
async function latestReadyFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const inventory = latestInventory();
  await writeOfficialMapInventory(f.jobs, inventory);
  writeFileSync(f.catalog, JSON.stringify({ schemaVersion: 1, entries: [] }));
  const selection = latestOfficialSelection(inventory, 'de_mirage')!,
    requestId = latestMapRequestId(selection);
  const source = {
    appId: 730 as const,
    depotId: 2347770 as const,
    manifest: selection.manifest,
    mapSha256: 'd'.repeat(64),
  };
  const assetPackId = latestMapPackId(selection.map, source),
    target = join(f.maps, 'packs', assetPackId);
  await enqueueLatestMapRequest(f.jobs, selection);
  const original = install(
    join(target, 'maps'),
    'de_mirage',
    `steam-2347770-${selection.manifest}`,
  );
  writeFileSync(
    join(target, 'pack.json'),
    JSON.stringify({
      schemaVersion: mapPreparerRevision,
      kind: 'latest-official',
      packId: assetPackId,
      requestId,
      selection,
      source,
      preparedAt: now(),
    }),
  );
  await writeMapJobResult(f.jobs, {
    schemaVersion: mapPreparerRevision,
    packId: requestId,
    status: 'ready',
    updatedAt: now(),
    assetPackId,
    source,
    sourceCheckedAt: now(),
  });
  return { inventory, selection, source, requestId, assetPackId, target, original };
}

test('fresh official inventory enables disclosed latest fallback without manual source approval or GET-side acquisition', async () => {
  const f = await fixture();
  try {
    writeFileSync(f.catalog, JSON.stringify({ schemaVersion: 1, entries: [] }));
    f.db.run('UPDATE demos SET metadata=? WHERE id=?', JSON.stringify({}), 'private-demo');
    const inventory = latestInventory();
    await writeOfficialMapInventory(f.jobs, inventory);
    await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
    const selection = latestOfficialSelection(inventory, 'de_mirage')!,
      id = latestMapRequestId(selection);
    const described = (await f.request()).json();
    assert.equal(described.resolution.status, 'latest');
    assert.deepEqual(described.resolution.selection, selection);
    assert.equal(described.resolution.source, null);
    assert.equal(described.verification, 'unavailable');
    assert.equal(described.canAcquire, true);
    assert.equal(existsSync(join(f.jobs, 'requests', id + '.json')), false);
    assert.equal((await f.request(undefined, 'other', 'POST', {})).statusCode, 404);
    assert.equal((await f.request(undefined, 'member', 'POST', { manifest: '2' })).statusCode, 400);
    const queued = await f.request(undefined, 'member', 'POST', {});
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().acquisition, 'queued');
    assert.equal(queued.json().packId, null);
    const request = await readMapRequest(f.jobs, id);
    assert.equal(request?.kind, 'latest-official');
    assert.equal(request?.approval, undefined);
    const processing = {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'processing' as const,
      updatedAt: now(),
      phase: 'mobile' as const,
    };
    await writeMapJobResult(f.jobs, processing);
    assert.equal((await f.request()).json().phase, 'mobile');
    await writeMapJobResult(f.jobs, { ...processing, repairing: true });
    const repair = (await f.request()).json();
    assert.equal(repair.phase, 'mobile');
    assert.equal(repair.code, 'pack_invalid');
    await assert.rejects(writeMapJobResult(f.jobs, { ...processing, status: 'ready' }));
    await writeMapJobResult(f.jobs, {
      ...processing,
      phase: undefined,
      status: 'failed',
      code: 'storage_limit',
    });
    assert.equal((await f.request()).json().phase, undefined);
  } finally {
    await f.close();
  }
});

test('exact approval stays preferred; explicit addons, conflicts and unlisted names never become latest official', async () => {
  const f = await fixture();
  try {
    await writeOfficialMapInventory(f.jobs, latestInventory());
    assert.equal((await f.request()).json().resolution.status, 'approved');
    writeFileSync(f.catalog, JSON.stringify({ schemaVersion: 1, entries: [] }));
    for (const identity of [
      { ...approval.identity, addonPresence: 'present' },
      { ...approval.identity, conflicted: true },
      { ...approval.identity, map: 'de_dust2' },
    ]) {
      f.db.run(
        'UPDATE demos SET metadata=? WHERE id=?',
        JSON.stringify({ mapIdentity: identity }),
        'private-demo',
      );
      const value = (await f.request()).json();
      assert.notEqual(value.resolution.status, 'latest');
      assert.equal(value.canAcquire, false);
    }
    f.db.run(
      'UPDATE demos SET map=?,metadata=? WHERE id=?',
      'de_unlisted_user_input',
      JSON.stringify({}),
      'private-demo',
    );
    assert.notEqual((await f.request()).json().resolution.status, 'latest');
  } finally {
    await f.close();
  }
});

test('latest ready descriptors and immutable URLs require worker marker/request/source proof rather than queue IDs', async () => {
  const f = await fixture();
  try {
    const p = await latestReadyFixture(f),
      value = (await f.request()).json();
    assert.equal(value.acquisition, 'ready');
    assert.equal(value.verification, 'latest-official');
    assert.equal(value.packId, p.assetPackId);
    assert.deepEqual(value.resolution.source, p.source);
    assert.match(value.assets.model, new RegExp('/world/' + p.assetPackId + '/'));
    assert.equal((await f.request(value.assets.model)).statusCode, 200);
    assert.equal((await f.request(value.assets.overview.image)).statusCode, 200);
    assert.equal(
      (await f.request('/api/map-packs/' + p.requestId + '/models/de_mirage/desktop/scene.glb'))
        .statusCode,
      404,
    );
    rmSync(join(p.target, 'pack.json'));
    assert.equal((await f.request()).json().acquisition, 'processing');
    assert.equal((await f.request()).json().code, 'pack_invalid');
    assert.equal((await f.request(value.assets.model)).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('refreshed inventory does not relabel or break existing immutable latest snapshot URLs', async () => {
  const f = await fixture();
  try {
    const p = await latestReadyFixture(f),
      before = (await f.request()).json();
    await writeOfficialMapInventory(f.jobs, latestInventory(now(), '18014398509481986'));
    const next = (await f.request()).json();
    assert.equal(next.resolution.status, 'latest');
    assert.notEqual(next.resolution.selection.manifest, p.source.manifest);
    assert.equal(next.acquisition, 'unavailable');
    assert.equal(next.resolution.source, null);
    assert.equal((await f.request(before.assets.model)).statusCode, 200);
    const staleAt = now() - 86401;
    await writeOfficialMapInventory(f.jobs, { ...p.inventory, updatedAt: staleAt });
    const cached = (await f.request()).json();
    assert.equal(cached.acquisition, 'ready');
    assert.equal(cached.resolution.inventoryUpdatedAt, staleAt);
    assert.equal(cached.canAcquire, false);
    assert.equal((await f.request(before.assets.model)).statusCode, 200);
    await writeOfficialMapInventory(f.jobs, {
      ...p.inventory,
      maps: [{ ...p.inventory.maps[0], map: 'de_other_official' }],
    });
    assert.equal((await f.request(before.assets.model)).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('stale inventory cannot authorize a fresh source job and disabled policy preserves manual unverified packs', async () => {
  const f = await fixture();
  try {
    writeFileSync(f.catalog, JSON.stringify({ schemaVersion: 1, entries: [] }));
    await writeOfficialMapInventory(f.jobs, latestInventory(now() - 86401));
    await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
    assert.notEqual((await f.request()).json().resolution.status, 'latest');
    assert.equal((await f.request(undefined, 'member', 'POST', {})).json().canAcquire, false);
  } finally {
    await f.close();
  }
  const disabled = await fixture(false);
  try {
    writeFileSync(disabled.catalog, JSON.stringify({ schemaVersion: 1, entries: [] }));
    await writeOfficialMapInventory(disabled.jobs, latestInventory());
    install(disabled.maps);
    const value = (await disabled.request()).json();
    assert.equal(value.acquisition, 'disabled');
    assert.equal(value.verification, 'version-unverified');
    assert.equal(value.canAcquire, false);
    assert.equal(value.assets.model, expectManual(disabled.maps));
  } finally {
    await disabled.close();
  }
});

test('unavailable historical source may select fresh latest while ready exact and source-evidence failures remain preferred or terminal', async () => {
  const f = await fixture();
  try {
    await writeOfficialMapInventory(f.jobs, latestInventory());
    await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
    await enqueueMapRequest(f.jobs, approval);
    const id = mapPackId(approval);
    for (const code of ['source_mismatch', 'approval_removed'] as const) {
      await writeMapJobResult(f.jobs, {
        schemaVersion: mapPreparerRevision,
        packId: id,
        status: 'failed',
        code,
        updatedAt: now(),
      });
      const value = (await f.request()).json();
      assert.equal(value.resolution.status, 'approved');
      assert.equal(value.acquisition, 'failed');
      assert.equal(value.canAcquire, false);
    }
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'failed',
      code: 'source_unavailable',
      updatedAt: now(),
    });
    const latest = (await f.request()).json();
    assert.equal(latest.resolution.status, 'latest');
    assert.equal(latest.canAcquire, true);
    assert.equal((await f.request(undefined, 'member', 'POST', {})).statusCode, 202);
    await writeOfficialMapInventory(f.jobs, latestInventory(now() - 86401));
    assert.equal((await f.request()).json().resolution.status, 'approved');
    install(join(f.maps, 'packs', id, 'maps'));
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'ready',
      updatedAt: now(),
    });
    await writeOfficialMapInventory(f.jobs, latestInventory());
    const exact = (await f.request()).json();
    assert.equal(exact.resolution.status, 'approved');
    assert.equal(exact.acquisition, 'ready');
    assert.equal(exact.verification, 'operator-approved');
  } finally {
    await f.close();
  }
});

test('unavailable historical source retains an already-ready latest snapshot with stale inventory but cannot acquire another one', async () => {
  const f = await fixture();
  try {
    const p = await latestReadyFixture(f);
    writeFileSync(f.catalog, JSON.stringify({ schemaVersion: 1, entries: [approval] }));
    const exactId = mapPackId(approval);
    await enqueueMapRequest(f.jobs, approval);
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: exactId,
      status: 'failed',
      code: 'source_unavailable',
      updatedAt: now(),
    });
    const staleAt = now() - 86401;
    await writeOfficialMapInventory(f.jobs, { ...p.inventory, updatedAt: staleAt });
    const cached = (await f.request()).json();
    assert.equal(cached.resolution.status, 'latest');
    assert.equal(cached.resolution.inventoryUpdatedAt, staleAt);
    assert.equal(cached.acquisition, 'ready');
    assert.equal(cached.verification, 'latest-official');
    assert.equal(cached.packId, p.assetPackId);
    assert.equal(cached.canAcquire, false);
    assert.equal((await f.request(cached.assets.model)).statusCode, 200);
    rmSync(join(f.jobs, 'results', p.requestId + '.json'));
    const missing = (await f.request()).json();
    assert.equal(missing.resolution.status, 'approved');
    assert.equal(missing.acquisition, 'failed');
    assert.equal(missing.canAcquire, false);
    assert.equal(
      (await f.request(undefined, 'member', 'POST', {})).json().resolution.status,
      'approved',
    );
  } finally {
    await f.close();
  }
});

test('scoped map discovery preserves demo ACL and explicit sharing while only owners may request preparation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(undefined, '')).statusCode, 404);
    assert.equal((await f.request(undefined, 'other')).statusCode, 404);
    f.db.run('UPDATE demos SET public=1 WHERE id=?', 'private-demo');
    assert.equal((await f.request(undefined, '')).statusCode, 200);
    assert.equal((await f.request(undefined, '')).json().canAcquire, false);
    assert.equal((await f.request(undefined, 'other', 'POST', {})).statusCode, 404);
    const anonymous = await f.request(undefined, '', 'POST', {});
    assert.equal(anonymous.statusCode, 403, anonymous.body);
    assert.equal(anonymous.json().detail, 'Session expired. Refresh the page and try again.');
    const browser = await browserBootstrap(f.app, f.config);
    const guest = await f.app.inject({
      url: '/api/guest/session',
      method: 'POST',
      headers: browser,
      payload: {},
    });
    assert.equal(guest.statusCode, 201, guest.body);
    const capability = guest.cookies.find((cookie) => cookie.name === guestCookieName(f.config));
    assert.ok(capability);
    const guestHeaders = {
      cookie: `${browser.cookie}; ${capability.name}=${capability.value}`,
      'x-csrf-token': guest.json().csrf,
    };
    const denied = await f.request(undefined, '', 'POST', {}, guestHeaders);
    const missing = await f.request('/api/demos/missing/map-assets', '', 'POST', {}, guestHeaders);
    assert.equal(denied.statusCode, 404, denied.body);
    assert.equal(missing.statusCode, 404, missing.body);
    assert.deepEqual(denied.json(), missing.json());
    assert.equal(existsSync(f.jobs), false);
    const own = await f.request();
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().resolution.status, 'approved');
  } finally {
    await f.close();
  }
});
test('automatic mode never falls back to a same-name manual pack and GET never starts a job', async () => {
  const f = await fixture();
  try {
    install(f.maps);
    const response = (await f.request()).json();
    assert.equal(response.acquisition, 'unavailable');
    assert.equal(response.canAcquire, false);
    assert.equal(response.assets.model, null);
    assert.equal(existsSync(f.jobs), false);
    await prepareMapJobs(f.jobs);
    await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
    assert.equal((await f.request()).json().canAcquire, true);
    assert.equal(existsSync(join(f.jobs, 'requests', mapPackId(approval) + '.json')), false);
    assert.equal(
      (await f.request(undefined, 'member', 'POST', {}, { origin: 'http://evil.invalid' }))
        .statusCode,
      403,
    );
    assert.equal(
      (await f.request(undefined, 'member', 'POST', {}, { 'x-csrf-token': 'wrong' })).statusCode,
      403,
    );
    assert.equal(
      (await f.request(undefined, 'member', 'POST', { source: approval.source })).statusCode,
      400,
    );
    assert.equal(
      (await f.request(undefined, 'member', 'POST', { generation: 'a'.repeat(32) })).statusCode,
      400,
    );
    const queued = await f.request(undefined, 'member', 'POST', {});
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().acquisition, 'queued');
    assert.equal(queued.json().canAcquire, false);
    assert.equal((await f.request(undefined, 'member', 'POST', {})).json().acquisition, 'queued');
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: mapPackId(approval),
      status: 'failed',
      updatedAt: now(),
      code: 'source_mismatch',
    });
    const failed = (await f.request()).json();
    assert.equal(failed.acquisition, 'failed');
    assert.equal(failed.code, 'source_mismatch');
    assert.equal(failed.canAcquire, false);
  } finally {
    await f.close();
  }
});
test('manual mode explicitly labels version-unverified assets from MAP_ASSETS_DIR and leaves old DATA_DIR/maps unused', async () => {
  const f = await fixture(false);
  try {
    const { model, image } = install(f.maps);
    const response = (await f.request()).json();
    assert.equal(response.acquisition, 'disabled');
    assert.equal(response.verification, 'version-unverified');
    assert.equal(response.packId, null);
    assert.equal(response.assets.model, expectManual(f.maps));
    assert.deepEqual((await f.request(response.assets.model)).rawPayload, model);
    assert.deepEqual((await f.request(response.assets.overview.image)).rawPayload, image);
    mkdirSync(join(f.maps, 'agents'));
    writeFileSync(join(f.maps, 'agents', 'ct.glb'), glb());
    assert.equal((await f.request('/api/assets/agents')).json().ct, '/map-assets/agents/ct.glb');
    const preview = join(f.maps, 'previews', 'de_mirage');
    mkdirSync(preview, { recursive: true });
    writeFileSync(join(preview, 'preview.png'), image);
    writeFileSync(
      join(preview, 'preview.json'),
      JSON.stringify({
        schemaVersion: 1,
        map: 'de_mirage',
        assetVersion: 'fixture',
        imageSha256: sha(image),
      }),
    );
    assert.equal((await f.request('/api/map-preview')).json().map, 'de_mirage');
    mkdirSync(join(f.maps, 'equipment'));
    writeFileSync(join(f.maps, 'equipment', 'ak47.png'), image);
    assert.equal(
      (await f.request('/api/assets/equipment')).json().icons.ak47,
      '/api/assets/equipment/ak47.png',
    );
    const equipmentModel = glb();
    const equipment = join(f.maps, 'equipment-models', 'ak47');
    mkdirSync(equipment, { recursive: true });
    writeFileSync(join(equipment, 'model.glb'), equipmentModel);
    writeFileSync(
      join(equipment, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'ak47',
        coordinateSystem: 'weapon-meters-y-up-x-forward',
        assetVersion: 'Synthetic fixture',
        sha256: sha(equipmentModel),
        bytes: equipmentModel.length,
        decodedTextureBytes: 0,
        geometryBytes: 0,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      }),
    );
    assert.equal(
      (await f.request('/api/assets/equipment-models')).json().items.ak47.model,
      '/api/assets/equipment-models/ak47.glb',
    );
    assert.deepEqual(
      (await f.request('/api/assets/equipment-models/ak47.glb')).rawPayload,
      equipmentModel,
    );
  } finally {
    await f.close();
  }
});
test('immutable approved packs require current unambiguous catalog and ready result on every descriptor/art/model route', async () => {
  const f = await fixture();
  try {
    const id = mapPackId(approval),
      pack = join(f.maps, 'packs', id, 'maps');
    install(pack);
    await enqueueMapRequest(f.jobs, approval);
    const model = `/api/demos/private-demo/world/${id}/${sha(readFileSync(join(pack, 'de_mirage', 'map.json')))}/map.json`,
      overview = `/api/map-packs/${id}/maps/de_mirage/overview.png`,
      face = model.replace('map.json', vertexFile);
    for (const path of [model, overview, face])
      assert.equal((await f.request(path)).statusCode, 404);
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'ready',
      updatedAt: now(),
    });
    const ready = (await f.request()).json();
    assert.equal(ready.acquisition, 'ready');
    assert.equal(ready.verification, 'operator-approved');
    assert.equal(ready.packId, id);
    assert.equal(ready.assets.model, model);
    assert.equal(ready.assets.overview.image, overview);

    for (const path of [model, overview, face])
      assert.equal((await f.request(path)).statusCode, 200);
    assert.equal((await f.request(model, 'member', 'HEAD')).rawPayload.length, 0);
    const compressed = await f.request(model, 'member', 'GET', undefined, {
      'accept-encoding': 'br',
    });
    assert.equal(compressed.headers['content-encoding'], 'br');
    assert.equal((await f.request(model, 'other')).statusCode, 404);
    assert.equal(
      (await f.request(`/map-assets/packs/${id}/maps/de_mirage/desktop/scene.glb`)).statusCode,
      404,
    );
    assert.equal(
      (await f.request(`/api/map-packs/${id}/models/de_dust2/desktop/scene.glb`)).statusCode,
      404,
    );
    writeFileSync(
      f.catalog,
      JSON.stringify({
        schemaVersion: 1,
        entries: [approval, { ...approval, source: { ...approval.source, manifest: '123' } }],
      }),
    );
    assert.equal((await f.request()).json().resolution.status, 'ambiguous');
    for (const path of [model, overview, face])
      assert.equal((await f.request(path)).statusCode, 404);
    writeFileSync(f.catalog, JSON.stringify({ schemaVersion: 1, entries: [] }));
    for (const path of [model, overview, face])
      assert.equal((await f.request(path)).statusCode, 404);
  } finally {
    await f.close();
  }
});
test('approved pack paths reject symlinked pack ancestors and private instance gates discovery/model art', async () => {
  const f = await fixture(true, true);
  try {
    const id = mapPackId(approval),
      outside = join(f.directory, 'outside');
    install(join(outside, 'maps'));
    mkdirSync(join(f.maps, 'packs'));
    symlinkSync(outside, join(f.maps, 'packs', id));
    await enqueueMapRequest(f.jobs, approval);
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'ready',
      updatedAt: now(),
    });
    assert.equal((await f.request()).json().acquisition, 'processing');
    assert.equal((await f.request()).json().code, 'pack_invalid');
    const model = `/api/map-packs/${id}/models/de_mirage/desktop/scene.glb`;
    assert.equal((await f.request(model)).statusCode, 404);
    assert.equal((await f.request(model, '')).statusCode, 401);
    assert.equal((await f.request(undefined, '')).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('manual environment-only remnants remain unavailable with an entirely empty descriptor', async () => {
  const f = await fixture(false);
  try {
    install(f.maps);
    rmSync(join(f.maps, 'de_mirage', 'map.json'));
    rmSync(join(f.maps, 'overviews'), { recursive: true, force: true });
    const descriptor = (await f.request()).json();
    assert.equal(descriptor.verification, 'unavailable');
    assert.deepEqual(descriptor.assets, {
      model: null,
      mobile: null,
      overview: null,
      environment: null,
    });
  } finally {
    await f.close();
  }
});

test('owner POST retries transient acquisition once after cooldown while permanent source evidence failures remain terminal', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture();
  try {
    const id = mapPackId(approval);
    await enqueueMapRequest(f.jobs, approval);
    await writeMapWorkerStatus(f.jobs, { schemaVersion: 1, status: 'idle', updatedAt: now() });
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'failed',
      updatedAt: now() - 299,
      code: 'source_unavailable',
    });
    assert.equal((await f.request()).json().canAcquire, false);
    assert.equal((await f.request(undefined, 'member', 'POST', {})).json().acquisition, 'failed');
    t.mock.timers.tick(1000);
    assert.equal((await f.request()).json().canAcquire, true);
    assert.equal((await f.request(undefined, 'other', 'POST', {})).statusCode, 404);
    assert.equal(
      (await f.request(undefined, 'member', 'POST', { source: approval.source })).statusCode,
      400,
    );
    assert.equal(
      (await f.request(undefined, 'member', 'POST', { generation: 'a'.repeat(32) })).statusCode,
      400,
    );
    assert.equal(
      (await f.request(undefined, 'member', 'POST', {}, { 'x-csrf-token': 'bad' })).statusCode,
      403,
    );
    const retry = await f.request(undefined, 'member', 'POST', {});
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.json().acquisition, 'queued');
    assert.equal(retry.json().canAcquire, false);
    assert.equal((await f.request(undefined, 'member', 'POST', {})).json().acquisition, 'queued');
    for (const code of ['source_mismatch', 'approval_removed'] as const) {
      await writeMapJobResult(f.jobs, {
        schemaVersion: mapPreparerRevision,
        packId: id,
        status: 'failed',
        updatedAt: now() - 1000,
        code,
      });
      assert.equal((await f.request()).json().canAcquire, false);
      assert.equal((await f.request(undefined, 'member', 'POST', {})).json().code, code);
    }
    await writeMapJobResult(f.jobs, {
      schemaVersion: mapPreparerRevision,
      packId: id,
      status: 'failed',
      updatedAt: now() - 1000,
      code: 'storage_limit',
    });
    await writeMapWorkerStatus(f.jobs, {
      schemaVersion: 1,
      status: 'idle',
      updatedAt: now() - 100,
    });
    assert.equal((await f.request()).json().canAcquire, false);
  } finally {
    await f.close();
  }
});

test('application startup reclaims only recognized web temporary requests before admitting HTTP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cswatch-map-startup-')),
    root = join(directory, 'data'),
    jobs = join(directory, 'jobs');
  const db = new Store(root);
  initializeFixture(db);
  await prepareMapJobs(jobs);
  const temporary = join(jobs, 'requests', '.' + 'a'.repeat(64) + '-' + 'b'.repeat(24) + '.tmp'),
    operator = join(jobs, 'requests', 'operator-note.txt');
  writeFileSync(temporary, 'incomplete');
  writeFileSync(operator, 'preserved');
  let app;
  try {
    app = await createApp(
      loadConfig({
        DATA_DIR: root,
        MAP_JOBS_DIR: jobs,
        APP_URL: 'http://localhost:8000',
        COOKIE_SECURE: 'false',
      }),
      db,
    );
    assert.equal(existsSync(temporary), false);
    assert.equal(existsSync(operator), true);
    assert.equal(
      (await app.inject({ url: '/api/health', headers: { host: 'localhost:8000' } })).statusCode,
      200,
    );
  } finally {
    if (app) await app.close();
    else db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
