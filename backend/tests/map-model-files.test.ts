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
  unlinkSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { Readable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import Fastify from 'fastify';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { COOKIE, digest } from '../src/security.js';
import { mapModelBytes, mapModelFileRoutes } from '../src/map-model-files.js';
import { fileDigest } from '../src/asset-content.js';
import { initializeFixture } from './fixtures/initialized.js';
process.env.LOG_LEVEL = 'silent';
function glb(name = 'Fixture') {
  const text = JSON.stringify({ asset: { version: '2.0' }, name });
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' ')),
    header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-model-files-')),
    root = join(folder, 'data');
  const db = new Store(root);
  initializeFixture(db);
  db.run('INSERT INTO users VALUES(?,?,?,?,?)', 'member', 'member', null, 0, now());
  db.run(
    'INSERT INTO sessions VALUES(?,?,?,?)',
    digest('model-file-session'),
    'member',
    'csrf',
    now() + 120,
  );
  db.run('INSERT INTO settings VALUES(?,?)', 'public_access', 0);
  const app = await createApp(
    loadConfig({ DATA_DIR: root, APP_URL: 'http://localhost:8000', COOKIE_SECURE: 'false' }),
    db,
  );
  const pack = join(root, 'maps', 'de_fixture', 'desktop');
  mkdirSync(pack, { recursive: true });
  const bytes = glb(),
    path = join(pack, 'scene.glb');
  writeFileSync(path, bytes);
  const get = (
    url = '/map-assets/de_fixture/desktop/scene.glb',
    headers: Record<string, string> = {},
    method: 'GET' | 'HEAD' = 'GET',
    member = true,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: 'localhost:8000',
        ...(member ? { cookie: `${COOKIE}=model-file-session` } : {}),
        ...headers,
      },
    });
  return {
    folder,
    root,
    db,
    app,
    pack,
    path,
    bytes,
    get,
    async close() {
      await app.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('fixed map tiers and team agents stream bounded GLBs behind instance policy and reject arbitrary static paths', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get(undefined, {}, 'GET', false)).statusCode, 401);
    const result = await f.get();
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.rawPayload, f.bytes);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.equal(result.headers['content-type'], 'model/gltf-binary');
    mkdirSync(join(f.root, 'maps', 'de_fixture', 'mobile'));
    writeFileSync(join(f.root, 'maps', 'de_fixture', 'mobile', 'scene.glb'), f.bytes);
    mkdirSync(join(f.root, 'maps', 'de_fixture', 'compact'));
    writeFileSync(join(f.root, 'maps', 'de_fixture', 'compact', 'scene.glb'), f.bytes);
    assert.equal(
      (await f.get('/map-assets/de_fixture/compact/scene.glb', {}, 'GET', false)).statusCode,
      401,
    );
    mkdirSync(join(f.root, 'maps', 'agents'));
    writeFileSync(join(f.root, 'maps', 'agents', 'ct.glb'), f.bytes);
    writeFileSync(join(f.root, 'maps', 'agents', 't.glb'), f.bytes);
    for (const url of [
      '/map-assets/de_fixture/mobile/scene.glb',
      '/map-assets/de_fixture/compact/scene.glb',
      '/map-assets/agents/ct.glb',
      '/map-assets/agents/t.glb',
    ])
      assert.equal((await f.get(url)).statusCode, 200);
    // Encoded separators reach the route without URL clients normalizing away the traversal segment.
    for (const url of [
      '/map-assets/de_fixture.glb',
      '/map-assets/de_fixture/desktop/manifest.json',
      '/map-assets/de_fixture/compact/manifest.json',
      '/map-assets/de_fixture/desktop/other.glb',
      '/map-assets/agents/other.glb',
      '/map-assets/de_fixture/desktop/scene.gltf',
      '/map-assets/de_fixture/desktop/source.bin',
      '/map-assets/overviews/desktop/scene.glb',
      '/map-assets/equipment-models/desktop/scene.glb',
      '/map-assets/..%2freplay.db',
      '/map-assets/%2e%2e%2freplay.db',
    ])
      assert.equal((await f.get(url)).statusCode, 404, url);
  } finally {
    await f.close();
  }
});

test('HEAD, byte ranges and fresh content ETags preserve model delivery without full-buffer allocation', async () => {
  const f = await fixture();
  try {
    const whole = await f.get(),
      etag = String(whole.headers.etag);
    const head = await f.get(undefined, {}, 'HEAD');
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), f.bytes.length);
    assert.equal(head.headers.etag, etag);
    const partial = await f.get(undefined, { range: 'bytes=0-19' });
    assert.equal(partial.statusCode, 206);
    assert.deepEqual(partial.rawPayload, f.bytes.subarray(0, 20));
    assert.equal(partial.headers['content-range'], `bytes 0-19/${f.bytes.length}`);
    const suffix = await f.get(undefined, { range: 'bytes=-8' });
    assert.equal(suffix.statusCode, 206);
    assert.deepEqual(suffix.rawPayload, f.bytes.subarray(-8));
    const open = await f.get(undefined, { range: 'bytes=20-' });
    assert.deepEqual(open.rawPayload, f.bytes.subarray(20));
    assert.equal(
      (await f.get(undefined, { range: 'bytes=0-19', 'if-range': etag })).statusCode,
      206,
    );
    assert.equal(
      (await f.get(undefined, { range: 'bytes=0-19', 'if-range': '"another-version"' })).statusCode,
      200,
    );
    assert.equal((await f.get(undefined, { 'if-none-match': etag })).statusCode, 304);
    assert.equal((await f.get(undefined, { 'if-none-match': `W/${etag}` })).statusCode, 304);
    const invalid = await f.get(undefined, { range: `bytes=${f.bytes.length}-` });
    assert.equal(invalid.statusCode, 416);
    assert.equal(invalid.headers['content-range'], `bytes */${f.bytes.length}`);
    const changed = glb('Changed');
    assert.equal(changed.length, f.bytes.length);
    writeFileSync(f.path, changed);
    const fresh = await f.get(undefined, { 'if-none-match': etag });
    assert.equal(fresh.statusCode, 200);
    assert.notEqual(fresh.headers.etag, etag);
    assert.deepEqual(fresh.rawPayload, changed);
  } finally {
    await f.close();
  }
});

test('direct model paths refuse private-file symlinks, hardlinks, special files and oversized or malformed GLBs', async () => {
  const f = await fixture();
  try {
    const secret = join(f.folder, 'private.glb');
    writeFileSync(secret, glb('Original synthetic private content'));
    unlinkSync(f.path);
    symlinkSync(secret, f.path);
    assert.equal((await f.get()).statusCode, 404);
    unlinkSync(f.path);
    linkSync(secret, f.path);
    assert.equal((await f.get()).statusCode, 404);
    unlinkSync(f.path);
    assert.equal(spawnSync('mkfifo', [f.path]).status, 0);
    assert.equal((await f.get()).statusCode, 404);
    unlinkSync(f.path);
    mkdirSync(f.path);
    assert.equal((await f.get()).statusCode, 404);
    rmSync(f.path, { recursive: true });
    writeFileSync(f.path, f.bytes);
    truncateSync(f.path, mapModelBytes + 1);
    assert.equal((await f.get()).statusCode, 404);
    writeFileSync(f.path, Buffer.from('Not a GLB'));
    assert.equal((await f.get()).statusCode, 404);
    writeFileSync(f.path, f.bytes);
    const wrong = Buffer.from(f.bytes);
    wrong.writeUInt32LE(wrong.length + 4, 8);
    writeFileSync(f.path, wrong);
    assert.equal((await f.get()).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('model and agent delivery refuse symlinked directories at every maps ancestor', async () => {
  const f = await fixture();
  try {
    renameSync(f.pack, f.pack + '-real');
    symlinkSync(f.pack + '-real', f.pack);
    assert.equal((await f.get()).statusCode, 404);
    unlinkSync(f.pack);
    renameSync(f.pack + '-real', f.pack);
    const map = join(f.root, 'maps', 'de_fixture');
    renameSync(map, map + '-real');
    symlinkSync(map + '-real', map);
    assert.equal((await f.get()).statusCode, 404);
    unlinkSync(map);
    renameSync(map + '-real', map);
    const maps = join(f.root, 'maps');
    renameSync(maps, maps + '-real');
    symlinkSync(maps + '-real', maps);
    assert.equal((await f.get()).statusCode, 404);
    unlinkSync(maps);
    renameSync(maps + '-real', maps);
    mkdirSync(join(maps, 'real-agents'));
    writeFileSync(join(maps, 'real-agents', 'ct.glb'), f.bytes);
    symlinkSync(join(maps, 'real-agents'), join(maps, 'agents'));
    assert.equal((await f.get('/map-assets/agents/ct.glb')).statusCode, 404);
  } finally {
    await f.close();
  }
});

test(
  'disconnect during model hashing aborts the digest and closes its FD before any stream transfer',
  { timeout: 5000 },
  async () => {
    const f = await fixture(),
      app = Fastify({ logger: false });
    const entered = Promise.withResolvers<void>(),
      closed = Promise.withResolvers<void>(),
      interrupted = Promise.withResolvers<void>();
    let captured: FileHandle | undefined,
      streamed = false;
    try {
      await mapModelFileRoutes(app, f.root, {
        digest: async (file, _maximum, signal) => {
          captured = file;
          file.once('close', closed.resolve);
          const original = file.createReadStream.bind(file);
          file.createReadStream = (...args) => {
            streamed = true;
            return original(...args);
          };
          entered.resolve();
          assert.ok(signal);
          await new Promise<void>((_resolve, reject) => {
            const abort = () => {
              interrupted.resolve();
              reject(new Error('Original gated digest aborted'));
            };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
          throw new Error('Gated digest may never succeed');
        },
      });
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      const request = httpGet(url + '/map-assets/de_fixture/desktop/scene.glb');
      const disconnected = new Promise<void>((done) => request.once('error', () => done()));
      await entered.promise;
      request.destroy();
      await Promise.all([disconnected, interrupted.promise, closed.promise]);
      assert.equal(captured?.fd, -1);
      assert.equal(streamed, false);
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  'a synchronous send failure destroys the new stream and closes its transferred FD',
  { timeout: 5000 },
  async () => {
    const f = await fixture(),
      app = Fastify({ logger: false }),
      closed = Promise.withResolvers<void>();
    let captured: FileHandle | undefined;
    try {
      app.addHook('onRequest', async (_request, reply) => {
        const send = reply.send.bind(reply);
        reply.send = ((payload) => {
          if (payload instanceof Readable) throw new Error('Original synchronous send fixture');
          return send(payload);
        }) as typeof reply.send;
      });
      await mapModelFileRoutes(app, f.root, {
        digest: async (file, maximum, signal) => {
          captured = file;
          file.once('close', closed.resolve);
          return fileDigest(file, maximum, signal);
        },
      });
      const response = await app.inject('/map-assets/de_fixture/desktop/scene.glb');
      assert.equal(response.statusCode, 500);
      await closed.promise;
      assert.equal(captured?.fd, -1);
    } finally {
      await app.close();
      await f.close();
    }
  },
);
