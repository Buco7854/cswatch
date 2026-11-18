import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { triangle } from './fixtures/embedded-glb.mjs';
import { prepareInstalledAtmosphere } from './install-map-atmosphere.mjs';

async function fixture({
  missing = false,
  corruptAfterFetch = false,
  materials = true,
  duplicate = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-atmosphere-plan-'));
  const stage = join(root, 'stage'),
    prepared = join(stage, 'prepared'),
    game = join(root, 'game');
  const input = join(prepared, '.environment-fixture', 'merged.glb');
  const provenance = join(prepared, 'environments', 'de_fixture', 'provenance.json');
  await mkdir(dirname(input), { recursive: true });
  await mkdir(dirname(provenance), { recursive: true });
  await mkdir(game);
  await writeFile(input, triangle());
  await writeFile(
    provenance,
    JSON.stringify({
      schemaVersion: 1,
      map: 'de_fixture',
      assetVersion: 'test-build',
      retained: 'Original source geometry provenance',
    }),
  );
  const resources = {
    color: 'materials/effects/original_color.vtex',
    mask1: 'materials/effects/smoke/first_mask.vtex',
    mask2: 'materials/effects/smoke/second_mask.vtex',
    mask3: 'materials/effects/smoke/first_mask.vtex',
  };
  const material = {
    Name: 'materials/effects/smoke/dust_002_skybox.vmat',
    ShaderName: 'csgo_effects.vfx',
  };
  const unique = [...new Set(Object.values(resources).map((resource) => resource + '_c'))];
  const transfers = [],
    commands = [];
  let fetched = false;
  const image = await sharp({ create: { width: 8, height: 4, channels: 4, background: '#235f68' } })
    .png()
    .toBuffer();
  const context = {
    map: 'de_fixture',
    assetVersion: 'test-build',
    stage,
    prepared,
    game,
    input,
    s2v: '/trusted/s2v',
    packageFiles: [
      'game/csgo/maps/de_fixture.vpk',
      'game/csgo/pak01_dir.vpk',
      'game/core/pak01_dir.vpk',
    ],
    index: async (path) => ({
      entries: new Map(
        path.endsWith('/csgo/pak01_dir.vpk')
          ? unique.map((resource) => [resource, { length: 8, preloadBytes: 0, crc32: 42 }])
          : [],
      ),
      readEntry: async (resource) =>
        missing && resource === unique[1] && (!fetched || corruptAfterFetch)
          ? undefined
          : Buffer.from('compiled'),
    }),
    download: async (records) => {
      transfers.push(records);
      fetched = true;
    },
    execute: async (command, args) => {
      commands.push({ command, args });
      assert.equal(command, '/trusted/s2v');
      const resource = args[args.indexOf('--vpk_filepath') + 1];
      assert.ok(unique.includes(resource));
      assert.equal(
        args.includes('ForceLDR'),
        false,
        'Linear masks and genuine color alpha must use their original VTEX decode',
      );
      const output = join(
        args[args.indexOf('--output') + 1],
        resource.slice(0, -'.vtex_c'.length) + '.png',
      );
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, image);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const adapters = {
    module: {
      isSupportedAtmosphericMaterial: (raw) =>
        raw?.Name === 'materials/effects/smoke/dust_002_skybox.vmat' &&
        raw.ShaderName === 'csgo_effects.vfx',
      discoverAtmosphericMaterials: async () =>
        materials
          ? [
              { index: 0, material, resources },
              ...(duplicate
                ? [
                    {
                      index: 1,
                      material: structuredClone(material),
                      resources: structuredClone(resources),
                    },
                  ]
                : []),
            ]
          : [],
    },
    prepare: async (config, resultPath) => {
      assert.equal(config.jobs.length, 1);
      const job = config.jobs[0];
      assert.equal(job.maskPaths.mask1, job.maskPaths.mask3);
      for (const path of [job.colorPath, ...Object.values(job.maskPaths)])
        assert.deepEqual(await readFile(path), image);
      await writeFile(config.output, triangle());
      await writeFile(
        resultPath,
        JSON.stringify({
          path: config.output,
          report: { materials: [{ nativeMaterial: material.Name, phase: 0 }] },
        }),
      );
    },
  };
  return {
    root,
    context,
    adapters,
    resources,
    material,
    transfers,
    commands,
    provenance,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('mask acquisition deduplicates exact resources, checks CRC availability and decodes nested paths before guarded preparation', async () => {
  const s = await fixture({ missing: true, duplicate: true });
  try {
    const result = await prepareInstalledAtmosphere(s.context, s.adapters);
    assert.equal(result.path, join(s.context.stage, 'atmosphere-corrected.glb'));
    assert.equal(result.report.applied, true);
    assert.equal(result.report.sources.length, 3);
    assert.equal(s.commands.length, 3);
    assert.deepEqual(s.transfers, [
      [{ selector: 'game/csgo/pak01_dir.vpk:materials/effects/smoke/first_mask.vtex_c', bytes: 8 }],
    ]);
    await assert.rejects(readFile(s.context.input), { code: 'ENOENT' });
    const provenance = JSON.parse(await readFile(s.provenance));
    assert.equal(provenance.retained, 'Original source geometry provenance');
    assert.equal(provenance.atmosphere.sources.length, 3);
  } finally {
    await s.close();
  }
});

test('missing CRC data stays unavailable after fetch and never reaches image decoding', async () => {
  const s = await fixture({ missing: true, corruptAfterFetch: true });
  try {
    await assert.rejects(prepareInstalledAtmosphere(s.context, s.adapters), /CRC invalid/);
    assert.equal(s.transfers.length, 1);
    assert.equal(s.commands.length, 0);
    assert.ok((await readFile(s.context.input)).length);
  } finally {
    await s.close();
  }
});

test('unrelated materials remain unchanged while unsupported identity, URL resources and external inputs cannot trigger acquisition', async () => {
  const s = await fixture({ materials: false });
  try {
    assert.deepEqual(await prepareInstalledAtmosphere(s.context, s.adapters), {
      path: s.context.input,
      report: { materials: [], applied: false },
    });
    assert.equal(s.commands.length, 0);
    assert.equal(s.transfers.length, 0);
    assert.ok((await readFile(s.context.input)).length);
    for (const spec of [
      {
        index: 0,
        material: { ...s.material, Name: 'materials/other.vmat' },
        resources: s.resources,
      },
      {
        index: 0,
        material: s.material,
        resources: { ...s.resources, mask1: 'https://outside.invalid/mask.vtex' },
      },
    ]) {
      await assert.rejects(
        prepareInstalledAtmosphere(s.context, {
          ...s.adapters,
          module: { ...s.adapters.module, discoverAtmosphericMaterials: async () => [spec] },
        }),
        /exact|resource path/i,
      );
    }
    const external = join(s.root, 'operator-input.glb');
    await writeFile(external, triangle());
    await assert.rejects(
      prepareInstalledAtmosphere({ ...s.context, input: external }, s.adapters),
      /private merged input/,
    );
    assert.ok((await readFile(external)).length);
    assert.equal(s.commands.length, 0);
    assert.equal(s.transfers.length, 0);
  } finally {
    await s.close();
  }
});
