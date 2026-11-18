import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import {
  discoverAtmosphericMaterials,
  prepareAtmosphericMaterial,
  patchAtmosphericGlb,
  atmosphericMaterialNames,
  isSupportedAtmosphericMaterial,
} from './prepare-atmosphere.mjs';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';
const material = {
  Name: 'materials/effects/smoke/dust_002_skybox.vmat',
  ShaderName: 'csgo_effects.vfx',
  IntParams: { F_DEPTH_FEATHER: 1, g_nTextureAddressModeU: 0, g_nTextureAddressModeV: 0 },
  FloatParams: { g_flOpacityScale: 1, g_flColorBoost: 1 },
  VectorParams: {
    g_vColorTint: [1, 1, 1, 0],
    g_vMask1Scale: [0.25, 1, 0, 0],
    g_vMask2Scale: [0.5, 0.125, 0, 0],
    g_vMask3Scale: [1, 1, 0, 0],
    g_vMask1PanSpeed: [0.015, 0, 0, 0],
    g_vMask2PanSpeed: [0.015, 0.005, 0, 0],
    g_vMask3PanSpeed: [0, 0, 0, 0],
  },
  TextureParams: {
    g_tColor: 'materials/effects/color.vtex',
    g_tMask1: 'materials/effects/mask1.vtex',
    g_tMask2: 'materials/effects/mask2.vtex',
    g_tMask3: 'materials/effects/mask1.vtex',
  },
};
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-atmosphere-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function image(path, rgba, width = 4, height = 2) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++)
    data.set(typeof rgba === 'function' ? rgba(i % width, Math.floor(i / width)) : rgba, i * 4);
  await writeFile(
    path,
    await sharp(data, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
  return path;
}
async function inputs(root) {
  return {
    colorPath: await image(join(root, 'color.png'), [255, 80, 20, 128]),
    maskPaths: {
      mask1: await image(join(root, 'mask1.png'), [64, 255, 0, 255], 2, 4),
      mask2: await image(join(root, 'mask2.png'), [128, 255, 0, 255]),
      mask3: await image(join(root, 'mask3.png'), [255, 0, 0, 255]),
    },
  };
}
async function model(path, native) {
  const d = new Document(),
    b = d.createBuffer(),
    position = d
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(b),
    color = d
      .createAccessor()
      .setType('VEC4')
      .setArray(new Uint8Array([255, 255, 255, 128, 255, 255, 255, 255, 255, 255, 255, 64]))
      .setNormalized(true)
      .setBuffer(b);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer();
  const texture = d.createTexture().setImage(png).setMimeType('image/png');
  const m = d
    .createMaterial('Atmosphere')
    .setBaseColorTexture(texture)
    .setAlphaMode('BLEND')
    .setExtras({ vmat: native });
  d.createScene().addChild(
    d
      .createNode('world')
      .setMesh(
        d
          .createMesh()
          .addPrimitive(
            d
              .createPrimitive()
              .setAttribute('POSITION', position)
              .setAttribute('COLOR_0', color)
              .setMaterial(m),
          ),
      ),
  );
  await new NodeIO().write(path, d);
}

test('phase0 alpha multiplies genuine color alpha and three LINEAR red masks, ignoring tint component4', async (t) => {
  const root = await scratch(t),
    source = await inputs(root),
    output = join(root, 'baked.png');
  const result = await prepareAtmosphericMaterial({ material, ...source, output });
  assert.deepEqual(result.textureScale, [0.25, 0.125]);
  assert.equal(result.report.width, 16);
  assert.equal(result.report.height, 16);
  const bytes = await sharp(output).raw().toBuffer();
  for (let index = 0; index < bytes.length; index += 4) {
    assert.deepEqual([...bytes.subarray(index, index + 3)], [255, 80, 20]);
    assert.equal(bytes[index + 3], Math.round(128 * (64 / 255) * (128 / 255)));
  }
  assert.ok(result.report.alpha.max > 0);
  assert.equal(result.report.phase, 0);
  assert.ok(result.report.omitted.some((line) => line.includes('depth')));
  await assert.rejects(prepareAtmosphericMaterial({ material, ...source, output }), /EEXIST/);
});

test('supertile preserves fractional authored mask periods beyond a single color repeat', async (t) => {
  const root = await scratch(t),
    source = await inputs(root),
    native = structuredClone(material);
  native.VectorParams.g_vMask2Scale = [1, 1, 0, 0];
  await image(source.colorPath, [20, 40, 80, 255]);
  await image(source.maskPaths.mask1, (x) => [x === 0 ? 0 : 255, 0, 0, 255], 2, 2);
  await image(source.maskPaths.mask2, [255, 0, 0, 255]);
  const output = join(root, 'period.png'),
    result = await prepareAtmosphericMaterial({ material: native, ...source, output });
  assert.deepEqual(result.textureScale, [0.25, 1]);
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 16);
  assert.notEqual(data[3], data[4 * 4 + 3]);
  // Seam samples wrap into the final source texel rather than clamp to a border.
  assert.ok(data[3] > 0 && data[3] < 128);
  assert.ok(data[15 * 4 + 3] > 128 && data[15 * 4 + 3] < 255);
});

test('exact main dust uses proven native missing-vector defaults and clouds boost RGB in linear space', async (t) => {
  const root = await scratch(t),
    source = await inputs(root),
    dust = structuredClone(material);
  dust.Name = 'materials/effects/smoke/dust_002.vmat';
  delete dust.VectorParams.g_vMask3Scale;
  delete dust.VectorParams.g_vMask3PanSpeed;
  const preparedDust = await prepareAtmosphericMaterial({
    material: dust,
    ...source,
    output: join(root, 'dust.png'),
  });
  assert.deepEqual(preparedDust.report.defaultedVectors, {
    g_vMask3Scale: [1, 1],
    g_vMask3PanSpeed: [0, 0],
  });
  assert.equal(preparedDust.report.nativeShaderMetadataCrc, 'ab01f065');
  const clouds = structuredClone(material);
  clouds.Name = 'materials/effects/clouds_001.vmat';
  clouds.FloatParams.g_flColorBoost = 1.5;
  clouds.VectorParams.g_vMask1Scale = [5, 6, 0, 0];
  clouds.VectorParams.g_vMask2Scale = [1, 1.5, 0, 0];
  clouds.VectorParams.g_vMask3Scale = [5, 5, 0, 0];
  await image(source.colorPath, [80, 120, 160, 128]);
  for (const path of Object.values(source.maskPaths)) await image(path, [255, 0, 0, 255]);
  const preparedClouds = await prepareAtmosphericMaterial({
    material: clouds,
    ...source,
    output: join(root, 'clouds.png'),
  });
  assert.deepEqual(preparedClouds.textureScale, [1, 0.5]);
  assert.equal(preparedClouds.report.colorBoost, 1.5);
  const rgba = await sharp(preparedClouds.imagePath).raw().toBuffer();
  assert.deepEqual([...rgba.subarray(0, 4)], [97, 145, 192, 128]);
  assert.equal(atmosphericMaterialNames.length, 3);
  for (const name of atmosphericMaterialNames) {
    const native = { ...material, Name: name };
    assert.ok(isSupportedAtmosphericMaterial(native));
    const path = join(root, name.split('/').at(-1) + '.glb');
    await model(path, native);
    assert.equal((await discoverAtmosphericMaterials(path))[0].material.Name, name);
  }
  assert.equal(
    isSupportedAtmosphericMaterial({ ...material, Name: 'materials/effects/unknown.vmat' }),
    false,
  );
});

test('GLB patch appends image data while preserving all original BIN bytes and geometry/vertex-alpha metadata', async (t) => {
  const root = await scratch(t),
    input = join(root, 'source.glb');
  await model(input, material);
  const discovered = await discoverAtmosphericMaterials(input);
  assert.equal(discovered[0].material.Name, material.Name);
  assert.equal(discovered[0].resources.mask3, material.TextureParams.g_tMask3);
  const source = await readAtmosphereGlb(input, true),
    encoded = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ffffff40' } })
      .webp()
      .toBuffer(),
    output = join(root, 'patched.glb');
  const result = await patchAtmosphericGlb({
    input,
    output,
    materialName: material.Name,
    imageBytes: encoded,
    textureScale: [0.25, 0.125],
  });
  const patched = await readAtmosphereGlb(output, true);
  assert.deepEqual(patched.bin.subarray(0, source.bin.length), source.bin);
  for (const key of ['nodes', 'meshes', 'accessors', 'scenes'])
    assert.deepEqual(patched.document[key], source.document[key]);
  assert.equal(result.report.originalBinSha256, result.report.retainedBinSha256);
  const m = patched.document.materials[0],
    info = m.pbrMetallicRoughness.baseColorTexture;
  assert.deepEqual(info.extensions.KHR_texture_transform.scale, [0.25, 0.125]);
  assert.equal(m.alphaMode, 'BLEND');
  assert.deepEqual(m.extensions.KHR_materials_unlit, {});
  assert.deepEqual(m.extras.vmat, material);
  const texture = patched.document.textures[info.index],
    imageIndex = texture.extensions.EXT_texture_webp.source,
    view = patched.document.bufferViews[patched.document.images[imageIndex].bufferView];
  assert.deepEqual(
    patched.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength),
    encoded,
  );
  assert.ok(patched.document.extensionsRequired.includes('EXT_texture_webp'));
  assert.ok(patched.document.extensionsRequired.includes('KHR_texture_transform'));
  assert.ok(patched.document.extensionsRequired.includes('KHR_materials_unlit'));
  await assert.rejects(
    patchAtmosphericGlb({
      input,
      output,
      materialName: material.Name,
      imageBytes: encoded,
      textureScale: [0.25, 0.125],
    }),
    /EEXIST/,
  );
  await assert.rejects(
    patchAtmosphericGlb({
      input,
      output: input,
      materialName: material.Name,
      imageBytes: encoded,
      textureScale: [0.25, 0.125],
    }),
    /new output/,
  );
});

test('unsupported sources, nonwrap sampling, unbounded periods and symlink images fail closed', async (t) => {
  const root = await scratch(t),
    source = await inputs(root);
  for (const change of [
    (m) => (m.ShaderName = 'other.vfx'),
    (m) => (m.IntParams.g_nTextureAddressModeU = 2),
    (m) => (m.VectorParams.g_vMask1Scale = [0.31, 1, 0, 0]),
    (m) => (m.TextureParams.g_tMask1 = 'https://example.test/a.vtex'),
    (m) => (m.IntParams.F_ADDITIVE_BLEND = 1),
    (m) => (m.FloatParams.g_flColorBoost = 17),
    (m) => (m.VectorParams.g_vColorTint = [0.5, 1, 1, 0]),
    (m) => (m.VectorParams.g_vMask3PanSpeed = [NaN, 0, 0, 0]),
    (m) => (m.IntParams.F_UNSUPPORTED_FUTURE = 1),
  ]) {
    const native = structuredClone(material);
    change(native);
    await assert.rejects(
      prepareAtmosphericMaterial({
        material: native,
        ...source,
        output: join(root, 'blocked.png'),
      }),
    );
  }
  await symlink(source.colorPath, join(root, 'link.png'));
  await assert.rejects(
    prepareAtmosphericMaterial({
      material,
      ...source,
      colorPath: join(root, 'link.png'),
      output: join(root, 'linked.png'),
    }),
    /ELOOP/,
  );
  const input = join(root, 'bad.glb');
  await model(input, { ...material, ShaderName: 'other.vfx' });
  await assert.rejects(discoverAtmosphericMaterials(input), /Unsupported/);
});
