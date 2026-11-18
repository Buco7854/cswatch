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
import { COOKIE, digest } from '../src/security.js';
import { overviewLimits, validOverviewPng } from '../src/map-assets.js';
import {
  environmentFaces,
  environmentLimits,
  validEnvironmentPng,
} from '../src/map-environment.js';
import { initializeFixture } from './fixtures/initialized.js';
import { authoredFog, invalidFogCases } from '../../tools/assets/fixtures/fog-cases.mjs';

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
  db.run('INSERT INTO users VALUES(?,?,?,?,?)', 'member', 'member', null, 0, now());
  db.run(
    'INSERT INTO sessions VALUES(?,?,?,?)',
    digest('map-assets-session'),
    'member',
    'csrf-test',
    now() + 120,
  );
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
        ...(member ? { cookie: `${COOKIE}=map-assets-session` } : {}),
      },
    });
  const install = (image = png()) => {
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'overview.png'), image);
    writeFileSync(join(pack, 'overview.json'), JSON.stringify(metadata(image)));
    return image;
  };
  const installEnvironment = () => {
    const environmentPack = join(root, 'maps', 'environments', 'de_fixture');
    mkdirSync(environmentPack, { recursive: true });
    const images = Object.fromEntries(
      environmentFaces.map((face, index) => [face, png(8, 8, index + 1)]),
    );
    const environment = {
      schemaVersion: 1,
      map: 'de_fixture',
      assetVersion: 'Original synthetic test environment',
      source: 'Original synthetic test sky faces, no game artwork',
      landscape: true,
      sky: {
        brightness: 1.5,
        faces: Object.fromEntries(
          environmentFaces.map((face) => [
            face,
            createHash('sha256').update(images[face]).digest('hex'),
          ]),
        ),
      },
    };
    for (const face of environmentFaces)
      writeFileSync(join(environmentPack, `${face}.png`), images[face]);
    writeFileSync(join(environmentPack, 'environment.json'), JSON.stringify(environment));
    writeFileSync(join(environmentPack, 'provenance.json'), '{"operator":"private provenance"}');
    for (const tier of ['desktop', 'mobile']) {
      const target = join(root, 'maps', 'de_fixture', tier);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'scene.glb'), glb());
      writeFileSync(
        join(target, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          map: 'de_fixture',
          tier,
          assetVersion: environment.assetVersion,
        }),
      );
    }
    return { environmentPack, images, environment };
  };
  return {
    folder,
    root,
    pack,
    app,
    db,
    get,
    install,
    installEnvironment,
    close: async () => {
      await app.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

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
      mobile: null,
      overview: null,
      environment: null,
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
    assert.deepEqual(info.json(), { model: null, mobile: null, overview, environment: null });
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
            cookie: `${COOKIE}=map-assets-session`,
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

test('GLB discovery advertises only readable regular version-2 files, preserving existing tier paths', async () => {
  const s = await setup();
  try {
    for (const path of ['de_fixture/desktop', 'de_fixture/mobile', 'agents'])
      mkdirSync(join(s.root, 'maps', path), { recursive: true });
    writeFileSync(join(s.root, 'maps', 'de_fixture', 'desktop', 'scene.glb'), glb());
    writeFileSync(join(s.root, 'maps', 'de_fixture', 'mobile', 'scene.glb'), glb());
    writeFileSync(join(s.root, 'maps', 'agents', 'ct.glb'), glb());
    writeFileSync(join(s.root, 'maps', 'agents', 't.glb'), Buffer.from('Not a GLB'));
    assert.deepEqual((await s.get('/api/maps/de_fixture')).json(), {
      model: '/map-assets/de_fixture/desktop/scene.glb',
      mobile: '/map-assets/de_fixture/mobile/scene.glb',
      overview: null,
      environment: null,
    });
    assert.deepEqual((await s.get('/api/assets/agents')).json(), {
      ct: '/map-assets/agents/ct.glb',
      t: null,
    });
    rmSync(join(s.root, 'maps', 'de_fixture', 'desktop', 'scene.glb'));
    writeFileSync(join(s.root, 'maps', 'de_fixture.glb'), glb());
    assert.equal(
      (await s.get('/api/maps/de_fixture')).json().model,
      null,
      'Loose unversioned model paths are not published.',
    );
    assert.equal((await s.get('/map-assets/de_fixture.glb')).statusCode, 404);
    rmSync(join(s.root, 'maps', 'de_fixture.glb'));
    symlinkSync(
      join(s.root, 'maps', 'de_fixture', 'mobile', 'scene.glb'),
      join(s.root, 'maps', 'de_fixture.glb'),
    );
    assert.equal((await s.get('/api/maps/de_fixture')).json().model, null);
  } finally {
    await s.close();
  }
});

test('environment PNGs enforce the bounded square face format independently of overview limits', () => {
  assert.equal(validEnvironmentPng(png()), true);
  assert.equal(validEnvironmentPng(png(1024)), true);
  for (const image of [
    png(1025),
    png(8, 4),
    Buffer.from('<svg/>'),
    Buffer.alloc(environmentLimits.bytes + 1),
    png().subarray(0, -1),
  ])
    assert.equal(validEnvironmentPng(image), false);
  const corrupt = png();
  corrupt[40] ^= 1;
  assert.equal(validEnvironmentPng(corrupt), false);
  assert.equal(
    validEnvironmentPng(
      Buffer.concat([png().subarray(0, 33), chunk('acTL', Buffer.alloc(8)), png().subarray(33)]),
    ),
    false,
  );
});

test('environment discovery exposes only paired fixed cube faces with private policy, no-store and no static bypass', async () => {
  const s = await setup();
  try {
    assert.equal((await s.get('/api/maps/de_fixture/environment/px.png', false)).statusCode, 401);
    assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
    assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 404);
    const installed = s.installEnvironment();
    const expected = {
      assetVersion: installed.environment.assetVersion,
      landscape: true,
      sky: {
        brightness: 1.5,
        faces: environmentFaces.map((face) => `/api/maps/de_fixture/environment/${face}.png`),
      },
    };
    const response = await s.get('/api/maps/de_fixture');
    assert.deepEqual(response.json().environment, expected);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    for (const [index, face] of environmentFaces.entries()) {
      const image = await s.get(expected.sky.faces[index]);
      assert.equal(image.statusCode, 200);
      assert.equal(image.headers['content-type'], 'image/png');
      assert.equal(image.headers['x-content-type-options'], 'nosniff');
      assert.equal(image.headers['cache-control'], 'private, no-store');
      assert.deepEqual(image.rawPayload, installed.images[face]);
      assert.equal((await s.get(expected.sky.faces[index], true, 'HEAD')).rawPayload.length, 0);
    }
    for (const filename of ['px.png', 'environment.json', 'provenance.json'])
      assert.equal(
        (await s.get(`/map-assets/environments/de_fixture/${filename}`)).statusCode,
        404,
      );
    for (const face of ['PX', 'unknown', 'provenance', '%2e%2e%2fpx'])
      assert.equal((await s.get(`/api/maps/de_fixture/environment/${face}.png`)).statusCode, 404);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: expected.sky.faces[0],
          headers: {
            host: 'localhost:8000',
            origin: 'http://localhost:8000',
            cookie: `${COOKIE}=map-assets-session`,
            'x-csrf-token': 'csrf-test',
          },
          payload: { image: 'No public preparation endpoint' },
        })
      ).statusCode,
      404,
    );
    s.db.run('UPDATE settings SET value=1 WHERE key=?', 'public_access');
    assert.equal((await s.get(expected.sky.faces[0], false)).statusCode, 200);
    s.db.run('UPDATE settings SET value=0 WHERE key=?', 'public_access');
    assert.equal((await s.get(expected.sky.faces[0], false, 'HEAD')).statusCode, 401);
  } finally {
    await s.close();
  }
});

test('environment metadata and both prepared map tiers must agree before any face is served', async () => {
  const s = await setup();
  try {
    const { environmentPack, environment } = s.installEnvironment();
    const file = join(environmentPack, 'environment.json');
    for (const invalid of [
      { ...environment, map: 'de_other' },
      { ...environment, assetVersion: 'other build' },
      { ...environment, source: '' },
      { ...environment, landscape: 1 },
      { ...environment, assetVersion: 'a'.repeat(101) },
      { ...environment, sky: { ...environment.sky, brightness: -1 } },
      { ...environment, sky: { ...environment.sky, brightness: 17 } },
      { ...environment, sky: { ...environment.sky, brightness: '1' } },
      {
        ...environment,
        sky: { ...environment.sky, faces: { ...environment.sky.faces, px: '0'.repeat(64) } },
      },
      {
        ...environment,
        sky: {
          ...environment.sky,
          faces: { ...environment.sky.faces, px: 'https://outside.invalid/face.png' },
        },
      },
      {
        ...environment,
        sky: { ...environment.sky, faces: { ...environment.sky.faces, extra: '0'.repeat(64) } },
      },
      { ...environment, rotation: 90 },
    ]) {
      writeFileSync(file, JSON.stringify(invalid));
      assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
      assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 404);
    }
    writeFileSync(file, JSON.stringify(environment));
    assert.ok((await s.get('/api/maps/de_fixture')).json().environment);
    for (const tier of ['desktop', 'mobile']) {
      const manifest = join(s.root, 'maps', 'de_fixture', tier, 'manifest.json');
      const original = readFileSync(manifest);
      writeFileSync(
        manifest,
        JSON.stringify({ schemaVersion: 1, map: 'de_fixture', tier, assetVersion: 'stale build' }),
      );
      assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
      writeFileSync(manifest, original);
      rmSync(manifest);
      assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 404);
      writeFileSync(manifest, original);
    }
    const manifests = ['desktop', 'mobile'].map((tier) =>
      join(s.root, 'maps', 'de_fixture', tier, 'manifest.json'),
    );
    const originals = manifests.map((path) => readFileSync(path));
    assert.ok((await s.get('/api/maps/de_fixture')).json().environment);
    for (const [index, path] of manifests.entries()) {
      const data = JSON.parse(originals[index].toString());
      data.assetVersion = data.assetVersion.slice(0, -1) + 'x';
      writeFileSync(path, JSON.stringify(data));
    }
    assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
    for (const [index, path] of manifests.entries()) writeFileSync(path, originals[index]);
    writeFileSync(file, Buffer.alloc(environmentLimits.metadataBytes + 1));
    assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
  } finally {
    await s.close();
  }
});

test('optional authored cube fog is finite, strictly bounded and projected without URLs or guessed defaults', async () => {
  const s = await setup();
  try {
    const { environmentPack, environment } = s.installEnvironment();
    const path = join(environmentPack, 'environment.json');
    const fog = authoredFog();
    for (const valid of [
      fog,
      { ...fog, height: null },
      {
        ...fog,
        start: 0,
        end: 254000,
        exponent: 16,
        height: { start: -254000, end: 254000, exponent: 16 },
        maxOpacity: 1,
        lodBias: 0,
        brightness: 0,
      },
      { ...fog, rotation: [1, 1e-7, 0, 0, 1, 0, 0, 0, 1] },
    ]) {
      writeFileSync(path, JSON.stringify({ ...environment, fog: valid }));
      assert.deepEqual((await s.get('/api/maps/de_fixture')).json().environment.fog, valid);
      assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 200);
    }
    for (const invalid of invalidFogCases()) {
      writeFileSync(path, JSON.stringify({ ...environment, fog: invalid }));
      assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
      assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 404);
    }
    writeFileSync(path, JSON.stringify(environment));
    const restored = (await s.get('/api/maps/de_fixture')).json().environment;
    assert.ok(restored);
    assert.equal(Object.hasOwn(restored, 'fog'), false);
  } finally {
    await s.close();
  }
});

test('environment faces reject links, special files, mixed dimensions, excess aggregate size and stale cached bytes', async () => {
  const s = await setup();
  try {
    const { environmentPack, environment, images } = s.installEnvironment();
    const face = join(environmentPack, 'px.png');
    const meta = join(environmentPack, 'environment.json');
    const outside = join(s.folder, 'outside.png');
    writeFileSync(outside, images.px);
    assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 200);
    for (const makeInvalid of [
      () => symlinkSync(outside, face),
      () => linkSync(outside, face),
      () => assert.equal(spawnSync('mkfifo', [face]).status, 0),
      () => writeFileSync(face, Buffer.from('<svg/>')),
    ]) {
      rmSync(face);
      makeInvalid();
      assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 404);
      rmSync(face);
      writeFileSync(face, images.px);
    }
    const otherSize = png(16);
    writeFileSync(face, otherSize);
    writeFileSync(
      meta,
      JSON.stringify({
        ...environment,
        sky: {
          ...environment.sky,
          faces: {
            ...environment.sky.faces,
            px: createHash('sha256').update(otherSize).digest('hex'),
          },
        },
      }),
    );
    assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
    writeFileSync(face, images.px);
    writeFileSync(meta, JSON.stringify(environment));
    assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 200);
    const changed = png(8, 8, 100);
    writeFileSync(face, changed);
    assert.equal((await s.get('/api/maps/de_fixture/environment/px.png')).statusCode, 404);
    writeFileSync(
      meta,
      JSON.stringify({
        ...environment,
        sky: {
          ...environment.sky,
          faces: {
            ...environment.sky.faces,
            px: createHash('sha256').update(changed).digest('hex'),
          },
        },
      }),
    );
    assert.deepEqual((await s.get('/api/maps/de_fixture/environment/px.png')).rawPayload, changed);
    for (const name of environmentFaces)
      truncateSync(join(environmentPack, `${name}.png`), 6 * 1024 ** 2);
    assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
    for (const name of environmentFaces)
      writeFileSync(join(environmentPack, `${name}.png`), images[name]);
    writeFileSync(meta, JSON.stringify(environment));
    renameSync(join(s.root, 'maps', 'environments'), join(s.root, 'maps', 'environments-original'));
    symlinkSync(
      join(s.root, 'maps', 'environments-original'),
      join(s.root, 'maps', 'environments'),
      'dir',
    );
    assert.equal((await s.get('/api/maps/de_fixture')).json().environment, null);
  } finally {
    await s.close();
  }
});
