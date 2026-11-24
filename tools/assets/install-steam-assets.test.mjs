import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { writeOriginalMapTier } from './fixtures/original-map-tier.mjs';
import { triangle } from './fixtures/embedded-glb.mjs';
import { authoredFog, invalidFogCases } from './fixtures/fog-cases.mjs';
import { prepareOverview } from './prepare-overview.mjs';
import {
  installSteamAssets,
  publishPreparedMap,
  runAssetProcess,
  validatePreparedMap,
} from './install-steam-assets.mjs';
import {
  STEAM_DEPOT,
  steamAssetLimits,
  selectedMaps,
  selectedSteamManifest,
  initialSteamFiles,
  overviewResources,
  parseSteamListing,
  checkedBatch,
  dependencyBatch,
  missingShaderNames,
  shaderBatch,
  assertExportableUnknowns,
  selectedSkyPrefabFile,
  skyPrefabPackage,
} from './steam-assets-plan.mjs';

test('operator selection requires explicit safe maps and generates no full-game patterns', () => {
  for (const value of [
    undefined,
    '',
    [],
    '*',
    'de_mirage,de_mirage',
    '../map',
    'de_mirage,*',
    'https://example.invalid',
    'de_mirage, de_dust2',
  ])
    assert.throws(() => selectedMaps(value));
  const files = initialSteamFiles('de_mirage,de_dust2');
  assert.equal(files.length, 9);
  assert.ok(files.includes('game/csgo/maps/de_mirage.vpk'));
  assert.ok(files.includes('game/core/shaders_vulkan_dir.vpk'));
  assert.ok(files.every((file) => !/[?*]|regex:/.test(file)));
  assert.deepEqual(overviewResources('de_mirage'), [
    'resource/overviews/de_mirage.txt',
    'panorama/images/overheadmaps/de_mirage_radar_psd.vtex_c',
  ]);
});

test('Steam preflight keeps uint64 manifest IDs exact and rejects missing, extra, mixed or oversized files', () => {
  const files = initialSteamFiles(['de_fixture']),
    manifest = '18446744073709551615';
  const rows = files.map((file) => `${STEAM_DEPOT}\t${manifest}\t${'a'.repeat(40)}\t10\t${file}`);
  const result = parseSteamListing(rows.join('\n'), files);
  assert.equal(result.manifest, manifest);
  assert.equal(result.bytes, files.length * 10);
  for (const text of [
    rows.slice(1).join('\n'),
    [...rows, rows[0]].join('\n'),
    rows.join('\n').replace(manifest, '1'),
    rows.join('\n').replace(STEAM_DEPOT, '730'),
    rows.join('\n').replace('\t10\t', `\t${steamAssetLimits.selectedBytes + 1}\t`),
    rows.join('\n') + '\nUnexpected stdout',
    rows.join('\n').replace(manifest, '18446744073709551616'),
  ])
    assert.throws(() => parseSteamListing(text, files));
});

test('explicit Steam version selection rejects rounded, empty, zero or overflowing manifest IDs', async () => {
  assert.equal(selectedSteamManifest('18446744073709551615'), '18446744073709551615');
  for (const manifest of [
    undefined,
    null,
    '',
    '0',
    '01',
    42,
    18446744073709551615n,
    '18446744073709551616',
    '-1',
    '42:43',
    ' 42',
  ]) {
    assert.throws(() => selectedSteamManifest(manifest));
    if (manifest !== undefined)
      await assert.rejects(installSteamAssets({ maps: 'de_fixture', manifest }), /uint64/);
  }
});

test('a different returned manifest stops before any selected download or native export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-steam-version-'));
  try {
    const tool = join(root, 'trusted-test-tool');
    await writeFile(tool, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const commands = [];
    await assert.rejects(
      installSteamAssets(
        {
          maps: 'de_fixture',
          manifest: '42',
          output: join(root, 'maps'),
          cache: join(root, 'cache'),
          s2v: tool,
          downloader: tool,
        },
        {
          run: async (_command, args) => {
            commands.push(args);
            assert.equal(args[0], 'ls');
            assert.equal(args[2], `${STEAM_DEPOT}:42`);
            return {
              code: 0,
              stdout: initialSteamFiles('de_fixture')
                .map((file) => `${STEAM_DEPOT}\t43\t${'a'.repeat(40)}\t10\t${file}`)
                .join('\n'),
              stderr: '',
            };
          },
        },
      ),
      /does not match the requested version/,
    );
    assert.equal(commands.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inventory selection mismatches stop before any map download or native conversion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-steam-membership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = join(root, 'tool');
  await writeFile(tool, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let calls = 0;
  await assert.rejects(
    installSteamAssets(
      {
        maps: ['de_fixture'],
        manifest: '42',
        output: join(root, 'maps'),
        cache: join(root, 'cache'),
        s2v: tool,
        downloader: tool,
        expectedMapFiles: { de_fixture: { sha1: 'b'.repeat(40), bytes: 10 } },
      },
      {
        run: async (_command, args) => {
          calls++;
          assert.equal(args[0], 'ls');
          return {
            code: 0,
            stdout: initialSteamFiles('de_fixture')
              .map((file) => `${STEAM_DEPOT}\t42\t${'a'.repeat(40)}\t10\t${file}`)
              .join('\n'),
            stderr: '',
          };
        },
      },
    ),
    (error) => error.code === 'SOURCE_MAP_MISMATCH',
  );
  assert.equal(calls, 1);
  for (const expectedMapFiles of [
    {},
    { de_fixture: { sha1: 'x', bytes: 10 } },
    { de_fixture: { sha1: 'a'.repeat(40), bytes: 0 } },
    { de_other: { sha1: 'a'.repeat(40), bytes: 10 } },
  ])
    await assert.rejects(installSteamAssets({ maps: ['de_fixture'], expectedMapFiles }), /exactly/);
});

test('linked output and cache ancestors are rejected before bootstrap or writes through them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-steam-roots-'));
  try {
    const outside = join(root, 'outside'),
      linked = join(root, 'linked');
    await mkdir(outside);
    await symlink(outside, linked);
    for (const path of ['output', 'cache']) {
      let bootstraps = 0;
      await assert.rejects(
        installSteamAssets(
          {
            maps: 'de_fixture',
            output: path === 'output' ? join(linked, 'maps') : join(root, 'maps'),
            cache: path === 'cache' ? join(linked, 'cache') : join(root, 'cache'),
          },
          {
            prepareToolchain: async () => {
              bootstraps++;
              assert.fail('No tool bootstrap may run through a linked root.');
            },
          },
        ),
        /real directories/,
      );
      assert.equal(bootstraps, 0);
      assert.deepEqual(await readdir(outside), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependency and shader batches contain only exact current-package resources with byte limits', () => {
  const record = { resource: 'materials/fixture.vmat_c', length: 100, preloadBytes: 2 };
  assert.deepEqual(
    dependencyBatch({ pending: { map: [], csgo: [record], core: [] } }, 'de_fixture'),
    [{ selector: 'game/csgo/pak01_dir.vpk:materials/fixture.vmat_c', bytes: 102 }],
  );
  for (const selector of [
    '*',
    'game/**',
    'game/csgo/pak01_dir.vpk:*',
    'game/csgo/pak01_dir.vpk:../secret',
    'game/csgo/pak01_dir.vpk:regex:.*',
    'https://example.invalid/file',
    'game/csgo/unknown.vpk',
  ])
    assert.throws(() => checkedBatch([{ selector, bytes: 1 }]));
  assert.throws(() =>
    checkedBatch([{ selector: 'game/csgo/steam.inf', bytes: steamAssetLimits.selectedBytes + 1 }]),
  );
  const indexes = [
    [
      'csgo',
      {
        entries: new Map([
          [
            'a',
            { resource: 'shaders/vfx/csgo_fixture_vulkan_50_ps.vcs', length: 40, preloadBytes: 0 },
          ],
          [
            'b',
            { resource: 'shaders/vfx/unrelated_vulkan_50_ps.vcs', length: 1000, preloadBytes: 0 },
          ],
        ]),
      },
    ],
  ];
  const names = missingShaderNames(
    'Failed to find shader "csgo_fixture.vfx"\nFailed to find shader "csgo_fixture.vfx"',
  );
  assert.deepEqual(names, ['csgo_fixture']);
  assert.deepEqual(shaderBatch(names, indexes), [
    {
      selector: 'game/csgo/shaders_vulkan_dir.vpk:shaders/vfx/csgo_fixture_vulkan_50_ps.vcs',
      bytes: 40,
    },
  ]);
  assert.throws(() => shaderBatch(['../outside'], indexes));
  assert.throws(() => shaderBatch(['missing'], indexes));
});

test('only an enabled selected-map reference permits one exact prefab package and pinned entry selections', () => {
  const sky = skyPrefabPackage(
    'de_fixture',
    'maps/prefabs/de_fixture/3dskybox_fixture_legacy.vmap',
  );
  assert.deepEqual(sky, {
    file: 'game/csgo/maps/prefabs/de_fixture/3dskybox_fixture_legacy.vpk',
    resource: 'maps/prefabs/de_fixture/3dskybox_fixture_legacy.vmap_c',
  });
  const record = { selector: sky.file, bytes: 100 };
  assert.throws(() => checkedBatch([record]));
  assert.deepEqual(checkedBatch([record], { prefabs: [sky.file] }), [record]);
  const authoredAlias = skyPrefabPackage('de_fixture', 'maps/prefabs/fixture/sky.vmap');
  assert.equal(selectedSkyPrefabFile('de_fixture', authoredAlias.file), true);
  assert.equal(selectedSkyPrefabFile('de_other', authoredAlias.file), false);
  assert.deepEqual(assertExportableUnknowns([], 'de_fixture', { skyMap: null }), []);
  const pending = {
    pending: {
      map: [{ resource: 'materials/sky.vmat_c', length: 10, preloadBytes: 2 }],
      csgo: [],
      core: [],
    },
  };
  assert.deepEqual(dependencyBatch(pending, 'de_fixture', { packageFile: sky.file }), [
    { selector: sky.file + ':materials/sky.vmat_c', bytes: 12 },
  ]);
  assert.throws(() => dependencyBatch(pending, 'de_other', { packageFile: sky.file }));
  for (const name of [
    'maps/prefabs/de_other/sky.vmap',
    'maps/prefabs/de_fixture/../sky.vmap',
    'maps/prefabs/de_fixture/sky.vmap_c',
    'maps/prefabs/de_fixture/sky*.vmap',
    'https://example.invalid/sky.vmap',
  ])
    assert.throws(() => skyPrefabPackage('de_fixture', name));
  assert.deepEqual(
    assertExportableUnknowns([sky.resource], 'de_fixture', {
      skyMap: 'maps/prefabs/de_fixture/3dskybox_fixture_legacy.vmap',
    }),
    [sky.resource],
  );
  assert.throws(() => assertExportableUnknowns([sky.resource], 'de_fixture'));
});

test('only explicitly non-rendered baked, selected-map skybox and game-script unknowns may reach export', () => {
  const names = [
    '_bakeresourcecache/maps/de_fixture/lighting.vtex_c',
    'maps/prefabs/de_fixture/de_fixture_skybox.vmap_c',
    'scripts/vscripts/map/door_filter.lua_c',
  ];
  assert.deepEqual(assertExportableUnknowns(names, 'de_fixture'), names);
  for (const resource of [
    'materials/missing.vmat_c',
    'models/missing.vmdl_c',
    'textures/missing.vtex_c',
    'maps/prefabs/de_other/de_other_skybox.vmap_c',
  ])
    assert.throws(() => assertExportableUnknowns([resource], 'de_fixture'));
});

async function preparedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-selective-installer-')),
    prepared = join(root, 'prepared'),
    output = join(root, 'maps'),
    map = 'de_fixture',
    version = 'steam-2347770-42';
  const image = join(root, 'original.png');
  await writeFile(
    image,
    await sharp({ create: { width: 32, height: 32, channels: 4, background: '#25485f' } })
      .png()
      .toBuffer(),
  );
  await prepareOverview({
    image,
    origin: { x: -2500, y: 3000 },
    scale: 5,
    output: prepared,
    map,
    version,
    source: 'Original synthetic triangle and overview test artwork.',
  });
  for (const tier of ['desktop', 'mobile']) {
    const path = join(prepared, map, tier);
    await writeOriginalMapTier(path, triangle(), map, tier, version);
  }
  const environment = join(prepared, 'environments', map);
  await mkdir(environment, { recursive: true });
  const pixels = await readFile(image);
  const faces = Object.fromEntries(
    ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((face) => [
      face,
      createHash('sha256').update(pixels).digest('hex'),
    ]),
  );
  for (const face of Object.keys(faces)) await writeFile(join(environment, `${face}.png`), pixels);
  await writeFile(
    join(environment, 'environment.json'),
    JSON.stringify({
      schemaVersion: 2,
      map,
      assetVersion: version,
      source: 'Original synthetic environment',
      landscape: true,
      sky: { brightness: 1, faces },
    }),
  );
  await writeFile(join(environment, 'provenance.json'), JSON.stringify({ synthetic: true }));
  await writeFile(
    join(prepared, 'raw-source.gltf'),
    'This must never reach the runtime directory.',
  );
  return {
    root,
    prepared,
    output,
    map,
    version,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('publication verifies and installs both tiers, overview and six-face environment without raw sources or overwrites', async () => {
  const s = await preparedFixture();
  try {
    const inventory = await validatePreparedMap(s.prepared, s.map, s.version);
    assert.equal(inventory.length, 19);
    const result = await publishPreparedMap(s.prepared, s.output, s.map, s.version, {
      app: '730',
      depot: STEAM_DEPOT,
      manifest: '42',
    });
    assert.equal(result.files.length, 19);
    assert.deepEqual((await readdir(s.output)).sort(), ['de_fixture', 'environments', 'overviews']);
    assert.deepEqual((await readdir(join(s.output, s.map))).sort(), [
      'desktop',
      'installation.json',
      'mobile',
    ]);
    assert.ok(
      JSON.parse(await readFile(join(s.output, s.map, 'installation.json'))).files.every((file) =>
        /^[a-f0-9]{64}$/.test(file.sha256),
      ),
    );
    await assert.rejects(publishPreparedMap(s.prepared, s.output, s.map, s.version, {}));
    assert.deepEqual(await readFile(join(s.output, s.map, 'desktop/scene.glb')), triangle());
  } finally {
    await s.close();
  }
});

test('invalid or conflicting pairs fail without replacing operator files or leaving half-installed maps', async () => {
  const s = await preparedFixture();
  try {
    await assert.rejects(validatePreparedMap(s.prepared, s.map, 'another-version'));
    await mkdir(join(s.output, 'overviews', s.map), { recursive: true });
    await writeFile(join(s.output, 'overviews', s.map, 'operator-marker'), 'untouched');
    await assert.rejects(publishPreparedMap(s.prepared, s.output, s.map, s.version, {}));
    await assert.rejects(readFile(join(s.output, s.map, 'desktop/scene.glb')));
    assert.equal(
      await readFile(join(s.output, 'overviews', s.map, 'operator-marker'), 'utf8'),
      'untouched',
    );
    assert.deepEqual((await readdir(s.output)).sort(), ['environments', 'overviews']);
    await writeFile(join(s.prepared, s.map, 'desktop/scene.glb'), Buffer.from('not geometry'));
    await assert.rejects(validatePreparedMap(s.prepared, s.map, s.version));
    await assert.rejects(
      installSteamAssets({ maps: [], output: s.output, cache: join(s.root, 'cache') }),
    );
    await assert.rejects(
      installSteamAssets({
        maps: ['de_other'],
        output: s.output,
        cache: join(s.root, 'cache'),
        s2v: '/missing',
      }),
      /both/,
    );
  } finally {
    await s.close();
  }
});

test('a conflict at the third environment destination rolls back both new map and overview while preserving operator assets', async () => {
  const s = await preparedFixture();
  try {
    await mkdir(join(s.output, 'environments', s.map), { recursive: true });
    await writeFile(join(s.output, 'environments', s.map, 'operator-marker'), 'untouched');
    await assert.rejects(publishPreparedMap(s.prepared, s.output, s.map, s.version, {}));
    await assert.rejects(readFile(join(s.output, s.map, 'desktop', 'scene.glb')));
    await assert.rejects(readFile(join(s.output, 'overviews', s.map, 'overview.png')));
    assert.equal(
      await readFile(join(s.output, 'environments', s.map, 'operator-marker'), 'utf8'),
      'untouched',
    );
    assert.ok(!(await readdir(s.output)).some((name) => name.startsWith('.cswatch-map-')));
  } finally {
    await s.close();
  }
});

test('environment hashes and version must validate before any map, overview or environment publication', async () => {
  const s = await preparedFixture();
  try {
    const file = join(s.prepared, 'environments', s.map, 'environment.json');
    const original = JSON.parse(await readFile(file));
    for (const invalid of [
      { ...original, schemaVersion: 1 },
      { ...original, assetVersion: 'other-build' },
      {
        ...original,
        sky: { ...original.sky, faces: { ...original.sky.faces, px: '0'.repeat(64) } },
      },
      { ...original, sky: { ...original.sky, brightness: 17 } },
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      await assert.rejects(publishPreparedMap(s.prepared, s.output, s.map, s.version, {}));
      await assert.rejects(readFile(join(s.output, s.map, 'desktop', 'scene.glb')));
      await assert.rejects(readFile(join(s.output, 'overviews', s.map, 'overview.png')));
      await assert.rejects(readFile(join(s.output, 'environments', s.map, 'px.png')));
    }
  } finally {
    await s.close();
  }
});

test('publication preserves supported authored fog and refuses invalid ranges, matrices or arbitrary image fields', async () => {
  const s = await preparedFixture();
  try {
    const file = join(s.prepared, 'environments', s.map, 'environment.json');
    const original = JSON.parse(await readFile(file));
    const fog = authoredFog();
    for (const valid of [fog, { ...fog, height: null }]) {
      await writeFile(file, JSON.stringify({ ...original, fog: valid }));
      assert.equal((await validatePreparedMap(s.prepared, s.map, s.version)).length, 19);
    }
    for (const invalid of invalidFogCases()) {
      await writeFile(file, JSON.stringify({ ...original, fog: invalid }));
      await assert.rejects(
        validatePreparedMap(s.prepared, s.map, s.version),
        /bounded fixed-face contract/,
      );
    }
    await writeFile(file, JSON.stringify({ ...original, fog }));
    await publishPreparedMap(s.prepared, s.output, s.map, s.version, {});
    assert.deepEqual(
      JSON.parse(await readFile(join(s.output, 'environments', s.map, 'environment.json'))).fog,
      fog,
    );
  } finally {
    await s.close();
  }
});

test('a model exceeding the HTTP discovery 2 GiB bound cannot be published within the 4 GiB pair budget', async () => {
  const s = await preparedFixture();
  try {
    assert.equal(steamAssetLimits.modelBytes, 2 * 1024 ** 3);
    const model = await open(join(s.prepared, s.map, 'desktop/scene.glb'), 'r+');
    try {
      await model.truncate(steamAssetLimits.modelBytes + 1);
    } finally {
      await model.close();
    }
    await assert.rejects(validatePreparedMap(s.prepared, s.map, s.version), /bounded regular/);
    await assert.rejects(
      publishPreparedMap(s.prepared, s.output, s.map, s.version, {}),
      /bounded regular/,
    );
    await assert.rejects(readFile(join(s.output, s.map, 'desktop/scene.glb')));
  } finally {
    await s.close();
  }
});

test('operator child cancellation stops its process group and preserves only bounded private diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-asset-process-'));
  try {
    const abort = new AbortController(),
      promise = runAssetProcess(
        process.execPath,
        ['-e', 'process.stdout.write("bounded fixture");setInterval(()=>{},1000)'],
        {
          cwd: root,
          home: root,
          temporary: root,
          signal: abort.signal,
          log: join(root, 'cancel.log'),
        },
      );
    setTimeout(() => abort.abort(), 50);
    await assert.rejects(promise, /cancelled/);
    const log = await readFile(join(root, 'cancel.log'), 'utf8');
    const [output, exit] = log.split('\nOperator process exit: ');
    assert.ok(Buffer.byteLength(output) <= 32);
    assert.equal(exit, 'none, signal: SIGKILL\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operator children receive fixed managed-memory settings and retain actual termination signals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-asset-memory-'));
  try {
    const options = { cwd: root, home: root, temporary: root };
    const probe = await runAssetProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({heap:process.env.DOTNET_GCHeapHardLimit,conserve:process.env.DOTNET_GCConserveMemory}))',
      ],
      options,
    );
    assert.deepEqual(JSON.parse(probe.stdout), { heap: '100000000', conserve: '9' });
    const killed = await runAssetProcess(
      process.execPath,
      ['-e', 'process.kill(process.pid,"SIGKILL")'],
      { ...options, allowFailure: true, log: join(root, 'killed.log') },
    );
    assert.equal(killed.code, null);
    assert.equal(killed.signal, 'SIGKILL');
    assert.match(await readFile(join(root, 'killed.log'), 'utf8'), /exit: none, signal: SIGKILL/);
    await assert.rejects(
      runAssetProcess(process.execPath, ['-e', 'process.kill(process.pid,"SIGKILL")'], options),
      /exit none, signal SIGKILL/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operator exit status stays structured without treating a native exit 4 as Steam rate evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-exit-code-'));
  try {
    await assert.rejects(
      runAssetProcess(process.execPath, ['-e', 'process.exit(4)'], {
        cwd: root,
        home: root,
        temporary: root,
      }),
      (error) => {
        assert.equal(error.exitCode, 4);
        assert.equal(error.code, undefined);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operator completed-output work is awaited across split lines and aborts its own stage on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-asset-output-'));
  try {
    const lines = [],
      options = { cwd: root, home: root, temporary: root };
    await runAssetProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write("first\\npar");setTimeout(()=>process.stdout.write("tial\\r\\nlast"),10)',
      ],
      {
        ...options,
        onOutputLine: async (line) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          lines.push(line);
        },
      },
    );
    assert.deepEqual(lines, ['first', 'partial', 'last']);
    let aborted = false;
    await assert.rejects(
      runAssetProcess(
        process.execPath,
        ['-e', 'console.log("completed");setInterval(()=>{},1000)'],
        {
          ...options,
          onOutputLine: () => Promise.reject(new Error('Bounded texture work failed')),
          onOutputAbort: () => {
            aborted = true;
          },
        },
      ),
      /Bounded texture work failed/,
    );
    assert.equal(aborted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('output diagnostics preserve split UTF-8 and a deadline drains cooperative mutations before rejecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-asset-drain-'));
  try {
    const options = { cwd: root, home: root, temporary: root },
      lines = [];
    const result = await runAssetProcess(
      process.execPath,
      [
        '-e',
        'const b=Buffer.from("équipement\\n");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)',
      ],
      {
        ...options,
        onOutputLine: (line) => {
          lines.push(line);
        },
      },
    );
    assert.equal(result.stdout, 'équipement\n');
    assert.deepEqual(lines, ['équipement']);
    let cancelled = false,
      drained = false,
      finish;
    await assert.rejects(
      runAssetProcess(
        process.execPath,
        ['-e', 'console.log("completed");setInterval(()=>{},1000)'],
        {
          ...options,
          timeoutMs: 200,
          onOutputLine: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
          onOutputAbort: () => {
            cancelled = true;
            setTimeout(() => {
              drained = true;
              finish?.();
            }, 20);
          },
        },
      ),
      /timed out/,
    );
    assert.equal(cancelled, true);
    assert.equal(drained, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('free-space guard serializes periodic checks, kills only its active stage and retains partial cache files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-asset-reserve-'));
  try {
    const partial = join(root, 'partial.vpk');
    await writeFile(partial, 'A previously downloaded sparse range must survive cancellation.');
    let calls = 0,
      active = 0,
      peak = 0;
    const storageGuard = async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        if (calls === 1) return;
        // Exceed one poll period to prove another scan cannot start concurrently.
        await new Promise((resolve) => setTimeout(resolve, 350));
        throw new Error('Insufficient free disk space for the 512 MiB reserve.');
      } finally {
        active--;
      }
    };
    await assert.rejects(
      runAssetProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: root,
        home: root,
        temporary: root,
        storageGuard,
        allowFailure: true,
        log: join(root, 'storage.log'),
      }),
      /512 MiB reserve/,
    );
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.equal(active, 0);
    assert.equal(
      await readFile(partial, 'utf8'),
      'A previously downloaded sparse range must survive cancellation.',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls, 2, 'The periodic guard must be stopped when its process group exits.');
    await assert.rejects(
      runAssetProcess('/not-an-executable', [], {
        cwd: root,
        home: root,
        temporary: root,
        storageGuard: async () => {
          throw new Error('Preflight storage reserve');
        },
      }),
      /Preflight storage reserve/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('synthetic installer run pins every selective fetch and removes only its own successful export scratch', async () => {
  const template = await preparedFixture();
  try {
    const cache = join(template.root, 'private-cache'),
      output = join(template.root, 'installed'),
      tool = join(template.root, 'trusted-test-tool'),
      converter = join(template.root, 'trusted-test-converter');
    await writeFile(tool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(converter, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(tool, 0o755);
    const files = initialSteamFiles([template.map]),
      content = new Map(
        files.map((file) => [file, Buffer.from(`Original synthetic download fixture: ${file}`)]),
      );
    const commands = [],
      scratch = [];
    const phases = [];
    let verifiedSource;
    const run = async (command, args, context) => {
      commands.push({ command, args: [...args], context });
      const argument = (name) => args[args.indexOf(name) + 1];
      if (args[0] === 'ls')
        return {
          code: 0,
          stdout: files
            .map(
              (file) =>
                `${STEAM_DEPOT}\t42\t${createHash('sha1').update(content.get(file)).digest('hex')}\t${content.get(file).length}\t${file}`,
            )
            .join('\n'),
          stderr: '',
        };
      if (args[0] === 'track') {
        const selected = JSON.parse(await readFile(join(context.cwd, 'files.json')));
        assert.deepEqual(selected, { [STEAM_DEPOT]: files });
        for (const file of files) {
          const path = join(argument('--output'), file);
          await mkdir(join(path, '..'), { recursive: true });
          await writeFile(path, content.get(file));
        }
        assert.match(
          await readFile(join(argument('--manifests'), `manifest_${STEAM_DEPOT}.txt`), 'utf8'),
          /Manifest ID \/ date     : 42 \/ pinned/,
        );
      } else if (args.includes('--vpk_decompile')) {
        const directory = argument('-o');
        await mkdir(join(directory, 'resource/overviews'), { recursive: true });
        await mkdir(join(directory, 'panorama/images/overheadmaps'), { recursive: true });
        await writeFile(
          join(directory, 'resource/overviews', `${template.map}.txt`),
          `${template.map} { pos_x -2500 pos_y 3000 scale 5 }`,
        );
        await copyFile(
          join(template.root, 'original.png'),
          join(directory, 'panorama/images/overheadmaps', `${template.map}_radar_psd.png`),
        );
      } else if (args.includes('--vpk_filepath')) {
        const source = argument('--output');
        await writeFile(source, '{}');
        scratch.push(source);
      } else if (command === process.execPath) {
        const directory = argument('--output');
        for (const tier of ['desktop', 'mobile']) {
          const target = join(directory, template.map, tier);
          await mkdir(target, { recursive: true });
          for (const name of [
            'scene.glb',
            'manifest.json',
            'texture-plan.json',
            'visual-audit.json',
          ])
            await copyFile(join(template.prepared, template.map, tier, name), join(target, name));
        }
      } else assert.fail('The installer must not invoke an unrelated command.');
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await installSteamAssets(
      {
        maps: [template.map],
        manifest: '42',
        cache,
        output,
        s2v: converter,
        downloader: tool,
        expectedMapHashes: {
          [template.map]: createHash('sha256')
            .update(content.get(`game/csgo/maps/${template.map}.vpk`))
            .digest('hex'),
        },
        expectedMapFiles: {
          [template.map]: {
            sha1: createHash('sha1')
              .update(content.get(`game/csgo/maps/${template.map}.vpk`))
              .digest('hex'),
            bytes: content.get(`game/csgo/maps/${template.map}.vpk`).length,
          },
        },
        onPhase: async (phase) => phases.push(phase),
        onSourceVerified: async (source) => {
          // This callback is before the first native metadata/conversion step.
          assert.ok(commands.every((entry) => entry.command === tool));
          verifiedSource = source;
        },
      },
      {
        run,
        index: async () => ({ entries: new Map() }),
        scan: async () => ({
          materials: [],
          pending: { map: [], csgo: [], core: [] },
          unknown: [],
          sources: [],
        }),
        inspectEnvironment: async () => ({
          required: [],
          prepare: async (mainGltf, prepared) => {
            const target = join(prepared, 'environments', template.map);
            await mkdir(target, { recursive: true });
            for (const name of await readdir(join(template.prepared, 'environments', template.map)))
              await copyFile(
                join(template.prepared, 'environments', template.map, name),
                join(target, name),
              );
            return {
              mergedInput: mainGltf,
              report: { synthetic: true, landscape: true, unknownNonRenderingResources: [] },
            };
          },
        }),
        // The converter in this pinning/cleanup fixture deliberately writes a dummy source.
        prepareBakedLighting: async () => ({
          args: [],
          proof: { path: 'pbr', reason: 'synthetic' },
        }),
        prepareGlass: async () => ({ args: [], proof: [] }),
        prepareAtmosphere: async ({ input }) => ({ path: input, report: { applied: false } }),
      },
    );
    assert.equal(result.maps[0].map, template.map);
    assert.deepEqual(verifiedSource, {
      map: template.map,
      manifest: '42',
      mapSha256: createHash('sha256')
        .update(content.get(`game/csgo/maps/${template.map}.vpk`))
        .digest('hex'),
      sha1: createHash('sha1')
        .update(content.get(`game/csgo/maps/${template.map}.vpk`))
        .digest('hex'),
      bytes: content.get(`game/csgo/maps/${template.map}.vpk`).length,
    });
    assert.equal(commands.find((entry) => entry.args[0] === 'ls').args[2], `${STEAM_DEPOT}:42`);
    assert.ok(
      commands
        .filter((entry) => entry.args[0] === 'track')
        .every(
          (entry) =>
            entry.args.includes('--anonymous') &&
            entry.args.includes('--manifests') &&
            entry.args[1] === '730',
        ),
    );
    assert.ok(
      commands.every((entry) => entry.args[0] !== 'download' && !entry.args.includes('--username')),
    );
    for (const { command, context } of commands) {
      if (command === tool) {
        assert.equal(context.conversionWriteRoots, undefined);
        continue;
      }
      assert.equal(context.conversionWriteRoots.length, 1);
      const [stage] = context.conversionWriteRoots;
      assert.ok(stage.startsWith(context.cwd + '/'));
      assert.notEqual(stage, context.cwd);
      assert.equal(context.home, join(stage, '.home'));
      assert.equal(context.temporary, join(stage, '.tmp'));
      assert.ok(!context.cwd.startsWith(stage + '/'));
    }
    for (const source of scratch) await assert.rejects(readFile(source));
    assert.deepEqual(
      await readFile(join(cache, 'steam/game/csgo/maps', `${template.map}.vpk`)),
      content.get(`game/csgo/maps/${template.map}.vpk`),
    );
    assert.ok((await readFile(result.report)).length > 0);
    assert.deepEqual(phases, [
      'tools',
      'source',
      'geometry',
      'environment',
      'lighting',
      'desktop',
      'mobile',
      'compact',
      'publishing',
    ]);
    const packageFile = `game/csgo/maps/${template.map}.vpk`;
    const sourceChecked = Error('Stop immediately after the exact verified batch.');
    for (const damage of [false, true]) {
      if (damage)
        await writeFile(
          join(cache, 'steam', packageFile),
          Buffer.alloc(content.get(packageFile).length),
        );
      const start = commands.length;
      await assert.rejects(
        installSteamAssets(
          {
            maps: [template.map],
            manifest: '42',
            cache,
            output: join(template.root, 'cache-recheck'),
            s2v: converter,
            downloader: tool,
            onSourceVerified(source) {
              assert.deepEqual(source, verifiedSource);
              throw sourceChecked;
            },
          },
          { run },
        ),
        (error) => error === sourceChecked,
      );
      assert.deepEqual(
        commands.slice(start).map(({ args }) => args[0]),
        damage ? ['ls', 'track'] : ['ls'],
      );
    }
    await assert.rejects(
      installSteamAssets(
        {
          maps: [template.map],
          manifest: '42',
          cache: join(template.root, 'corrupt-cache'),
          output: join(template.root, 'corrupt-output'),
          s2v: converter,
          downloader: tool,
          onSourceVerified: () =>
            assert.fail('Corrupt Steam bytes cannot produce a verified source.'),
        },
        {
          run: async (command, args, context) => {
            const result = await run(command, args, context);
            if (args[0] === 'track')
              await writeFile(
                join(args[args.indexOf('--output') + 1], 'game/csgo/maps', `${template.map}.vpk`),
                'corrupt source',
              );
            return result;
          },
        },
      ),
      (error) => error.code === 'SOURCE_MAP_MISMATCH',
    );
    await assert.rejects(
      installSteamAssets(
        {
          maps: [template.map],
          manifest: '42',
          cache: join(template.root, 'mismatch-cache'),
          output: join(template.root, 'mismatch-output'),
          s2v: converter,
          downloader: tool,
          expectedMapHashes: { [template.map]: '0'.repeat(64) },
        },
        {
          run,
          index: async () =>
            assert.fail('A mismatched source must stop before native metadata or geometry work.'),
        },
      ),
      (error) => error.code === 'SOURCE_MAP_MISMATCH',
    );
  } finally {
    await template.close();
  }
});
