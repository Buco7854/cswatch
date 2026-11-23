import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { inspectInstalledEnvironment } from './install-map-environment.mjs';
import { skyPrefabPackage } from './steam-assets-plan.mjs';
import { triangle } from './fixtures/embedded-glb.mjs';

async function fixture({
  listedManifest = '42',
  reference = 'maps/prefabs/de_fixture/3dskybox_fixture_legacy.vmap',
  entityCount = 1,
  badHash = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-environment-plan-'));
  const game = join(root, 'game'),
    stage = join(root, 'stage');
  await mkdir(game);
  await mkdir(stage);
  const mainGltf = join(stage, 'de_fixture-export-0', 'scene.gltf');
  await mkdir(dirname(mainGltf));
  await writeFile(mainGltf, '{}');
  const prefab = skyPrefabPackage(
    'de_fixture',
    'maps/prefabs/de_fixture/3dskybox_fixture_legacy.vmap',
  );
  const content = Buffer.from('Original synthetic selected prefab bytes');
  const texture = 'materials/skybox/fixture_cube.vtex_c';
  const material = 'materials/skybox/prefab_sky.vmat_c';
  const permitted = [],
    downloads = [],
    scans = [],
    commands = [];
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#235f68' } })
    .png()
    .toBuffer();
  const index = async (path) => ({
    entries: new Map(
      path.endsWith('/maps/de_fixture.vpk')
        ? Array.from({ length: entityCount }, (_, i) => [
            `maps/de_fixture/entities/lump_${i}.vents_c`,
            {},
          ])
        : path.endsWith('/' + prefab.file)
          ? [[`${prefab.resource.slice(0, -7)}/entities/default_ents.vents_c`, {}]]
          : path.endsWith('/csgo/pak01_dir.vpk')
            ? [
                [material, {}],
                [texture, {}],
              ]
            : [],
    ),
  });
  const execute = async (tool, args, label) => {
    commands.push({ tool, args, label });
    const argument = (key) => args[args.indexOf(key) + 1];
    if (args[0] === 'ls') {
      assert.deepEqual(args, ['ls', '730', '2347770:42', '--anonymous', '--', prefab.file]);
      return {
        code: 0,
        stdout: `2347770\t${listedManifest}\t${badHash ? '0'.repeat(40) : createHash('sha1').update(content).digest('hex')}\t${content.length}\t${prefab.file}`,
        stderr: '',
      };
    }
    if (args.includes('--block')) {
      assert.equal(
        argument('--vpk_filepath'),
        material,
        'Prefab env_sky must select the material before DATA inspection',
      );
      return { code: 0, stdout: 'Original synthetic material DATA', stderr: '' };
    }
    if (args.includes('--vpk_decompile')) {
      for (const entry of argument('-f').split(',')) {
        const output = join(argument('-o'), entry.slice(0, -2));
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, '====0====\nclassname "worldspawn"\n');
      }
    } else if (args.includes('--gltf_export_format')) {
      assert.equal(argument('--vpk_filepath'), prefab.resource);
      await writeFile(argument('--output'), '{}');
    } else if (args.includes('--texture_decode_flags')) {
      assert.equal(argument('--texture_decode_flags'), 'ForceLDR');
      assert.equal(argument('--vpk_filepath'), texture);
      for (const face of ['rt', 'lf', 'bk', 'ft', 'up', 'dn']) {
        const file = join(argument('--output'), `materials/skybox/fixture_cube_${face}.png`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, image);
      }
    } else assert.fail('No unrelated operator command may run');
    return { code: 0, stdout: '', stderr: '' };
  };
  const context = {
    map: 'de_fixture',
    game,
    stage,
    assetVersion: 'steam-2347770-42',
    manifest: '42',
    source: 'Original synthetic test',
    s2v: '/trusted/s2v',
    downloader: '/trusted/steam',
    execute,
    index,
    shaderIndexes: [],
    progress: () => {},
    storage: async () => {},
    permitPrefab: (file) => permitted.push(file),
    download: async (records) => {
      downloads.push(records);
      assert.ok(permitted.includes(prefab.file));
      assert.deepEqual(records, [{ selector: prefab.file, bytes: content.length }]);
      const path = join(game, prefab.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    scan: async (options) => {
      scans.push(options);
      return {
        materials: [],
        pending: { map: [], csgo: [], core: [] },
        unknown: ['_bakeresourcecache/synthetic.vtex_c'],
        sources: [{ group: 'map', sha256: 'a'.repeat(64) }],
      };
    },
  };
  const adapters = {
    module: {
      inspectMapEnvironment: (texts) => {
        assert.equal(texts.length, entityCount);
        return {
          skyMap: reference,
          skyMaterial: 'materials/skybox/main_sky.vmat',
          reference: { origin: [0, 0, 0], angles: [0, 0, 0], scales: [1, 1, 1] },
        };
      },
      inspectSkyCamera: (texts) => {
        assert.equal(texts.length, 1);
        return {
          origin: [1, 2, 3],
          scale: 16,
          skyEnvironment: { skyMaterial: 'materials/skybox/prefab_sky.vmat' },
        };
      },
      inspectSkyMaterial: (text) => {
        assert.equal(text, 'Original synthetic material DATA');
        return { texture, exposureBias: 0, renderExposureBias: 0 };
      },
    },
    prepare: async (config, resultPath) => {
      assert.ok(config.mainEntities.length && config.skyEntities.length);
      for (const face of ['rt', 'lf', 'bk', 'ft', 'up', 'dn']) {
        assert.equal(
          config.skyFaces[face],
          join(stage, 'sky-face-source', `materials/skybox/fixture_cube_${face}.png`),
        );
        assert.deepEqual(await readFile(config.skyFaces[face]), image);
      }
      const mergedInput = join(stage, 'merged.glb');
      await writeFile(mergedInput, triangle());
      const environment = join(config.output, 'environments', config.map);
      await mkdir(environment, { recursive: true });
      await writeFile(
        join(environment, 'provenance.json'),
        JSON.stringify({ schemaVersion: 1, map: config.map, assetVersion: config.assetVersion }),
      );
      await writeFile(
        resultPath,
        JSON.stringify({
          mergedInput,
          report: { landscape: true, orientation: 'synthetic fixture' },
        }),
      );
    },
  };
  return {
    root,
    stage,
    mainGltf,
    context,
    adapters,
    prefab,
    commands,
    scans,
    downloads,
    permitted,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('selected sky orchestration pins its exact referenced prefab and honors prefab material precedence before six-face preparation', async () => {
  const s = await fixture();
  try {
    const plan = await inspectInstalledEnvironment(s.context, s.adapters);
    assert.equal(plan.skyMap, 'maps/prefabs/de_fixture/3dskybox_fixture_legacy.vmap');
    assert.deepEqual(plan.required, ['materials/skybox/main_sky.vmat_c']);
    const result = await plan.prepare(s.mainGltf, join(s.stage, 'prepared'));
    assert.equal(result.report.selectedPrefab, s.prefab.file);
    assert.equal(result.report.pinnedManifest, '42');
    assert.deepEqual(result.report.unknownNonRenderingResources, [
      '_bakeresourcecache/synthetic.vtex_c',
    ]);
    assert.equal(s.downloads.length, 1);
    assert.deepEqual(s.scans[0].required, ['materials/skybox/prefab_sky.vmat_c']);
    assert.equal(s.scans[0].mapVpk, join(s.context.game, s.prefab.file));
    assert.deepEqual(s.permitted, [s.prefab.file]);
  } finally {
    await s.close();
  }
});

test('different-manifest or corrupted prefab content fails before resource extraction or preparation', async () => {
  for (const options of [{ listedManifest: '43' }, { badHash: true }]) {
    const s = await fixture(options);
    try {
      const plan = await inspectInstalledEnvironment(s.context, s.adapters);
      await assert.rejects(plan.prepare(s.mainGltf, join(s.stage, 'prepared')), /pinned|manifest/);
      assert.equal(s.scans.length, 0);
      assert.equal(
        s.commands.some(({ args }) => args.includes('--texture_decode_flags')),
        false,
      );
    } finally {
      await s.close();
    }
  }
});

test('cross-map references and excessive entity lists cannot authorize prefab downloads', async () => {
  for (const options of [{ reference: 'maps/prefabs/de_other/sky.vmap' }, { entityCount: 65 }]) {
    const s = await fixture(options);
    try {
      await assert.rejects(
        inspectInstalledEnvironment(s.context, s.adapters),
        /selected map|entity-lump/,
      );
      assert.deepEqual(s.permitted, []);
      assert.equal(s.downloads.length, 0);
    } finally {
      await s.close();
    }
  }
});
