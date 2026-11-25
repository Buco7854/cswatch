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
import { triangle } from './fixtures/embedded-glb.mjs';
import { prepareOverview } from './prepare-overview.mjs';
import { installSteamAssets, runAssetProcess } from './install-steam-assets.mjs';
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
  // A top-level 3D sky companion extends the map's name after its mode prefix.
  assert.deepEqual(skyPrefabPackage('de_fixture', 'maps/de_fixture_3dskybox.vmap'), {
    file: 'game/csgo/maps/de_fixture_3dskybox.vpk',
    resource: 'maps/de_fixture_3dskybox.vmap_c',
  });
  assert.equal(
    skyPrefabPackage('ar_fixture', 'maps/fy_fixture_sky.vmap').file,
    'game/csgo/maps/fy_fixture_sky.vpk',
  );
  assert.equal(selectedSkyPrefabFile('de_fixture', 'game/csgo/maps/de_fixture_3dskybox.vpk'), true);
  assert.equal(selectedSkyPrefabFile('de_other', 'game/csgo/maps/de_fixture_3dskybox.vpk'), false);
  assert.throws(() =>
    dependencyBatch(pending, 'de_other', { packageFile: 'game/csgo/maps/de_fixture_3dskybox.vpk' }),
  );
  for (const name of [
    'maps/de_other_3dskybox.vmap',
    'maps/de_fixture.vmap',
    'maps/de_fixturesky.vmap',
    'maps/sub/de_fixture_sky.vmap',
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
