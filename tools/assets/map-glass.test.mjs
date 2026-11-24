import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { triangle } from './fixtures/embedded-glb.mjs';
import { prepareInstalledGlass } from './install-map-glass.mjs';
import { bindPreparedGlass, readGlassBindings } from './prepare-map-glass.mjs';

const name = 'materials/test/clear.vmat',
  dust = 'materials/test/frost.vtex',
  tint = 'materials/test/nocolor.vtex';
function materialBytes() {
  const strings = [dust, tint].map((x) => Buffer.from(x + '\0')),
    size = 8 + 2 * 16 + strings.reduce((n, b) => n + b.length, 0),
    b = Buffer.alloc(28 + size);
  b.writeUInt32LE(b.length);
  b.writeUInt16LE(12, 4);
  b.writeUInt32LE(8, 8);
  b.writeUInt32LE(1, 12);
  b.write('RERL', 16);
  b.writeUInt32LE(8, 20);
  b.writeUInt32LE(size, 24);
  b.writeUInt32LE(8, 28);
  b.writeUInt32LE(2, 32);
  let offset = 68;
  strings.forEach((str, i) => {
    const at = 44 + i * 16;
    b.writeUInt32LE(offset - at, at);
    str.copy(b, offset);
    offset += str.length;
  });
  return b;
}
const description = `m_materialName = "${name}"
m_shaderName = "csgo_glass.vfx"
m_intParams = [
 { m_name = "F_DO_NOT_CAST_SHADOWS"
   m_nValue = 1 }
]
m_floatParams = [ ]
m_textureParams = [
 { m_name = "g_tGlassDust"
   m_pValue = resource:"${dust}" }
 { m_name = "g_tGlassTintColor"
   m_pValue = resource:"${tint}" }
]`;
const header =
  'VTEX Version = 1\nWidth = 4\nHeight = 4\nDisplayRectW = 1\nDisplayRectH = 1\nDepth = 1\nNumMipLevels = 1\nFlags = 0x00000000\n';

test('verified source glass uses the decoded numeric input, preserves other materials and confines fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-glass-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'raw.glb');
  const glb = triangle((d) => {
    d.meshes[0].primitives[0].material = 0;
    d.materials = [
      {
        alphaMode: 'BLEND',
        extras: {
          vmat: {
            Name: name,
            ShaderName: 'csgo_glass.vfx',
            IntParams: { F_DO_NOT_CAST_SHADOWS: 1 },
            TextureParams: { g_tGlassDust: dust, g_tGlassTintColor: tint },
          },
        },
      },
      { name: 'solid frame' },
    ];
  });
  await writeFile(input, glb);
  const values = new Map([
    [name + '_c', materialBytes()],
    [dust + '_c', Buffer.from('dust')],
    [tint + '_c', Buffer.from('tint')],
  ]);
  const bank = {
    entries: new Map(
      [...values].map(([key, b], i) => [key, { length: b.length, preloadBytes: 0, crc32: i + 1 }]),
    ),
    readEntry: async (key) => values.get(key),
  };
  const png = async (size, rgba) =>
    sharp(Buffer.from(Array.from({ length: size ** 2 }, () => rgba).flat()), {
      raw: { width: size, height: size, channels: 4 },
    })
      .png()
      .toBuffer();
  let count = 0;
  async function prepare(mode) {
    const stage = join(root, 'trial' + ++count);
    await mkdir(stage);
    const values2 = new Map(bank.entries);
    if (mode === 'conflict') {
      const old = values2.get(tint + '_c');
      values2.set(tint + '_c', { ...old, crc32: 99 });
    }
    return prepareInstalledGlass({
      input,
      stage,
      s2v: 'trusted-tool',
      getBanks: async () => [bank, { ...bank, entries: values2 }],
      execute: async (_, args) => {
        if (mode === 'cancel') throw new Error('aborted');
        if (args[1].endsWith('.vmat_c'))
          return {
            code: 0,
            stdout:
              mode === 'different-flag'
                ? description.replace('m_nValue = 1', 'm_nValue = 0')
                : description,
          };
        if (args.includes('--block'))
          return {
            code: 0,
            stdout:
              mode === 'spatial' ? header.replace('DisplayRectW = 1', 'DisplayRectW = 4') : header,
          };
        if (mode === 'no-output') return { code: 0 };
        const source = await readFile(args[1], 'utf8'),
          color =
            source === 'dust' ? [128, 64, 32, 51] : [255, 255, mode === 'tinted' ? 128 : 255, 255];
        await writeFile(
          join(args[args.indexOf('-o') + 1], basename(args[1], '.vtex_c') + '.png'),
          await png(mode === 'padded' ? 4 : 1, color),
        );
        return { code: 0 };
      },
    });
  }
  const good = await prepare('match');
  assert.equal(good.proof.length, 1);
  assert.deepEqual(good.proof[0].dustRgba, [128, 64, 32, 51]);
  const document = await new NodeIO().readBinary(glb);
  bindPreparedGlass(document, await readGlassBindings(good.args[1]));
  const [glass, frame] = document.getRoot().listMaterials();
  assert.deepEqual(glass.getExtras().cswatch.constantGlass, {
    schemaVersion: 1,
    castsShadow: false,
  });
  assert.ok(Math.abs(glass.getBaseColorFactor()[0] - 0.21586) < 0.00002);
  assert.equal(glass.getBaseColorFactor()[3], 0.2);
  assert.equal(glass.getMetallicFactor(), 0);
  assert.equal(frame.getExtras().cswatch, undefined);
  for (const failing of ['conflict', 'different-flag', 'spatial', 'no-output', 'padded', 'tinted'])
    assert.deepEqual(await prepare(failing), { args: [], proof: [] }, failing);
  await assert.rejects(prepare('cancel'), /aborted/);
});
