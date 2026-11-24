import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import sharp from 'sharp';
import { prepareEnvironmentAlbedo } from './map-environment-layers.mjs';
import { colorAdjustment, colorAxes, textureReflectivity } from './material-color-adjust.mjs';
import { linearToSrgb, srgbToLinear } from './environment-space.mjs';
import {
  environmentLayerExtension,
  MapEnvironmentAlbedoExtension,
} from './map-environment-layer-extension.mjs';
import { resizeLayerImage, prepareInstalledBakedLighting } from './install-map-baked-lighting.mjs';
import { readMapLayerImages } from './prepare-map-layers.mjs';
import { nativeLightingKey } from './native-map-lighting-layout.mjs';
import { applyTextureBudget } from './texture-budget.mjs';

const vmat = {
  Name: 'materials/test/stone.vmat',
  ShaderName: 'csgo_environment_blend.vfx',
  TextureParams: {
    g_tHeight1: 'materials/test/height.vtex',
    g_tColor2: 'materials/test/moss.vtex',
    g_tHeight2: 'materials/test/height.vtex',
  },
  IntParams: { g_nUVSet2: 2 },
  VectorParams: { g_vTexCoordScale2: [2, 2, 0, 0] },
};
const io = () =>
  new NodeIO().registerExtensions([...ALL_EXTENSIONS, MapEnvironmentAlbedoExtension]);
async function fixture() {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const attr = (type, values) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const colors = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#528035' },
  })
    .png()
    .toBuffer();
  const rgba = Buffer.alloc(8 * 4 * 4);
  for (let i = 0; i < 32; i++) {
    rgba[4 * i] = 64;
    rgba[4 * i + 1] = 128;
  }
  const source = await sharp(rgba, { raw: { width: 8, height: 4, channels: 4 } })
    .png()
    .toBuffer();
  const heights = await resizeLayerImage(source, 4);
  const texture = doc.createTexture().setImage(colors).setMimeType('image/png');
  const material = doc.createMaterial().setBaseColorTexture(texture).setExtras({ vmat });
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', attr('VEC3', [0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setAttribute('TEXCOORD_0', attr('VEC2', [0, 0, 1, 0, 0, 1]))
    .setAttribute('TEXCOORD_1', attr('VEC2', [0, 0.5, 0.1, 0.5, 0.2, 0.5]))
    .setAttribute('TEXCOORD_2', attr('VEC2', [0, 0, 2, 0, 0, 2]))
    .setAttribute('_TEXCOORD_4', attr('VEC4', [0, 0, 0, 0.15, 0.5, 0, 0, 0.15, 1, 0, 0, 0.15]))
    .setIndices(
      doc
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array([0, 1, 2]))
        .setBuffer(buffer),
    )
    .setMaterial(material);
  const name = 'surface',
    mesh = doc.createMesh(name).addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return {
    doc,
    mesh,
    primitive,
    images: new Map([
      [vmat.TextureParams.g_tHeight1 + '_c', { bytes: heights }],
      [vmat.TextureParams.g_tColor2 + '_c', { bytes: colors }],
    ]),
    key: nativeLightingKey(name, vmat.Name, 3, 3),
    colors,
  };
}

test('painted albedo requires the source UV, keeps transparent height RGB and survives the tier encoder', async () => {
  const { doc, primitive, images, key } = await fixture();
  assert.equal(await prepareEnvironmentAlbedo(doc, images), undefined);
  assert.equal(await prepareEnvironmentAlbedo(doc, images, new Map([[key, -1]])), undefined);
  assert.deepEqual(await prepareEnvironmentAlbedo(doc, images, new Map([[key, 2]])), {
    paintedPrimitives: 1,
    overlayPrimitives: 0,
    textures: 2,
  });
  assert.equal(primitive.getAttribute('_CSWATCH_UV_SECOND'), primitive.getAttribute('TEXCOORD_2'));
  await doc.transform(dedup(), prune({ keepSolidTextures: true }));
  const { plan } = await applyTextureBudget(doc, { tier: 'desktop' });
  assert.ok(plan.images.some((i) => i.roles.includes('baseHeight')));
  const result = await io().readBinary(await io().writeBinary(doc));
  const p = result.getRoot().listMeshes()[0].listPrimitives()[0];
  const binding = p.getMaterial().getExtension(environmentLayerExtension);
  assert.deepEqual(binding.getParameters().layers[0].uv, [2, 0, 0, 2, 0, 0]);
  const height = await sharp(binding.getTexture('baseHeight').getImage()).raw().toBuffer();
  assert.deepEqual([...height.subarray(0, 2)], [64, 128]);
  const layer = await sharp(binding.getTexture('paintLayer2').getImage()).raw().toBuffer();
  assert.equal(layer[3], 65);
  assert.equal(p.getAttribute('_CSWATCH_UV_SECOND').getCount(), 3);
});

test('collects CRC-selected model tint masks on a map without an irradiance atlas', async (t) => {
  const stage = await mkdtemp(join(tmpdir(), 'cswatch-tint-source-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const { doc, primitive, colors } = await fixture();
  const path = 'models/props/table_mask.vtex';
  primitive
    .getMaterial()
    .setBaseColorFactor([0.4, 0.3, 1, 1])
    .setExtras({
      vmat: {
        ShaderName: 'csgo_foliage.vfx',
        IntParams: { F_TINT_MASK: 1 },
        TextureParams: { g_tTintMask: path },
      },
    });
  const input = join(stage, 'source.glb');
  await io().write(input, doc);
  const bank = {
    entries: new Map([[path + '_c', { length: 4, preloadBytes: 0, crc32: 401 }]]),
    readEntry: async (key) => (key === path + '_c' ? Buffer.from([9, 5, 2, 8]) : undefined),
  };
  const result = await prepareInstalledBakedLighting({
    map: 'de_test',
    input,
    stage,
    packageFile: 'map.vpk',
    game: stage,
    hasHeadroom: async () => true,
    index: async () => bank,
    s2v: 'test-s2v',
    execute: async (_cmd, args, tag) => {
      assert.match(tag, /^lightmap-layer-/);
      await writeFile(args[1].replace('.vtex_c', '.png'), colors);
      return { code: 0 };
    },
  });
  assert.equal(result.proof.path, 'pbr');
  assert.equal(result.proof.layers[0].crc32, 401);
  const images = await readMapLayerImages(result.args[result.args.indexOf('--layer-images') + 1]);
  assert.deepEqual(images.get(path + '_c').bytes, colors);
});

test('reads the linear reflectivity only from a bounded version 1 VTEX DATA header', () => {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(48, 0);
  bytes.writeUInt16LE(12, 4);
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt32LE(8, 8);
  bytes.writeUInt32LE(1, 12);
  bytes.write('DATA', 16);
  bytes.writeUInt32LE(8, 20);
  bytes.writeUInt32LE(20, 24);
  bytes.writeUInt16LE(1, 28);
  [0.5, 0.25, 0.75].forEach((v, i) => bytes.writeFloatLE(v, 32 + 4 * i));
  assert.deepEqual(textureReflectivity(bytes), [0.5, 0.25, 0.75]);
  assert.equal(textureReflectivity(bytes.subarray(0, 47)), undefined);
  bytes.writeFloatLE(NaN, 36);
  assert.equal(textureReflectivity(bytes), undefined);
  bytes.writeFloatLE(0.25, 36);
  bytes.writeUInt16LE(2, 28);
  assert.equal(textureReflectivity(bytes), undefined);
});

test('bakes upper albedo in linear space using the native correction mode and keeps height separate', async () => {
  const pivot = [0.25, 0.5, 0.75];
  const axes = colorAxes({ values: [2, 1, 0.5], mode: 0, mask: [2, 1] }, pivot);
  assert.deepEqual(axes, { scale: [1, 0], offset: [-0.125, -0.25, -0.375], mode: 0, mask: [2, 1] });
  assert.equal(
    colorAdjustment(
      {
        FloatParams: { g_fTextureColorBrightness2: 0.5 },
        VectorParams: { g_vTextureColorTint2: [0.5, 1, 1] },
      },
      2,
    ),
    undefined,
  );
  for (const mode of [0, 1]) {
    const { doc, primitive, images, key } = await fixture();
    const material = primitive.getMaterial();
    material.setExtras({
      vmat: {
        ...vmat,
        IntParams: { ...vmat.IntParams, g_nColorCorrectionMode2: mode },
        FloatParams: { g_fTextureColorBrightness2: 0.5 },
      },
    });
    const texture = images.get(vmat.TextureParams.g_tColor2 + '_c');
    texture.reflectivity = pivot;
    await prepareEnvironmentAlbedo(doc, images, new Map([[key, 2]]));
    const binding = primitive.getMaterial().getExtension(environmentLayerExtension);
    const pixels = await sharp(binding.getTexture('paintLayer2').getImage()).raw().toBuffer();
    const weight = mode === 1 ? 1 : 128 / 255;
    assert.deepEqual(
      [...pixels.subarray(0, 3)],
      [0x52, 0x80, 0x35].map((x) =>
        Math.round(linearToSrgb(srgbToLinear(x / 255) * (1 - weight * 0.5)) * 255),
      ),
    );
    assert.equal(pixels[3], 65);
  }
});
