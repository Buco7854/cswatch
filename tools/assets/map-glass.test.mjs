import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
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
  function sourceGlb(textured = false) {
    return triangle((d) => {
      d.meshes[0].primitives[0].material = 0;
      if (textured) {
        d.accessors.push({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC2' });
        d.meshes[0].primitives[0].attributes.TEXCOORD_0 = 1;
      }
      d.materials = [
        {
          alphaMode: 'BLEND',
          extras: {
            vmat: {
              Name: name,
              ShaderName: 'csgo_glass.vfx',
              IntParams: { F_DO_NOT_CAST_SHADOWS: 1 },
              ...(textured
                ? {
                    FloatParams: { g_flModelTintAmount: 1 },
                    VectorParams: { g_flTranslucencyRemap: [0.25, 0.75, 0, 0] },
                  }
                : {}),
              TextureParams: { g_tGlassDust: dust, g_tGlassTintColor: tint },
            },
          },
        },
        { name: 'solid frame' },
      ];
    });
  }
  const glb = sourceGlb();
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
    const textured = mode.startsWith('image');
    await writeFile(input, sourceGlb(textured));
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
                : textured
                  ? description.replace(
                      'm_floatParams = [ ]',
                      'm_floatParams = [ { m_name = "g_flModelTintAmount" m_flValue = 1.0 } ]\nm_vectorParams = [ { m_name = "g_flTranslucencyRemap" m_value = [ ' +
                        (mode === 'image-disagreement' ? '0.5' : '0.25') +
                        ', 0.75, 0, 0 ] } ]',
                    )
                  : description,
          };
        const source = await readFile(args[1], 'utf8');
        if (args.includes('--block'))
          return {
            code: 0,
            stdout:
              mode === 'spatial'
                ? header.replace('DisplayRectW = 1', 'DisplayRectW = 4')
                : textured && source === 'dust'
                  ? header
                      .replace(
                        'Width = 4',
                        'Width = ' + (mode === 'image-oversized' ? '4096' : '8'),
                      )
                      .replace('Height = 4', 'Height = 8') + 'Format = 20 (VTEX_FORMAT_BC7)\n'
                  : header,
          };
        if (mode === 'no-output') return { code: 0 };
        const color =
          source === 'dust'
            ? [128, 64, 32, 51]
            : [
                255,
                255,
                mode === 'tinted' || mode === 'image-tinted' ? 128 : 255,
                textured ? 124 : 255,
              ];
        await writeFile(
          join(args[args.indexOf('-o') + 1], basename(args[1], '.vtex_c') + '.png'),
          textured && source === 'dust'
            ? await sharp(
                Buffer.from(
                  Array.from({ length: 64 }, (_, i) => [128, 64, 32, i % 2 ? 255 : 0]).flat(),
                ),
                { raw: { width: 8, height: 8, channels: 4 } },
              )
                .png()
                .toBuffer()
            : await png(mode === 'padded' ? 4 : 1, color),
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
  const result = await prepare('image');
  assert.equal(result.proof.length, 1);
  assert.equal(result.proof[0].tintRgba[3], 124);
  const rows = await readGlassBindings(result.args[1]);
  const doc = await new NodeIO().readBinary(sourceGlb(true));
  bindPreparedGlass(doc, rows);
  const mat = doc.getRoot().listMaterials()[0];
  assert.equal(mat.getExtras().cswatch.texturedGlass.castsShadow, false);
  const image = mat.getBaseColorTexture().getImage();
  const rgba = await sharp(image).raw().toBuffer();
  assert.deepEqual([...rgba.subarray(0, 8)], [128, 64, 32, 64, 128, 64, 32, 191]);
  assert.deepEqual(mat.getBaseColorFactor(), [1, 1, 1, 1]);
  await writeFile(join(dirname(result.args[1]), rows[0].image.file), Buffer.alloc(64));
  await assert.rejects(readGlassBindings(result.args[1]), /disagrees/);
  for (const mode of ['image-disagreement', 'image-oversized', 'image-tinted'])
    assert.deepEqual(await prepare(mode), { args: [], proof: [] }, mode);
});
