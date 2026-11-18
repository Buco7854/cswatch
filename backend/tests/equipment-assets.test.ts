import { initializeFixture } from './fixtures/initialized.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createApp } from '../src/server.js';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { COOKIE, digest } from '../src/security.js';
import {
  equipmentIconKeys,
  equipmentIconLimits,
  validEquipmentPng,
} from '../src/equipment-assets.js';

process.env.LOG_LEVEL = 'silent';

function chunk(kind: string, content: Buffer) {
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4),
    body = Buffer.concat([Buffer.from(kind), content]);
  length.writeUInt32BE(content.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function png(width = 1, height = 1, value = 255) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, value, value, value, value]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('equipment cache verifies bytes after rapid same-size replacement and never returns stale or corrupt artwork', async () => {
  const s = await setup();
  try {
    mkdirSync(s.pack);
    const path = join(s.pack, 'ak47.png'),
      first = png(1, 1, 1),
      second = png(1, 1, 2);
    assert.equal(first.length, second.length);
    writeFileSync(path, first);
    assert.deepEqual((await s.get('/api/assets/equipment/ak47.png')).rawPayload, first);
    writeFileSync(path, second);
    assert.deepEqual((await s.get('/api/assets/equipment/ak47.png')).rawPayload, second);
    const corrupt = Buffer.from(second);
    corrupt[40] ^= 1;
    writeFileSync(path, corrupt);
    assert.equal((await s.get('/api/assets/equipment/ak47.png')).statusCode, 404);
    writeFileSync(path, first);
    assert.deepEqual((await s.get('/api/assets/equipment/ak47.png')).rawPayload, first);
  } finally {
    await s.close();
  }
});
async function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-equipment-')),
    root = join(folder, 'data'),
    pack = join(root, 'maps', 'equipment');
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    PUBLIC_ACCESS: '',
  });
  const db = new Store(root);
  initializeFixture(db);
  db.run('INSERT INTO users VALUES(?,?,?,?,?)', 'member', 'member', null, 0, now());
  db.run(
    'INSERT INTO sessions VALUES(?,?,?,?)',
    digest('equipment-test-session'),
    'member',
    'csrf-test',
    now() + 120,
  );
  db.run('INSERT INTO settings VALUES(?,?)', 'public_access', 0);
  const app = await createApp(config, db);
  const get = (url: string, signedIn = true, method: 'GET' | 'HEAD' = 'GET') =>
    app.inject({
      method,
      url,
      headers: {
        host: 'localhost:8000',
        ...(signedIn ? { cookie: `${COOKIE}=equipment-test-session` } : {}),
      },
    });
  return {
    app,
    db,
    root,
    pack,
    folder,
    get,
    close: async () => {
      await app.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('equipment raster validation bounds PNG structure and the runtime whitelist matches the operator registry', () => {
  const registry = JSON.parse(
    readFileSync(new URL('../../shared/equipment-icons.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual([...equipmentIconKeys].sort(), Object.keys(registry.items).sort());
  assert.equal(new Set(equipmentIconKeys).size, equipmentIconKeys.length);
  assert.equal(validEquipmentPng(png()), true);
  assert.equal(validEquipmentPng(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), false);
  assert.equal(validEquipmentPng(png(0)), false);
  assert.equal(validEquipmentPng(png(2049)), false);
  assert.equal(validEquipmentPng(png(2048, 2048)), false);
  assert.equal(validEquipmentPng(Buffer.alloc(equipmentIconLimits.bytes + 1)), false);
  assert.equal(validEquipmentPng(png().subarray(0, -1)), false);
  assert.equal(validEquipmentPng(Buffer.concat([png(), Buffer.from('extra')])), false);
  const corrupt = png();
  corrupt[40] ^= 1;
  assert.equal(validEquipmentPng(corrupt), false);
  const animated = png();
  assert.equal(
    validEquipmentPng(
      Buffer.concat([
        animated.subarray(0, 33),
        chunk('acTL', Buffer.alloc(8)),
        animated.subarray(33),
      ]),
    ),
    false,
  );
});

test('equipment discovery and images honor private/public policy and expose only fixed validated PNGs', async () => {
  const s = await setup();
  try {
    assert.equal((await s.get('/api/assets/equipment', false)).statusCode, 401);
    assert.equal((await s.get('/api/assets/equipment/ak47.png', false, 'HEAD')).statusCode, 401);
    assert.deepEqual((await s.get('/api/assets/equipment')).json(), { icons: {} });
    mkdirSync(s.pack);
    const image = png();
    writeFileSync(join(s.pack, 'ak47.png'), image);
    writeFileSync(join(s.pack, 'awp.png'), Buffer.from('<svg>wrong type</svg>'));
    writeFileSync(join(s.pack, 'arbitrary.png'), image);
    writeFileSync(join(s.pack, 'provenance.json'), '{"operator":"private metadata"}');
    const metadata = await s.get('/api/assets/equipment');
    assert.equal(metadata.statusCode, 200);
    assert.deepEqual(metadata.json(), { icons: { ak47: '/api/assets/equipment/ak47.png' } });
    assert.equal(metadata.headers['cache-control'], 'no-store');
    const asset = await s.get('/api/assets/equipment/ak47.png');
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['content-type'], 'image/png');
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    assert.equal(asset.headers['cache-control'], 'no-store');
    assert.deepEqual(asset.rawPayload, image);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/assets/equipment/ak47.png',
          headers: {
            host: 'localhost:8000',
            origin: 'http://localhost:8000',
            cookie: `${COOKIE}=equipment-test-session`,
            'x-csrf-token': 'csrf-test',
          },
          payload: { artwork: 'Cannot upload through a discovery route.' },
        })
      ).statusCode,
      404,
    );
    assert.deepEqual(readFileSync(join(s.pack, 'ak47.png')), image);
    assert.equal(
      (await s.get('/api/assets/equipment/ak47.png', true, 'HEAD')).rawPayload.length,
      0,
    );
    for (const path of [
      'arbitrary.png',
      'awp.png',
      'ak47.svg',
      'AK47.png',
      'provenance.json',
      '%2e%2e%2freplay.db',
      '%252e%252e%252freplay.db',
      'https%3a%2f%2fexample.com.png',
    ])
      assert.equal((await s.get('/api/assets/equipment/' + path)).statusCode, 404, path);
    // The generic operator map mount cannot bypass this equipment-specific boundary.
    for (const path of ['ak47.png', 'awp.png', 'arbitrary.png', 'provenance.json'])
      assert.equal((await s.get('/map-assets/equipment/' + path)).statusCode, 404, path);
    s.db.run('UPDATE settings SET value=1 WHERE key=?', 'public_access');
    assert.equal((await s.get('/api/assets/equipment', false)).statusCode, 200);
    assert.equal((await s.get('/api/assets/equipment/ak47.png', false)).statusCode, 200);
    s.db.run('UPDATE settings SET value=0 WHERE key=?', 'public_access');
    assert.equal(
      (await s.get('/api/assets/equipment/ak47.png', false)).statusCode,
      401,
      'cached artwork cannot bypass changed privacy policy',
    );
  } finally {
    await s.close();
  }
});

test('equipment opens reject symlinked ancestors/files, hardlinks and oversized artifacts without reading arbitrary paths', async () => {
  const s = await setup();
  try {
    const outside = join(s.folder, 'outside');
    mkdirSync(outside);
    const image = png();
    writeFileSync(join(outside, 'ak47.png'), image);
    symlinkSync(outside, s.pack, 'dir');
    assert.deepEqual((await s.get('/api/assets/equipment')).json(), { icons: {} });
    assert.equal((await s.get('/api/assets/equipment/ak47.png')).statusCode, 404);
    rmSync(s.pack);
    mkdirSync(s.pack);
    symlinkSync(join(outside, 'ak47.png'), join(s.pack, 'ak47.png'));
    linkSync(join(outside, 'ak47.png'), join(s.pack, 'awp.png'));
    writeFileSync(join(s.pack, 'm4a1.png'), Buffer.alloc(equipmentIconLimits.bytes + 1));
    mkdirSync(join(s.pack, 'c4.png'));
    assert.deepEqual((await s.get('/api/assets/equipment')).json(), { icons: {} });
    for (const key of ['ak47', 'awp', 'm4a1', 'c4'])
      assert.equal((await s.get('/api/assets/equipment/' + key + '.png')).statusCode, 404, key);
    rmSync(join(s.pack, 'ak47.png'));
    writeFileSync(join(s.pack, 'ak47.png'), image);
    assert.equal((await s.get('/api/assets/equipment/ak47.png')).statusCode, 200);
    rmSync(join(s.pack, 'ak47.png'));
    symlinkSync(join(outside, 'ak47.png'), join(s.pack, 'ak47.png'));
    assert.equal(
      (await s.get('/api/assets/equipment/ak47.png')).statusCode,
      404,
      'a cached valid image cannot authorize a replacement symlink',
    );
    renameSync(join(s.root, 'maps'), join(s.root, 'maps-original'));
    symlinkSync(outside, join(s.root, 'maps'), 'dir');
    assert.deepEqual((await s.get('/api/assets/equipment')).json(), { icons: {} });
  } finally {
    await s.close();
  }
});
