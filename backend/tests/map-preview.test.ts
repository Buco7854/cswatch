import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { COOKIE, digest } from '../src/security.js';
import { initializeFixture } from './fixtures/initialized.js';
import { mapPreviewLimits, validMapPreview } from '../src/map-preview.js';
process.env.LOG_LEVEL = 'silent';
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function chunk(kind: string, content: Buffer) {
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4),
    body = Buffer.concat([Buffer.from(kind), content]);
  length.writeUInt32BE(content.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function png(width = 8, height = 4, value = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, value);
  for (let i = 0; i < height; i++) raw[i * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function fixture(initialized = true) {
  const directory = mkdtempSync(join(tmpdir(), 'cswatch-preview-')),
    root = join(directory, 'data'),
    db = new Store(root);
  if (initialized) initializeFixture(db);
  db.run('INSERT INTO users VALUES(?,?,?,?,?)', 'member', 'member', null, 0, now());
  db.run(
    'INSERT INTO sessions VALUES(?,?,?,?)',
    digest('preview-session'),
    'member',
    'csrf',
    now() + 120,
  );
  const app = await createApp(
    loadConfig({ DATA_DIR: root, APP_URL: 'http://localhost:8000', COOKIE_SECURE: 'false' }),
    db,
  );
  const install = (map: string, bytes = png()) => {
    const pack = join(root, 'maps', 'previews', map);
    mkdirSync(pack, { recursive: true });
    const metadata = {
      schemaVersion: 1,
      map,
      assetVersion: 'Original synthetic preview',
      imageSha256: sha(bytes),
    };
    writeFileSync(join(pack, 'preview.png'), bytes);
    writeFileSync(join(pack, 'preview.json'), JSON.stringify(metadata));
    return { pack, metadata, bytes };
  };
  const get = (url = '/api/map-preview', member = false, method: 'GET' | 'HEAD' = 'GET') =>
    app.inject({
      method,
      url,
      headers: {
        host: 'localhost:8000',
        ...(member ? { cookie: `${COOKIE}=preview-session` } : {}),
      },
    });
  return {
    directory,
    root,
    app,
    db,
    install,
    get,
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('preview PNG boundary validates width, height, CRC, animation and bounded raster content', () => {
  assert.equal(validMapPreview(png()), true);
  assert.equal(validMapPreview(png(2560, 1440)), true);
  const corrupt = png();
  corrupt[40] ^= 1;
  for (const bytes of [
    png(2561, 1),
    png(1, 1441),
    Buffer.alloc(mapPreviewLimits.bytes + 1),
    Buffer.from('<svg/>'),
    corrupt,
    png().subarray(0, -1),
    Buffer.concat([png().subarray(0, 33), chunk('acTL', Buffer.alloc(8)), png().subarray(33)]),
  ])
    assert.equal(validMapPreview(bytes), false);
});

test('public discovery chooses the first valid fixed preview and preserves optional absence plus private/setup gating', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.get()).json(), { image: null, map: null });
    f.install('de_cache');
    f.install('de_dust2');
    assert.deepEqual((await f.get()).json(), {
      image: '/api/map-preview/de_dust2.png',
      map: 'de_dust2',
    });
    f.install('de_mirage');
    assert.deepEqual((await f.get()).json(), {
      image: '/api/map-preview/de_mirage.png',
      map: 'de_mirage',
    });
    f.db.run("INSERT INTO settings VALUES('public_access',0)");
    assert.equal((await f.get()).statusCode, 401);
    assert.equal((await f.get('/api/map-preview/de_mirage.png')).statusCode, 401);
    assert.equal((await f.get('/api/map-preview', true)).statusCode, 200);
  } finally {
    await f.close();
  }
  const unset = await fixture(false);
  try {
    unset.install('de_mirage');
    assert.equal((await unset.get()).statusCode, 503);
    assert.equal((await unset.get('/api/map-preview/de_mirage.png')).statusCode, 503);
  } finally {
    await unset.close();
  }
});

test('fixed PNG GET/HEAD are hash-bound and cache revalidation rejects same-size replacement or malformed metadata', async () => {
  const f = await fixture();
  try {
    const { pack, metadata, bytes } = f.install('de_mirage');
    const response = await f.get('/api/map-preview/de_mirage.png');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, bytes);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['content-type'], 'image/png');
    const head = await f.get('/api/map-preview/de_mirage.png', false, 'HEAD');
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), bytes.length);
    const changed = png(8, 4, 2);
    assert.equal(changed.length, bytes.length);
    writeFileSync(join(pack, 'preview.png'), changed);
    assert.equal((await f.get('/api/map-preview/de_mirage.png')).statusCode, 404);
    assert.deepEqual((await f.get()).json(), { image: null, map: null });
    writeFileSync(join(pack, 'preview.png'), bytes);
    for (const update of [
      { map: 'de_cache' },
      { imageSha256: '0'.repeat(64) },
      { image: 'https://example.test/image.png' },
      { assetVersion: '' },
      { schemaVersion: 2 },
    ]) {
      writeFileSync(join(pack, 'preview.json'), JSON.stringify({ ...metadata, ...update }));
      assert.equal((await f.get('/api/map-preview/de_mirage.png')).statusCode, 404);
    }
  } finally {
    await f.close();
  }
});

test('preview delivery rejects arbitrary names, direct static escape, links, hardlinks, FIFO and linked ancestors', async () => {
  const f = await fixture();
  try {
    const { pack, bytes } = f.install('de_mirage'),
      image = join(pack, 'preview.png'),
      outside = join(f.directory, 'outside.png');
    writeFileSync(outside, bytes);
    for (const url of [
      '/api/map-preview/unknown.png',
      '/api/map-preview/%2e%2e%2fsecret.png',
      '/api/map-preview/de_mirage.json',
      '/map-assets/previews/de_mirage/preview.png',
      '/map-assets/previews/desktop/scene.glb',
    ])
      assert.equal((await f.get(url)).statusCode, 404);
    for (const mutation of [
      () => symlinkSync(outside, image),
      () => linkSync(outside, image),
      () => assert.equal(spawnSync('mkfifo', [image]).status, 0),
    ]) {
      rmSync(image);
      mutation();
      assert.equal((await f.get('/api/map-preview/de_mirage.png')).statusCode, 404);
      rmSync(image);
      writeFileSync(image, bytes);
    }
    renameSync(pack, pack + '-real');
    symlinkSync(pack + '-real', pack);
    assert.equal((await f.get('/api/map-preview/de_mirage.png')).statusCode, 404);
    rmSync(pack);
    renameSync(pack + '-real', pack);
    const previews = join(f.root, 'maps', 'previews');
    renameSync(previews, previews + '-real');
    symlinkSync(previews + '-real', previews);
    assert.equal((await f.get('/api/map-preview/de_mirage.png')).statusCode, 404);
  } finally {
    await f.close();
  }
});
