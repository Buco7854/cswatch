import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { bakeMapTintMasks, mapTintMaskKey } from './prepare-map-tint.mjs';

const resource = 'models/example/mask.vtex';
const fixtureVmat = (environment) =>
  environment
    ? { ShaderName: 'csgo_environment.vfx', TextureParams: { g_tHeight1: resource } }
    : {
        ShaderName: 'csgo_foliage.vfx',
        IntParams: { F_TINT_MASK: 1 },
        TextureParams: { g_tTintMask: resource },
      };
const png = (bytes) =>
  sharp(Buffer.from(bytes), { raw: { width: 2, height: 1, channels: 4 } })
    .png()
    .toBuffer();

test('masked tint uses height G or foliage R, keeps cutout alpha and shares identical painted variants', async () => {
  const doc = new Document();
  const base = doc
    .createTexture('albedo')
    .setImage(await png([160, 160, 160, 200, 160, 160, 160, 71]))
    .setMimeType('image/png');
  const rows = [true, true, false].map((environment) => {
    const m = doc
      .createMaterial()
      .setBaseColorTexture(base)
      .setNormalTexture(base)
      .setBaseColorFactor([0.6, 0.12, 0.12, 0.8]);
    m.getBaseColorTextureInfo().setTexCoord(1).setWrapS(33071);
    return m.setExtras({ vmat: fixtureVmat(environment) });
  });
  await bakeMapTintMasks(
    doc,
    new Map([[resource + '_c', { bytes: await png([255, 0, 0, 255, 0, 255, 0, 255]) }]]),
    'desktop',
  );
  for (const m of rows) {
    assert.deepEqual(m.getBaseColorFactor(), [1, 1, 1, 0.8]);
    assert.equal(m.getNormalTexture(), base);
    assert.equal(m.getBaseColorTextureInfo().getTexCoord(), 1);
    assert.equal(m.getBaseColorTextureInfo().getWrapS(), 33071);
  }
  assert.equal(rows[0].getBaseColorTexture(), rows[1].getBaseColorTexture());
  assert.notEqual(rows[0].getBaseColorTexture(), rows[2].getBaseColorTexture());
  const [height, foliage] = await Promise.all(
    [rows[0], rows[2]].map((m) => sharp(m.getBaseColorTexture().getImage()).raw().toBuffer()),
  );
  assert.deepEqual([...height.subarray(0, 4)], [160, 160, 160, 200]);
  assert.ok(height[4] > height[5] && height[4] > 160);
  assert.equal(height[7], 71);
  assert.ok(foliage[0] > foliage[1] && foliage[0] < 160);
  assert.equal(foliage[3], 200);
  assert.deepEqual([...foliage.subarray(4)], [160, 160, 160, 71]);
});

test('tint selection requires a verified supported Source role, usable instance factor and available pixels', async () => {
  for (const vmat of [
    { ...fixtureVmat(true), ShaderName: 'unknown.vfx' },
    { ...fixtureVmat(false), IntParams: {} },
    { ...fixtureVmat(true), FloatParams: { g_flModelTintAmount: 0.6 } },
    { ...fixtureVmat(true), VectorParams: { g_vColorTint: [1, 0.5, 1, 1] } },
    { ...fixtureVmat(true), TextureParams: { g_tHeight1: 'materials/../private.vtex' } },
  ])
    assert.equal(mapTintMaskKey(vmat, [0, 1, 0, 1]), undefined);
  assert.equal(mapTintMaskKey(fixtureVmat(true), [1, 1, 1, 1]), undefined);
  const doc = new Document(),
    tint = [0.2, 0.8, 0.3, 1];
  const source = doc
    .createTexture('base')
    .setImage(await png([100, 50, 60, 255, 10, 20, 80, 255]))
    .setMimeType('image/png');
  const mat = doc
    .createMaterial()
    .setBaseColorTexture(source)
    .setBaseColorFactor(tint)
    .setExtras({ vmat: fixtureVmat(true) });
  await bakeMapTintMasks(doc, new Map([['other.vtex_c', { bytes: new Uint8Array() }]]), 'mobile');
  assert.equal(mat.getBaseColorTexture(), source);
  assert.deepEqual(mat.getBaseColorFactor(), tint);
});

test('downsampling a mask preserves its data under zero alpha', async () => {
  const doc = new Document();
  const base = doc
    .createTexture()
    .setImage(await png([200, 200, 200, 255, 200, 200, 200, 255]))
    .setMimeType('image/png');
  const m = doc
    .createMaterial()
    .setBaseColorTexture(base)
    .setBaseColorFactor([0.25, 0.8, 0.3, 1])
    .setExtras({ vmat: fixtureVmat(false) });
  const maskPixels = Buffer.from(Array.from({ length: 4 }, () => [255, 0, 0, 0]).flat());
  const bytes = await sharp(maskPixels, { raw: { width: 4, height: 1, channels: 4 } })
    .png()
    .toBuffer();
  await bakeMapTintMasks(doc, new Map([[resource + '_c', { bytes }]]), 'mobile');
  const data = await sharp(m.getBaseColorTexture().getImage()).raw().toBuffer();
  assert.ok(data[0] < 150 && data[1] > data[0]);
});
