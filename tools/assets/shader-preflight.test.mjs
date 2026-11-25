import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  materialShaderBatch,
  preflightMaterialShaders,
  requiredShaderPrograms,
  shaderNameFromMaterialData,
} from './shader-preflight.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-material-shader-')),
    game = join(root, 'game'),
    stage = join(root, 'stage');
  await mkdir(stage);
  await mkdir(game);
  const path = join(game, 'game/csgo/pak01_dir.vpk');
  const payloads = new Map([
    ['materials/first.vmat_c', Buffer.from('csgo_used')],
    ['materials/second.vmat_c', Buffer.from('csgo_other')],
  ]);
  const materials = [...payloads].map(([resource, bytes]) => ({
    resource,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source: { kind: 'vpk', path },
  }));
  const names = [
    'csgo_used_vulkan_50_features',
    'csgo_used_vulkan_50_ps',
    'csgo_used_vulkan_60_features',
    'csgo_used_vulkan_60_ps',
    'csgo_used_vulkan_60_vs',
    'csgo_other_vulkan_40_features',
    'csgo_other_vulkan_40_ps',
    'unrelated_vulkan_60_features',
    'unrelated_vulkan_60_ps',
  ];
  const entries = new Map(
    names.map((name) => [
      `shaders/vfx/${name}.vcs`,
      {
        resource: `shaders/vfx/${name}.vcs`,
        length: name.startsWith('unrelated') ? 330 * 1024 ** 2 : 10,
        preloadBytes: 0,
      },
    ]),
  );
  const missing = new Set([
    'shaders/vfx/csgo_used_vulkan_60_features.vcs',
    'shaders/vfx/csgo_used_vulkan_60_vs.vcs',
  ]);
  const reads = [],
    downloads = [],
    commands = [];
  const shaderIndexes = [
    [
      'csgo',
      {
        entries,
        verifyEntry: async (resource) => {
          reads.push(resource);
          assert.ok(!resource.startsWith('shaders/vfx/unrelated_'));
          assert.ok(!resource.startsWith('shaders/vfx/csgo_used_vulkan_50_'));
          return !missing.has(resource);
        },
      },
    ],
  ];
  const context = {
    closure: { materials, unknown: [] },
    game,
    packageFile: 'game/csgo/maps/de_fixture.vpk',
    stage,
    label: 'map',
    s2v: '/trusted/s2v',
    shaderIndexes,
    index: async (source) => {
      assert.equal(source, path);
      return { readEntry: async (resource) => payloads.get(resource) };
    },
    execute: async (tool, args) => {
      commands.push({ tool, args });
      assert.equal(tool, '/trusted/s2v');
      assert.ok(args.includes('--recursive'));
      assert.deepEqual(args.slice(-4), ['--block', 'DATA', '--threads', '1']);
      const folder = args[args.indexOf('-i') + 1];
      const files = (await readdir(folder)).reverse();
      const text = await Promise.all(
        files.map(
          async (file, i) =>
            `[${i + 1}/${files.length}] ${join(folder, file)}\n\tm_shaderName = "${await readFile(join(folder, file), 'utf8')}.vfx"\n`,
        ),
      );
      return { code: 0, stdout: text.join('\n'), stderr: '' };
    },
    download: async (records) => {
      downloads.push(records);
      for (const record of records) missing.delete(record.selector.split(':')[1]);
    },
  };
  return {
    root,
    context,
    materials,
    payloads,
    entries,
    reads,
    downloads,
    commands,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('material DATA requires one canonical shader per verified source even when native file order differs', () => {
  assert.equal(shaderNameFromMaterialData('m_shaderName = "csgo_fixture.vfx"\n'), 'csgo_fixture');
  for (const text of [
    'm_shaderName = "../other.vfx"',
    'm_shaderName = "a.vfx"\nm_shaderName = "https://outside.invalid/b.vfx"',
    'm_shaderName = "a.vfx" ignored',
  ])
    assert.throws(() => shaderNameFromMaterialData(text), /exact shader/);
  assert.deepEqual(
    materialShaderBatch(
      '[1/2] /safe/b.vmat_c\nm_shaderName = "b.vfx"\n[2/2] /safe/a.vmat_c\nm_shaderName = "a.vfx"\n',
      ['/safe/a.vmat_c', '/safe/b.vmat_c'],
    ).map((entry) => entry.shader),
    ['b', 'a'],
  );
  for (const text of [
    '[1/1] /outside.vmat_c\nm_shaderName = "a.vfx"',
    'No material DATA',
    '[1/1] /safe/a.vmat_c\nm_shaderName = "a.vfx"\nm_shaderName = "b.vfx"',
  ])
    assert.throws(() => materialShaderBatch(text, ['/safe/a.vmat_c']));
});

test('shader planning chooses the highest native indexed feature model and only its declared program stages', async () => {
  const s = await fixture();
  try {
    const plan = requiredShaderPrograms(
      ['csgo_used', 'csgo_other', 'csgo_used'],
      s.context.shaderIndexes,
    );
    assert.deepEqual(
      plan.map(({ name, model }) => ({ name, model })),
      [
        { name: 'csgo_other', model: '40' },
        { name: 'csgo_used', model: '60' },
      ],
    );
    assert.equal(plan[1].programs.length, 3);
    assert.ok(
      plan
        .flatMap((family) => family.programs)
        .every(
          (program) =>
            !program.selector.includes('_50_') && !program.selector.includes('unrelated'),
        ),
    );
    assert.throws(
      () => requiredShaderPrograms(['missing'], s.context.shaderIndexes),
      /no Vulkan feature/,
    );
    s.entries.get('shaders/vfx/csgo_used_vulkan_60_ps.vcs').length = 512 * 1024 ** 2 + 1;
    assert.throws(
      () => requiredShaderPrograms(['csgo_used'], s.context.shaderIndexes),
      /bounded streamed CRC/,
    );
  } finally {
    await s.close();
  }
});

test('large authored shader programs use streamed verification before and after exact repair without allocating them', async () => {
  const s = await fixture();
  try {
    const large = 'shaders/vfx/csgo_used_vulkan_60_ps.vcs',
      bytes = 330897636;
    s.entries.get(large).length = bytes;
    const directory = s.context.shaderIndexes[0][1];
    const verified = [],
      missing = new Set([large]);
    directory.readEntry = async () =>
      assert.fail('Shader verification must use the streamed reader');
    directory.verifyEntry = async (resource) => {
      verified.push(resource);
      return !missing.has(resource);
    };
    s.context.download = async (records) => {
      s.downloads.push(records);
      assert.deepEqual(records, [{ selector: `game/csgo/shaders_vulkan_dir.vpk:${large}`, bytes }]);
      missing.clear();
    };
    const report = await preflightMaterialShaders(s.context);
    assert.equal(verified.filter((resource) => resource === large).length, 2);
    assert.equal(s.reads.length, 0, 'real indexes stream small shaders too');
    assert.equal(report.verifiedBytes, 2 * bytes + 40);
    assert.equal(report.repaired.length, 1);
  } finally {
    await s.close();
  }
});

test('shader preflight requires streamed CRC verification', async () => {
  const s = await fixture();
  try {
    delete s.context.shaderIndexes[0][1].verifyEntry;
    await assert.rejects(preflightMaterialShaders(s.context), /require bounded streaming CRC/);
    assert.deepEqual(s.reads, []);
    assert.equal(s.downloads.length, 0);
  } finally {
    await s.close();
  }
});

test('actual reference proofs drive DATA extraction, canonical shader families and only CRC-missing exact fetches', async () => {
  const s = await fixture();
  try {
    const report = await preflightMaterialShaders(s.context);
    assert.equal(report.materials.length, 2);
    assert.equal(s.commands.length, 1);
    assert.deepEqual(report.materials.map((record) => record.shader).sort(), [
      'csgo_other',
      'csgo_used',
    ]);
    assert.deepEqual(s.downloads, [
      [
        {
          selector: 'game/csgo/shaders_vulkan_dir.vpk:shaders/vfx/csgo_used_vulkan_60_features.vcs',
          bytes: 10,
        },
        {
          selector: 'game/csgo/shaders_vulkan_dir.vpk:shaders/vfx/csgo_used_vulkan_60_vs.vcs',
          bytes: 10,
        },
      ],
    ]);
    assert.equal(report.repaired.length, 2);
  } finally {
    await s.close();
  }
});

test('changed material bytes, source escapes or malformed native metadata fail before speculative shader fetches', async () => {
  for (const mode of ['hash', 'escape', 'metadata']) {
    const s = await fixture();
    try {
      if (mode === 'hash') s.materials[0].sha256 = '0'.repeat(64);
      else if (mode === 'escape') s.materials[0].source.path = '/outside/operator.vpk';
      else s.context.execute = async () => ({ code: 0, stdout: 'No material DATA', stderr: '' });
      await assert.rejects(
        preflightMaterialShaders(s.context),
        /changed|CRC invalid|outside|cover every/,
      );
      assert.equal(s.downloads.length, 0);
    } finally {
      await s.close();
    }
  }
});
