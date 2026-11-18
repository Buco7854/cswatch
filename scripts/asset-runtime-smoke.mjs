/** Original assets only. Run inside the hardened assets image via stdin, or
 * locally with explicit disposable MAP_* paths and a built confinement helper. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, lstat, mkdtemp, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const approvals = ['de_ci_worker', 'de_ci_broken'].map((map, index) => ({
  identity: {
    map,
    buildNum: 1,
    patchVersion: 1,
    demoVersionGuid: `00000000-0000-4000-8000-00000000000${index + 1}`,
    addonPresence: 'none',
  },
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: String(index + 1),
    mapSha256: hash(Buffer.from(`Original CI fixture source ${index + 1}`)),
  },
  assetVersion: 'original-ci-fixture',
}));

if (process.argv[2] === '--prepare-catalog') {
  assert.equal(process.argv.length, 4, 'Provide one new disposable catalog directory.');
  const directory = resolve(process.argv[3]);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await writeFile(
    join(directory, 'catalog.json'),
    JSON.stringify({ schemaVersion: 1, entries: approvals }) + '\n',
    { flag: 'wx', mode: 0o644 },
  );
  await chmod(directory, 0o755);
  await chmod(join(directory, 'catalog.json'), 0o644);
  console.log('Prepared original synthetic CI catalog. No official map source or artwork.');
  process.exit(0);
}

const root = resolve(process.env.CSWATCH_ASSET_SMOKE_ROOT || process.cwd()),
  inContainer = process.env.CSWATCH_ASSET_SMOKE_CONTAINER === 'true',
  moduleAt = (name) => import(pathToFileURL(join(root, 'backend/dist', name)).href),
  requireAssets = createRequire(join(root, 'tools/assets/package.json')),
  { Document, NodeIO } = requireAssets('@gltf-transform/core'),
  sharp = requireAssets('sharp');
const { mapPackId, readMapCatalog } = await moduleAt('map-catalog.js');
const { enqueueMapRequest, prepareMapJobs, readMapResult, mapWorkerAvailable } =
  await moduleAt('map-jobs.js');
const { mapWorkerOptions, lockMapWorker, processOneMapRequest } = await import(
  pathToFileURL(join(root, 'tools/assets/map-worker.mjs')).href
);
const { validatePreparedMap } = await import(
  pathToFileURL(join(root, 'tools/assets/prepared-map-publication.mjs')).href
);
const options = mapWorkerOptions(process.env),
  boundary = options.networkDeny;
assert.equal(Number(process.versions.node.split('.')[0]), 24);
assert.deepEqual(
  await readMapCatalog(options.catalog),
  { schemaVersion: 1, entries: approvals },
  'Smoke refuses an operator/production catalog.',
);
for (const path of [options.assets, options.cache]) await mkdir(path, { recursive: true });
await prepareMapJobs(options.jobs);
assert.equal(
  spawnSync(boundary, ['--check'], { stdio: 'pipe', timeout: 5000 }).status,
  0,
  'Required kernel confinement must be available.',
);

if (inContainer) {
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  const status = await readFile('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  const mounts = (await readFile('/proc/self/mountinfo', 'utf8'))
    .trim()
    .split('\n')
    .map((line) => line.split(' '));
  for (const target of ['/', dirname(options.catalog)])
    assert.ok(
      mounts.some((fields) => fields[4] === target && fields[5].split(',').includes('ro')),
      `${target} must be a real read-only mount.`,
    );
  assert.equal(
    existsSync('/etc/ssl/certs/ca-certificates.crt'),
    true,
    'Pinned HTTPS tools need the system certificate bundle.',
  );
  assert.equal(
    existsSync('/data'),
    false,
    'The asset image never includes the application data root.',
  );
  for (const name of [
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
    'STEAM_API_KEY',
    'FACEIT_API_KEY',
    'FACEIT_DOWNLOAD_TOKEN',
  ])
    assert.equal(
      process.env[name],
      undefined,
      'Application credentials must not enter this container.',
    );
  assert.deepEqual((await readdir(join(root, 'backend/dist'))).sort(), [
    'asset-content.js',
    'map-asset-files.js',
    'map-catalog.js',
    'map-identity.js',
    'map-jobs.js',
  ]);
  const requireBackend = createRequire(join(root, 'backend/package.json'));
  for (const name of [
    'fastify',
    'argon2',
    'cs2parser',
    '@laihoe/demoparser2',
    '@huggingface/transformers',
  ])
    assert.throws(
      () => requireBackend.resolve(name),
      { code: 'MODULE_NOT_FOUND' },
      'Only zod and pure backend contracts belong in this image.',
    );
  assert.equal(
    (await readdir(join(root, 'tools/assets'))).some((name) => name.endsWith('.test.mjs')),
    false,
  );
  for (const name of ['flock', 'unzip', 'tar', 'gzip'])
    assert.equal(
      spawnSync(name, name === 'unzip' ? ['-v'] : ['--version'], { stdio: 'ignore', timeout: 5000 })
        .status,
      0,
      `${name} is required by the pinned toolchain.`,
    );
  const denied = (error) => ['EACCES', 'EROFS', 'EPERM'].includes(error.code);
  await assert.rejects(writeFile(join(root, '.unexpected-worker-write'), 'forbidden'), denied);
  await assert.rejects(
    writeFile(options.catalog, 'forbidden'),
    denied,
    'The approval catalog mount must be read-only.',
  );
}

// An unconfined control connection succeeds in this same container. The child
// then has to fail because of its own seccomp policy, independently of Docker.
const server = createServer((socket) => socket.end());
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port,
  control = connect(port, '127.0.0.1');
await once(control, 'connect');
control.destroy();
const probe = await mkdtemp(join(options.cache, '.runtime-probe-')),
  allowed = join(probe, 'allowed.txt'),
  outside = join(options.cache, 'outside-converter.txt');
await writeFile(outside, 'original protected bytes');
try {
  const source = `const fs=require('node:fs'),net=require('node:net'),assert=require('node:assert/strict');fs.writeFileSync(${JSON.stringify(allowed)},'confined output');assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'must not change'),e=>['EACCES','EPERM'].includes(e.code));const socket=net.connect(${port},'127.0.0.1');socket.on('connect',()=>process.exit(20));socket.on('error',error=>{assert.ok(['EACCES','EPERM'].includes(error.code));console.log('filesystem and network confined');});`;
  const result = spawnSync(
    boundary,
    ['--write-root', probe, '--', process.execPath, '-e', source],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 16384,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /filesystem and network confined/);
  assert.equal(await readFile(allowed, 'utf8'), 'confined output');
  assert.equal(await readFile(outside, 'utf8'), 'original protected bytes');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(probe, { recursive: true, force: true });
  await rm(outside);
}

const document = new Document(),
  buffer = document.createBuffer(),
  positions = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
document
  .createScene()
  .addChild(
    document
      .createNode('Original CI triangle')
      .setMesh(
        document
          .createMesh()
          .addPrimitive(document.createPrimitive().setAttribute('POSITION', positions)),
      ),
  );
const model = Buffer.from(await new NodeIO().writeBinary(document)),
  png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#8090a0' } })
    .png()
    .toBuffer();
async function prepareOriginal(output, entry) {
  const map = entry.identity.map,
    assetVersion = entry.assetVersion;
  for (const tier of ['desktop', 'mobile']) {
    const folder = join(output, map, tier);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'scene.glb'), model);
    await writeFile(
      join(folder, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        map,
        tier,
        assetVersion,
        bytes: model.length,
        outputSha256: hash(model),
      }),
    );
  }
  const overview = join(output, 'overviews', map),
    environment = join(output, 'environments', map);
  await mkdir(overview, { recursive: true });
  await mkdir(environment, { recursive: true });
  await writeFile(join(overview, 'overview.png'), png);
  await writeFile(
    join(overview, 'overview.json'),
    JSON.stringify({
      schemaVersion: 1,
      map,
      assetVersion,
      referenceSize: 1024,
      origin: { x: 0, y: 0 },
      scale: 1,
      imageSha256: hash(png),
    }),
  );
  await writeFile(join(overview, 'provenance.json'), '{}');
  const faces = {};
  for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
    await writeFile(join(environment, `${face}.png`), png);
    faces[face] = hash(png);
  }
  await writeFile(
    join(environment, 'environment.json'),
    JSON.stringify({
      schemaVersion: 1,
      map,
      assetVersion,
      source: 'Original CI pixels, not game content',
      landscape: false,
      sky: { brightness: 1, faces },
    }),
  );
  await writeFile(join(environment, 'provenance.json'), '{}');
}
const release = await lockMapWorker(options.jobs);
assert.equal(typeof release, 'function');
try {
  assert.equal(
    await lockMapWorker(options.jobs),
    undefined,
    'Single-worker inherited-FD lock must remain held.',
  );
  const good = approvals[0],
    packId = mapPackId(good),
    target = join(options.assets, 'packs', packId);
  assert.equal(await enqueueMapRequest(options.jobs, good), 'queued');
  assert.equal(
    await processOneMapRequest(options, {
      prepare: async (input) => {
        assert.deepEqual(input.maps, [good.identity.map]);
        assert.equal(input.manifest, good.source.manifest);
        assert.deepEqual(input.expectedMapHashes, { [good.identity.map]: good.source.mapSha256 });
        assert.equal((await readMapResult(options.jobs, packId)).status, 'processing');
        assert.equal(existsSync(target), false);
        await prepareOriginal(input.output, good);
      },
    }),
    true,
  );
  assert.equal((await readMapResult(options.jobs, packId)).status, 'ready');
  const validated = await validatePreparedMap(
    join(target, 'maps'),
    good.identity.map,
    good.assetVersion,
  );
  assert.ok(validated.length >= 15);
  assert.equal((await lstat(target)).mode & 0o777, 0o755);
  assert.equal(
    await processOneMapRequest(options, {
      prepare: () => {
        throw Error('Immutable completed work must not run again.');
      },
    }),
    false,
  );
  const broken = approvals[1],
    brokenId = mapPackId(broken);
  assert.equal(await enqueueMapRequest(options.jobs, broken), 'queued');
  assert.equal(
    await processOneMapRequest(options, {
      prepare: async (input) => {
        await prepareOriginal(input.output, broken);
        await writeFile(
          join(input.output, 'environments', broken.identity.map, 'px.png'),
          'corrupt original fixture',
        );
      },
    }),
    true,
  );
  const failure = await readMapResult(options.jobs, brokenId);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.code, 'preparation_failed');
  assert.equal(existsSync(join(options.assets, 'packs', brokenId)), false);
  assert.deepEqual(await readdir(join(options.assets, 'packs')), [packId]);
  assert.equal(await mapWorkerAvailable(options.jobs), true);
  console.log(
    JSON.stringify({
      ok: true,
      containerBoundary: inContainer,
      kernelConfinement: true,
      workerPublication: true,
      corruptOutputRejected: true,
      originalRuntimeFiles: validated.length,
      officialDownloads: 0,
    }),
  );
} finally {
  await release();
}
