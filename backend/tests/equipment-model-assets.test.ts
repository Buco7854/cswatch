import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { COOKIE, digest } from '../src/security.js';
import { equipmentModelManifestSchema, validEquipmentGlb } from '../src/equipment-model-assets.js';
import { initializeFixture } from './fixtures/initialized.js';

process.env.LOG_LEVEL = 'silent';
const glb = (extra = {}) => {
  const value = JSON.stringify({ asset: { version: '2.0' }, name: 'Fixture', ...extra });
  const json = Buffer.from(value.padEnd(Math.ceil(value.length / 4) * 4, ' '));
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
};
const manifest = (bytes: Buffer) => ({
  schemaVersion: 2,
  id: 'ak47',
  coordinateSystem: 'weapon-meters-y-up-x-forward',
  assetVersion: 'Synthetic fixture v1',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  decodedTextureBytes: 0,
  geometryBytes: 0,
  bounds: { min: [0, 0, 0], max: [1, 0.2, 0.1] },
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cswatch-model-assets-')),
    root = join(directory, 'data');
  const db = new Store(root);
  initializeFixture(db);
  db.run('INSERT INTO users VALUES(?,?,?,?,?)', 'member', 'member', null, 0, now());
  db.run(
    'INSERT INTO sessions VALUES(?,?,?,?)',
    digest('models-session'),
    'member',
    'csrf',
    now() + 120,
  );
  db.run('INSERT INTO settings VALUES(?,?)', 'public_access', 0);
  const app = await createApp(
    loadConfig({
      DATA_DIR: root,
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      FRONTEND_DIR: join(directory, 'frontend'),
    }),
    db,
  );
  const pack = join(root, 'maps', 'equipment-models', 'ak47');
  mkdirSync(pack, { recursive: true });
  const data = glb();
  writeFileSync(join(pack, 'model.glb'), data);
  writeFileSync(join(pack, 'manifest.json'), JSON.stringify(manifest(data)));
  const headers = { host: 'localhost:8000', cookie: `${COOKIE}=models-session` };
  return {
    app,
    pack,
    data,
    root,
    headers,
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('first-person discovery admits only bounded current assets and shares the instance access policy', async () => {
  const s = await fixture();
  try {
    const catalog = '/api/assets/viewmodels';
    assert.equal(
      (await s.app.inject({ url: catalog, headers: { host: s.headers.host } })).statusCode,
      401,
    );
    assert.deepEqual((await s.app.inject({ url: catalog, headers: s.headers })).json().items, {});
    const directory = join(s.root, 'maps', 'presentation-v2', 'viewmodels', 'ak47');
    mkdirSync(directory, { recursive: true });
    const data = glb(),
      sha256 = createHash('sha256').update(data).digest('hex');
    const url = catalog + '/ak47/' + sha256 + '.glb';
    writeFileSync(join(directory, 'model.glb'), data);
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'ak47',
        manifest: '1',
        sha256,
        bytes: data.length,
        decodedGeometryBytes: 128,
        decodedTextureBytes: 32,
        actions: { draw: { seconds: 1, frames: 12, targets: 2 } },
      }),
    );
    assert.equal(
      (await s.app.inject({ url: catalog, headers: s.headers })).json().items.ak47.model,
      url,
    );
    assert.deepEqual((await s.app.inject({ url, headers: s.headers })).rawPayload, data);
    writeFileSync(join(directory, 'model.glb'), Buffer.alloc(data.length));
    assert.deepEqual((await s.app.inject({ url: catalog, headers: s.headers })).json().items, {});
    assert.equal((await s.app.inject({ url, headers: s.headers })).statusCode, 404);
  } finally {
    await s.close();
  }
});

test('equipment manifest and self-contained GLB bounds reject stale frames, unknown IDs and external resources', () => {
  assert.equal(validEquipmentGlb(glb()), true);
  for (const extra of [
    { buffers: [{ uri: 'https://example.com/asset.bin' }] },
    { images: [{ uri: '/api/private' }] },
    { extras: { uri: 'data:...' } },
  ])
    assert.equal(validEquipmentGlb(glb(extra)), false);
  const changed = glb();
  changed.writeUInt32LE(changed.length + 1, 8);
  assert.equal(validEquipmentGlb(changed), false);
  for (const change of [
    { id: 'arbitrary' },
    { bytes: 16777217 },
    { geometryBytes: 8388609 },
    { decodedTextureBytes: 16777217 },
    { bounds: { min: [-8, 0, 0], max: [8, 1, 1] } },
    { bounds: { min: [2, 0, 0], max: [1, 1, 1] } },
    { model: 'https://example.com/' },
    { schemaVersion: 1 },
  ])
    assert.equal(
      equipmentModelManifestSchema.safeParse({ ...manifest(glb()), ...change }).success,
      false,
    );
});

test('fixed discovery and binaries inherit private policy and cannot bypass validation through static paths', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          url: '/api/assets/equipment-models',
          headers: { host: 'localhost:8000' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: '/api/assets/equipment-models/ak47.glb',
          headers: { host: 'localhost:8000' },
        })
      ).statusCode,
      401,
    );
    const discovery = await f.app.inject({
      url: '/api/assets/equipment-models',
      headers: f.headers,
    });
    assert.equal(discovery.statusCode, 200);
    assert.equal(discovery.headers['cache-control'], 'private, no-store');
    assert.deepEqual(Object.keys(discovery.json().items), ['ak47']);
    assert.equal(discovery.json().items.ak47.model, '/api/assets/equipment-models/ak47.glb');
    assert.equal('id' in discovery.json().items.ak47, false);
    const requests = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.app.inject({ url: '/api/assets/equipment-models/ak47.glb', headers: f.headers }),
      ),
    );
    for (const response of requests) {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.rawPayload, f.data);
    }
    for (const url of [
      '/map-assets/equipment-models/ak47/model.glb',
      '/map-assets/equipment-models/ak47/manifest.json',
      '/api/assets/equipment-models/missing.glb',
      '/api/assets/equipment-models/%2e%2e.glb',
      '/api/assets/equipment-models/ak47%2fmodel.glb',
    ])
      assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('hash-bound models reject same-size replacement and stale manifest identity without timestamp assumptions', async () => {
  const f = await fixture();
  const request = () =>
    f.app.inject({ url: '/api/assets/equipment-models/ak47.glb', headers: f.headers });
  try {
    assert.equal((await request()).statusCode, 200);
    const modelPath = join(f.pack, 'model.glb');
    const different = Buffer.from(f.data);
    different.write('Changed', different.indexOf('Fixture'));
    assert.equal(different.length, f.data.length);
    writeFileSync(modelPath, different);
    assert.equal((await request()).statusCode, 404);
    writeFileSync(modelPath, f.data);
    assert.equal((await request()).statusCode, 200);
    const metadata = manifest(f.data);
    metadata.sha256 = '0'.repeat(64);
    writeFileSync(join(f.pack, 'manifest.json'), JSON.stringify(metadata));
    assert.equal((await request()).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('optional packs reject symlinks, hardlinks, directories and nonblocking special files', async () => {
  const f = await fixture();
  const request = () =>
    f.app.inject({ url: '/api/assets/equipment-models/ak47.glb', headers: f.headers });
  try {
    const path = join(f.pack, 'model.glb'),
      outside = join(f.root, 'original.glb');
    writeFileSync(outside, f.data);
    unlinkSync(path);
    symlinkSync(outside, path);
    assert.equal((await request()).statusCode, 404);
    unlinkSync(path);
    linkSync(outside, path);
    assert.equal((await request()).statusCode, 404);
    unlinkSync(path);
    mkdirSync(path);
    assert.equal((await request()).statusCode, 404);
    rmSync(path, { recursive: true });
    if (process.platform === 'linux') {
      const result = spawnSync('mkfifo', [path]);
      assert.equal(result.status, 0);
      assert.equal((await request()).statusCode, 404);
      unlinkSync(path);
    }
    writeFileSync(path, f.data);
    rmSync(f.pack, { recursive: true });
    symlinkSync(f.root, f.pack);
    assert.equal((await request()).statusCode, 404);
    assert.deepEqual(
      (await f.app.inject({ url: '/api/assets/equipment-models', headers: f.headers })).json()
        .items,
      {},
    );
  } finally {
    await f.close();
  }
});
