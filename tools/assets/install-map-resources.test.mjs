import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { exportMapGltf, resolveMapResources } from './install-map-resources.mjs';

test('recursive closure retains the exact package and fails after eight bounded download waves', async () => {
  let scans = 0,
    downloads = 0;
  await assert.rejects(
    resolveMapResources({
      map: 'de_fixture',
      packageFile: 'game/csgo/maps/de_fixture.vpk',
      game: '/private/game',
      required: ['materials/fixture.vmat_c'],
      progress: () => {},
      label: 'fixture',
      scan: async (options) => {
        scans++;
        assert.deepEqual(options.required, ['materials/fixture.vmat_c']);
        return {
          unknown: [],
          pending: {
            map: [],
            csgo: [{ resource: 'materials/fixture.vmat_c', length: 10, preloadBytes: 0 }],
            core: [],
          },
        };
      },
      download: async (records) => {
        downloads++;
        assert.deepEqual(records, [
          { selector: 'game/csgo/pak01_dir.vpk:materials/fixture.vmat_c', bytes: 10 },
        ]);
      },
    }),
    /eight selective waves/,
  );
  assert.equal(scans, 9);
  assert.equal(downloads, 8);
});

test('unknown rendering dependencies fail closed before any selective download', async () => {
  await assert.rejects(
    resolveMapResources({
      map: 'de_fixture',
      packageFile: 'game/csgo/maps/de_fixture.vpk',
      game: '/private/game',
      progress: () => {},
      label: 'fixture',
      scan: async () => ({
        unknown: ['materials/missing.vmat_c'],
        pending: { map: [], csgo: [], core: [] },
      }),
      download: async () =>
        assert.fail('Unknown required resources cannot trigger a broad download'),
    }),
    /absent from the pinned indexes/,
  );
});

test('ordinary and prefab exports share exact shader retries, discard failed scratch and require clean real output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-shader-export-'));
  try {
    let attempts = 0,
      transfers = 0,
      storageChecks = 0;
    const imageReports = [];
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#789080' } })
      .png()
      .toBuffer();
    const source = await exportMapGltf({
      map: 'de_fixture',
      packageFile: 'game/csgo/maps/prefabs/de_fixture/sky.vpk',
      resource: 'maps/prefabs/de_fixture/sky.vmap_c',
      game: '/private/game',
      stage: root,
      label: 'sky',
      closure: { materials: [], unknown: [] },
      s2v: '/trusted/s2v',
      storage: async () => storageChecks++,
      onSourceImages: async (report) => imageReports.push(report),
      shaderIndexes: [
        [
          'csgo',
          {
            entries: new Map([
              [
                'shader',
                {
                  resource: 'shaders/vfx/csgo_fixture_vulkan_50_ps.vcs',
                  length: 100,
                  preloadBytes: 0,
                },
              ],
            ]),
          },
        ],
      ],
      download: async (records) => {
        transfers++;
        assert.deepEqual(records, [
          {
            selector: 'game/csgo/shaders_vulkan_dir.vpk:shaders/vfx/csgo_fixture_vulkan_50_ps.vcs',
            bytes: 100,
          },
        ]);
      },
      execute: async (command, args, label, options) => {
        assert.equal(command, '/trusted/s2v');
        assert.equal(
          args[args.indexOf('--vpk_filepath') + 1],
          'maps/prefabs/de_fixture/sky.vmap_c',
        );
        assert.deepEqual(Object.keys(options).sort(), [
          'allowFailure',
          'onOutputAbort',
          'onOutputLine',
        ]);
        assert.equal(options.allowFailure, true);
        assert.equal(typeof options.onOutputAbort, 'function');
        assert.equal(typeof options.onOutputLine, 'function');
        const output = args[args.indexOf('--output') + 1];
        await writeFile(output, 'Original synthetic geometry export');
        if (attempts === 1) {
          await writeFile(join(root, 'sky-export-1', 'fixture.png'), png);
          await options.onOutputLine('--- [1/1] Exported texture: fixture.vtex');
        }
        return ++attempts === 1
          ? { code: 0, stdout: 'Failed to find shader "csgo_fixture.vfx"', stderr: '' }
          : { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(attempts, 2);
    assert.equal(transfers, 1);
    assert.equal(storageChecks, 2);
    assert.equal(imageReports.length, 2);
    assert.equal(imageReports[0].report.images.length, 0);
    assert.equal(imageReports[1].report.images[0].file, 'fixture.png');
    assert.equal(
      imageReports[1].report.images[0].input.sha256,
      imageReports[1].report.images[0].output.sha256,
    );
    assert.deepEqual(await readFile(join(root, 'sky-export-1', 'fixture.png')), png);
    assert.equal(await readFile(source, 'utf8'), 'Original synthetic geometry export');
    await assert.rejects(readFile(join(root, 'sky-export-0', 'scene.gltf')));
    await mkdir(join(root, 'failed'));
    await assert.rejects(
      exportMapGltf({
        map: 'de_fixture',
        packageFile: 'game/csgo/maps/de_fixture.vpk',
        resource: 'maps/de_fixture.vmap_c',
        game: '/private/game',
        stage: join(root, 'failed'),
        label: 'main',
        closure: { materials: [], unknown: [] },
        s2v: '/trusted/s2v',
        storage: async () => {},
        shaderIndexes: [],
        download: async () => assert.fail('Missing material must not trigger a shader download'),
        execute: async (command, args) => {
          await writeFile(args[args.indexOf('--output') + 1], 'Incomplete material-less export');
          return { code: 0, stdout: 'Failed to load materials/missing.vmat_c', stderr: '' };
        },
      }),
      /real map and required materials/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
