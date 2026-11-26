import { modelResourceId } from '../../shared/model-resource-id.mjs';
import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';
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
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { overviewLimits, validOverviewPng } from '../src/map-assets.js';
import { initializeFixture } from './fixtures/initialized.js';
import { writeNativeWorld, vertexFile } from '../../tools/assets/fixtures/native-world.mjs';

process.env.LOG_LEVEL = 'silent';
function chunk(kind: string, content: Buffer) {
  const size = Buffer.alloc(4),
    checksum = Buffer.alloc(4),
    bytes = Buffer.concat([Buffer.from(kind), content]);
  size.writeUInt32BE(content.length);
  checksum.writeUInt32BE(crc32(bytes));
  return Buffer.concat([size, bytes, checksum]);
}
function png(width = 8, height = width, value = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, value);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function glb() {
  const text = JSON.stringify({ asset: { version: '2.0' } });
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' ')),
    header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}
const metadata = (image: Buffer) => ({
  schemaVersion: 1,
  map: 'de_fixture',
  origin: { x: -2500, y: 3000 },
  scale: 5,
  referenceSize: 1024,
  assetVersion: 'Original synthetic test artwork',
  imageSha256: createHash('sha256').update(image).digest('hex'),
});
async function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-map-assets-')),
    root = join(folder, 'data'),
    pack = join(root, 'maps', 'overviews', 'de_fixture');
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
  insertFixtureSession(db, 'map-assets-session', 'member', 'csrf-test', now() + 120);
  db.run('INSERT INTO settings VALUES(?,?)', 'public_access', 0);
  const app = await createApp(
    loadConfig({
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      DATA_DIR: root,
      PUBLIC_ACCESS: '',
    }),
    db,
  );
  const get = (path: string, member = true, method: 'GET' | 'HEAD' = 'GET') =>
    app.inject({
      method,
      url: path,
      headers: {
        host: 'localhost:8000',
        ...(member ? { cookie: fixtureCookie('map-assets-session') } : {}),
      },
    });
  const install = (image = png()) => {
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'overview.png'), image);
    writeFileSync(join(pack, 'overview.json'), JSON.stringify(metadata(image)));
    return image;
  };
  return {
    folder,
    root,
    pack,
    app,
    db,
    get,
    install,
    close: async () => {
      await app.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('manual artwork is withheld when access changes before the response is sent', async () => {
  const s = await setup();
  try {
    s.install();
    const flag = s.db.flag.bind(s.db);
    let reads = 0;
    s.db.flag = (config, key) => {
      if (key === 'public_access') return ++reads === 1;
      return flag(config, key);
    };
    for (const path of ['/api/maps/de_fixture/overview.png', '/api/map-preview']) {
      reads = 0;
      const response = await s.get(path, false);
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.headers.etag, undefined);
      assert.match(response.headers['content-type'] as string, /json/);
    }
  } finally {
    await s.close();
  }
});

test('overview PNG validation rejects non-raster, animation, corrupt, non-square and oversized files', () => {
  assert.equal(validOverviewPng(png()), true);
  assert.equal(validOverviewPng(png(2048)), true);
  for (const image of [
    Buffer.from('<svg/>'),
    png(8, 4),
    png(2049),
    Buffer.alloc(overviewLimits.bytes + 1),
    png().subarray(0, -1),
    Buffer.concat([png(), Buffer.from('tail')]),
  ])
    assert.equal(validOverviewPng(image), false);
  const bad = png();
  bad[40] ^= 1;
  assert.equal(validOverviewPng(bad), false);
  assert.equal(
    validOverviewPng(
      Buffer.concat([png().subarray(0, 33), chunk('acTL', Buffer.alloc(8)), png().subarray(33)]),
    ),
    false,
  );
});

test('local map discovery and overview images share private policy, fixed paths and no-store behavior', async () => {
  const s = await setup();
  try {
    assert.equal((await s.get('/api/maps/de_fixture', false)).statusCode, 401);
    assert.equal((await s.get('/api/maps/de_fixture/overview.png', false, 'HEAD')).statusCode, 401);
    assert.deepEqual((await s.get('/api/maps/de_fixture')).json(), {
      model: null,
      overview: null,
    });
    const image = s.install();
    const overview = {
      image: '/api/maps/de_fixture/overview.png',
      origin: { x: -2500, y: 3000 },
      scale: 5,
      referenceSize: 1024,
      assetVersion: 'Original synthetic test artwork',
    };
    const info = await s.get('/api/maps/de_fixture');
    assert.deepEqual(info.json(), { model: null, overview });
    assert.equal(info.headers['cache-control'], 'private, no-store');
    const response = await s.get(overview.image);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.rawPayload, image);
    assert.equal((await s.get(overview.image, true, 'HEAD')).rawPayload.length, 0);
    for (const path of ['overview.png', 'overview.json', 'provenance.json'])
      assert.equal((await s.get('/map-assets/overviews/de_fixture/' + path)).statusCode, 404);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: overview.image,
          headers: {
            host: 'localhost:8000',
            origin: 'http://localhost:8000',
            cookie: fixtureCookie('map-assets-session'),
            'x-csrf-token': 'csrf-test',
          },
          payload: { image: 'Not an upload endpoint.' },
        })
      ).statusCode,
      404,
    );
    s.db.run('UPDATE settings SET value=1 WHERE key=?', 'public_access');
    assert.equal((await s.get(overview.image, false)).statusCode, 200);
    s.db.run('UPDATE settings SET value=0 WHERE key=?', 'public_access');
    assert.equal((await s.get(overview.image, false)).statusCode, 401);
    assert.deepEqual(readFileSync(join(s.pack, 'overview.png')), image);
  } finally {
    await s.close();
  }
});

test('overview calibration is bounded, exact, hash-bound and rejects remote or layered metadata', async () => {
  const s = await setup();
  try {
    const image = s.install(),
      original = metadata(image);
    for (const invalid of [
      { ...original, scale: 0 },
      { ...original, scale: 0.0001 },
      { ...original, scale: 10001 },
      { ...original, scale: '5' },
      { ...original, origin: { x: 1e7 + 1, y: 0 } },
      { ...original, referenceSize: 2048 },
      { ...original, map: 'de_other' },
      { ...original, assetVersion: '' },
      { ...original, assetVersion: 'a'.repeat(101) },
      { ...original, imageSha256: '0'.repeat(64) },
      { ...original, image: 'https://outside.invalid/radar.png' },
      { ...original, rotate: 1 },
      { ...original, layers: [] },
    ]) {
      writeFileSync(join(s.pack, 'overview.json'), JSON.stringify(invalid));
      assert.equal((await s.get('/api/maps/de_fixture')).json().overview, null);
      assert.equal((await s.get('/api/maps/de_fixture/overview.png')).statusCode, 404);
    }
    writeFileSync(join(s.pack, 'overview.json'), Buffer.alloc(overviewLimits.metadataBytes + 1));
    assert.equal((await s.get('/api/maps/de_fixture')).json().overview, null);
    writeFileSync(join(s.pack, 'overview.json'), JSON.stringify(original));
    assert.ok((await s.get('/api/maps/de_fixture')).json().overview);
    const replacement = {
      ...original,
      assetVersion: 'A new checked calibration',
      origin: { x: -2300, y: 3100 },
    };
    writeFileSync(join(s.pack, 'next.json'), JSON.stringify(replacement));
    renameSync(join(s.pack, 'next.json'), join(s.pack, 'overview.json'));
    assert.equal((await s.get('/api/maps/de_fixture')).json().overview.origin.x, -2300);
  } finally {
    await s.close();
  }
});

test('overview descriptor opens reject links, special files and changed cached assets', async () => {
  const s = await setup();
  try {
    const image = s.install(png(8, 8, 1)),
      outside = join(s.folder, 'outside.png');
    writeFileSync(outside, image);
    assert.equal((await s.get('/api/maps/de_fixture/overview.png')).statusCode, 200);
    const changed = png(8, 8, 100);
    assert.equal(changed.length, image.length, 'Exercise replacement without a size change.');
    writeFileSync(join(s.pack, 'overview.png'), changed);
    assert.equal((await s.get('/api/maps/de_fixture/overview.png')).statusCode, 404);
    writeFileSync(join(s.pack, 'overview.png'), image);
    assert.equal((await s.get('/api/maps/de_fixture/overview.png')).statusCode, 200);
    rmSync(join(s.pack, 'overview.png'));
    symlinkSync(outside, join(s.pack, 'overview.png'));
    assert.equal((await s.get('/api/maps/de_fixture/overview.png')).statusCode, 404);
    rmSync(join(s.pack, 'overview.png'));
    linkSync(outside, join(s.pack, 'overview.png'));
    assert.equal((await s.get('/api/maps/de_fixture/overview.png')).statusCode, 404);
    rmSync(join(s.pack, 'overview.png'));
    assert.equal(spawnSync('mkfifo', [join(s.pack, 'overview.png')]).status, 0);
    assert.equal((await s.get('/api/maps/de_fixture/overview.png')).statusCode, 404);
    rmSync(join(s.pack, 'overview.png'));
    writeFileSync(join(s.pack, 'overview.png'), image);
    renameSync(join(s.root, 'maps', 'overviews'), join(s.root, 'maps', 'overviews-original'));
    symlinkSync(
      join(s.root, 'maps', 'overviews-original'),
      join(s.root, 'maps', 'overviews'),
      'dir',
    );
    assert.equal((await s.get('/api/maps/de_fixture')).json().overview, null);
  } finally {
    await s.close();
  }
});

test('recorded official agents are listed and served only by catalogue handle', async () => {
  const s = await setup();
  try {
    const maps = join(s.root, 'maps');
    const handle = modelResourceId('characters/models/ctm_fbi/ctm_fbi_varianta.vmdl');
    const sas = modelResourceId('characters/models/ctm_sas/ctm_sas.vmdl');
    for (const name of [handle, sas, 'ctm_fbi_varianta', '12345'])
      mkdirSync(join(maps, 'agent-models', name), { recursive: true });
    writeFileSync(join(maps, 'agent-models', handle, 'model.glb'), glb());
    // The team default and unknown names are never advertised or served.
    writeFileSync(join(maps, 'agent-models', sas, 'model.glb'), glb());
    writeFileSync(join(maps, 'agent-models', '12345', 'model.glb'), glb());
    assert.deepEqual((await s.get('/api/assets/agents')).json().models, {
      [handle]: `/map-assets/agent-models/${handle}.glb`,
    });
    assert.equal((await s.get(`/map-assets/agent-models/${handle}.glb`)).statusCode, 200);
    for (const name of [sas, '12345', 'ctm_fbi_varianta', `${handle}/model`])
      assert.equal((await s.get(`/map-assets/agent-models/${name}.glb`)).statusCode, 404);
    writeFileSync(join(maps, 'agent-models', handle, 'model.glb'), Buffer.from('Not a GLB'));
    assert.deepEqual((await s.get('/api/assets/agents')).json().models, {});
  } finally {
    await s.close();
  }
});

test('native world discovery advertises only a validated manifest of the requested map', async () => {
  const s = await setup();
  try {
    const maps = join(s.root, 'maps');
    mkdirSync(join(maps, 'agents'), { recursive: true });
    const manifest = writeNativeWorld(maps, 'de_fixture');
    writeFileSync(join(maps, 'agents', 'ct.glb'), glb());
    writeFileSync(join(maps, 'agents', 't.glb'), Buffer.from('Not a GLB'));
    assert.deepEqual((await s.get('/api/maps/de_fixture')).json(), {
      model: createHash('sha256').update(manifest).digest('hex'),
      overview: null,
    });
    assert.deepEqual((await s.get('/api/assets/agents')).json(), {
      ct: '/map-assets/agents/ct.glb',
      t: null,
      actions: null,
      models: {},
    });
    writeFileSync(join(maps, 'agents', 'actions.glb'), glb());
    assert.equal(
      (await s.get('/api/assets/agents')).json().actions,
      '/map-assets/agents/actions.glb',
    );
    assert.equal((await s.get('/map-assets/agents/actions.glb')).statusCode, 200);
    assert.equal((await s.get('/map-assets/agents/other.glb')).statusCode, 404);
    for (const path of ['map.json', 'map.json.br', vertexFile])
      assert.equal((await s.get('/map-assets/de_fixture/' + path)).statusCode, 404);
    const file = join(maps, 'de_fixture', 'map.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(manifest.toString()), map: 'de_other' }));
    assert.equal((await s.get('/api/maps/de_fixture')).json().model, null);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(manifest.toString()), version: 2 }));
    assert.equal((await s.get('/api/maps/de_fixture')).json().model, null);
    rmSync(file);
    symlinkSync(join(s.folder, 'outside.json'), file);
    writeFileSync(join(s.folder, 'outside.json'), manifest);
    assert.equal((await s.get('/api/maps/de_fixture')).json().model, null);
  } finally {
    await s.close();
  }
});
