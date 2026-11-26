import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { initializeFixture } from './fixtures/initialized.js';
import { managedEffectDirectory } from '../../shared/effect-texture-bank.mjs';

process.env.LOG_LEVEL = 'silent';
const crc = (bytes: Buffer) => {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** An original RGBA PNG of the given size. */
function png(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cswatch-effect-assets-')),
    root = join(directory, 'data');
  const db = new Store(root);
  initializeFixture(db);
  db.run(
    'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
    'member',
    'member',
    null,
    'member',
    now(),
  );
  insertFixtureSession(db, 'effects-session', 'member', 'csrf', now() + 120);
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
  const item = join(root, 'maps', managedEffectDirectory, 'effects', 'fire-glow');
  mkdirSync(item, { recursive: true });
  const data = png(16, 16);
  writeFileSync(join(item, 'atlas.png'), data);
  const manifest = {
    schemaVersion: 1,
    id: 'fire-glow',
    width: 16,
    height: 16,
    cell: 16,
    columns: 1,
    sequences: [{ start: 0, count: 1, clamp: true }],
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
  };
  writeFileSync(join(item, 'manifest.json'), JSON.stringify(manifest));
  const headers = { host: 'localhost:8000', cookie: fixtureCookie('effects-session') };
  return {
    app,
    item,
    data,
    manifest,
    headers,
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('effect atlases are private, registry-bound and hash-checked on every read', async () => {
  const s = await fixture();
  try {
    const catalog = '/api/effect-assets';
    assert.equal(
      (await s.app.inject({ url: catalog, headers: { host: s.headers.host } })).statusCode,
      401,
    );
    const listed = (await s.app.inject({ url: catalog, headers: s.headers })).json().items;
    assert.deepEqual(Object.keys(listed), ['fire-glow']);
    assert.equal(listed['fire-glow'].url, '/api/effect-assets/fire-glow.png');
    assert.deepEqual(listed['fire-glow'].sequences, [{ start: 0, count: 1, clamp: true }]);
    const payload = await s.app.inject({ url: listed['fire-glow'].url, headers: s.headers });
    assert.equal(payload.statusCode, 200);
    assert.deepEqual(payload.rawPayload, s.data);
    // Unknown names and traversal never reach the file system.
    for (const name of ['unknown.png', '..%2Ffire-glow.png', 'fire-glow.jpg'])
      assert.equal(
        (await s.app.inject({ url: `/api/effect-assets/${name}`, headers: s.headers })).statusCode,
        404,
      );
    // A same-size replacement fails its recorded hash.
    const tampered = Buffer.from(s.data);
    tampered[tampered.length - 20] ^= 1;
    writeFileSync(join(s.item, 'atlas.png'), tampered);
    assert.equal(
      (await s.app.inject({ url: listed['fire-glow'].url, headers: s.headers })).statusCode,
      404,
    );
    // A manifest whose grid cannot hold its frames is not admitted.
    writeFileSync(join(s.item, 'atlas.png'), s.data);
    writeFileSync(
      join(s.item, 'manifest.json'),
      JSON.stringify({ ...s.manifest, sequences: [{ start: 0, count: 2, clamp: true }] }),
    );
    assert.deepEqual((await s.app.inject({ url: catalog, headers: s.headers })).json().items, {});
  } finally {
    await s.close();
  }
});
