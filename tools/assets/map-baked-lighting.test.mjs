import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import sharp from 'sharp';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };
import { MapBakedLightingExtension } from './map-baked-lighting-extension.mjs';
import { bindBakedLighting } from './prepare-baked-lighting.mjs';
import { applyTextureBudget, planTextureBudget } from './texture-budget.mjs';
import { prepareInstalledBakedLighting } from './install-map-baked-lighting.mjs';

for (const details of [1, 2])
  test(`prepared lightmap retains atlas, directional binding and ${details} painted detail texture(s)`, async () => {
    const d = new Document();
    const buffer = d.createBuffer();
    const uv = d
      .createAccessor()
      .setType('VEC2')
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
      .setBuffer(buffer);
    const position = d
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const material = d.createMaterial().setExtras({
      vmat: {
        Name: 'materials/qa/brick.vmat',
        ShaderName: 'csgo_lightmappedgeneric.vfx',
        IntParams: { F_LAYERS: 1, F_FANCY_BLENDING: 1, F_DETAILTEXTURE: details },
        VectorParams: {
          g_vLayer1DetailScale: [8, 8],
          g_vLayer1DetailTintAndBlend: [1, 1, 1, 0.25],
          g_vLayer2DetailScale: [2, 3],
          g_vLayer2DetailTintAndBlend: [1, 1, 1, 0.75],
        },
        TextureParams: {
          g_tLayer2Color: 'materials/qa/layer.vtex',
          g_tBlendModulation: 'materials/qa/mask.vtex',
          g_tLayer1Detail: 'materials/qa/detail.vtex',
          g_tLayer2Detail: 'materials/qa/sand.vtex',
        },
      },
    });
    const primitive = d
      .createPrimitive()
      .setMaterial(material)
      .setAttribute('POSITION', position)
      .setAttribute('TEXCOORD_0', uv)
      .setAttribute('TEXCOORD_1', uv)
      .setAttribute(
        format.layerAttribute,
        d
          .createAccessor()
          .setType('VEC4')
          .setArray(new Float32Array([0.3, 0, 0, 1, 1, 0, 0, 1, 0.1, 0, 0, 1]))
          .setBuffer(buffer),
      );
    d.createScene().addChild(d.createNode().setMesh(d.createMesh().addPrimitive(primitive)));
    const image = async (background) =>
      sharp({ create: { width: 16, height: 16, channels: 4, background } })
        .webp({ lossless: true })
        .toBuffer();
    const bytes = await image({ r: 32, g: 160, b: 0, alpha: 0.4 });
    const directionBytes = await image({ r: 130, g: 125, b: 34, alpha: 1 });
    material.setBaseColorTexture(
      d
        .createTexture('original color')
        .setMimeType('image/webp')
        .setImage(await image({ r: 80, g: 96, b: 48, alpha: 1 })),
    );
    const png = (background) =>
      sharp({ create: { width: 16, height: 16, channels: 3, background } })
        .png()
        .toBuffer();
    const layerImages = new Map([
      ['materials/qa/layer.vtex_c', { bytes: await png('#f00'), role: 'g_tLayer2Color' }],
      ['materials/qa/mask.vtex_c', { bytes: await png('#0f0'), role: 'g_tBlendModulation' }],
      ['materials/qa/detail.vtex_c', { bytes: await png('#00f'), role: 'g_tLayer1Detail' }],
      ['materials/qa/sand.vtex_c', { bytes: await png('#fc0') }],
    ]);
    const result = bindBakedLighting(
      d,
      { bytes, directionBytes, edge: 16, irradianceRange: 128 },
      layerImages,
    );
    assert.equal(result.primitives, 1);
    assert.equal(result.layeredPrimitives, 1);
    await d.transform(dedup(), prune({ keepSolidTextures: true }));
    await applyTextureBudget(d, { tier: 'mobile' });
    const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, MapBakedLightingExtension]);
    const restored = await io.readBinary(await io.writeBinary(d));
    const surface = restored.getRoot().listMeshes()[0].listPrimitives()[0];
    const baked = surface.getMaterial().getExtension(format.extension);
    assert.equal(baked.getRange(), 128);
    assert.deepEqual([...surface.getAttribute('TEXCOORD_1').getArray()], [0, 0, 1, 0, 0, 1]);
    assert.deepEqual(Buffer.from(baked.getTexture().getImage()), bytes);
    assert.deepEqual(Buffer.from(baked.getDirection().getImage()), directionBytes);
    assert.equal(surface.getAttribute(format.layerAttribute).getType(), 'VEC4');
    assert.deepEqual(baked.getLayerDetail(), {
      detailScale: [8, 8],
      detailStrength: 0.25,
      ...(details === 2 ? { secondDetailScale: [2, 3], secondDetailStrength: 0.75 } : {}),
    });
    assert.equal(
      baked.getLayerTexture('secondDetailTexture')?.getName(),
      details === 2 ? 'sand' : undefined,
    );
    assert.equal(baked.getLayerTexture('layerColorTexture').getName(), 'layer');
    assert.equal(baked.getLayerTexture('layerBlendTexture').getName(), 'mask');
    assert.equal(baked.getLayerTexture('layerDetailTexture').getName(), 'detail');
  });

test('authored atlas pixels are budgeted without resizing ordinary chart data away', () => {
  const plan = planTextureBudget(
    [
      { id: 'baked', width: 1024, height: 1024, roles: ['irradianceTexture'] },
      { id: 'wall', width: 1024, height: 1024, roles: ['baseColorTexture'] },
    ],
    { tier: 'mobile', budgetBytes: 5 * 1024 ** 2 },
  );
  assert.equal(plan.images[0].width, 1024);
  assert.equal(plan.images[1].width, 512);
  assert.equal(plan.residentBaseRGBABytes, 5 * 1024 ** 2);
});

test('low extra scratch headroom skips the optional native atlas before touching inputs', async () => {
  const requested = [];
  const result = await prepareInstalledBakedLighting({
    hasHeadroom: async (bytes) => {
      requested.push(bytes);
      return false;
    },
  });
  assert.deepEqual(result, { args: [], proof: { path: 'pbr', reason: 'lightmap_storage_budget' } });
  assert.deepEqual(requested, [672 * 1024 ** 2]);
});
