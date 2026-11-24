import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureTransform } from '@gltf-transform/extensions';
import sharp from 'sharp';
import {
  planTextureBudget,
  applyTextureBudget,
  rgbaMipBytes,
  textureBudgetPolicies,
} from './texture-budget.mjs';

test('global decoded budget halves largest effective contributor and preserves color above auxiliary maps', () => {
  const images = [
    { id: 'color', width: 8, height: 8, roles: ['baseColorTexture'] },
    { id: 'aux', width: 8, height: 8, roles: ['normalTexture'] },
  ];
  const plan = planTextureBudget(images, { tier: 'desktop', budgetBytes: 320 });
  assert.equal(plan.residentBaseRGBABytes, 320);
  assert.deepEqual(
    plan.images.map(({ id, width, height }) => ({ id, width, height })),
    [
      { id: 'aux', width: 4, height: 4 },
      { id: 'color', width: 8, height: 8 },
    ],
  );
  assert.deepEqual(
    planTextureBudget([...images].reverse(), { tier: 'desktop', budgetBytes: 320 }),
    plan,
  );
  assert.deepEqual(images[0], { id: 'color', width: 8, height: 8, roles: ['baseColorTexture'] });
});

test('shared AO/ORM images count once, shared color uses highest priority and sampler copies are budgeted', () => {
  const images = [
    {
      id: 'shared',
      width: 8,
      height: 8,
      copies: 2,
      roles: ['occlusionTexture', 'metallicRoughnessTexture', 'baseColorTexture'],
    },
    { id: 'normal', width: 8, height: 8, roles: ['normalTexture'] },
  ];
  const plan = planTextureBudget(images, { tier: 'desktop', budgetBytes: 320 });
  assert.equal(plan.images.length, 2);
  assert.equal(plan.images.find((row) => row.id === 'shared').priority, 2);
  assert.ok(plan.residentBaseRGBABytes <= 320);
  assert.ok(plan.decodedRGBABytes < plan.residentBaseRGBABytes);
});

test('aspect and minimum pixel survive halving, edge caps never enlarge, full mip estimates include thin images', () => {
  const plan = planTextureBudget(
    [
      { id: 'thin', width: 1, height: 1024, roles: [] },
      { id: 'small', width: 3, height: 2, roles: [] },
    ],
    { tier: 'mobile', budgetBytes: 160, maxEdge: 32 },
  );
  const thin = plan.images.find((row) => row.id === 'thin'),
    small = plan.images.find((row) => row.id === 'small');
  assert.deepEqual([thin.width, thin.height], [1, 32]);
  assert.deepEqual([small.width, small.height], [3, 2]);
  assert.equal(rgbaMipBytes(1, 1024), 8188);
  assert.equal(rgbaMipBytes(3, 1), 16);
  assert.equal(textureBudgetPolicies.desktop.budgetBytes, 512 * 1024 ** 2);
  assert.equal(textureBudgetPolicies.mobile.budgetBytes, 256 * 1024 ** 2);
});

test('impossible and malformed budgets fail rather than dropping textures', () => {
  assert.throws(
    () =>
      planTextureBudget([{ id: 'x', width: 1, height: 1, copies: 2, roles: [] }], {
        tier: 'mobile',
        budgetBytes: 7,
      }),
    /one pixel/,
  );
  assert.throws(
    () => planTextureBudget([{ id: 'x', width: 0, height: 4, roles: [] }], { tier: 'desktop' }),
    /metadata/,
  );
  assert.throws(
    () =>
      planTextureBudget([{ id: undefined, width: 4, height: 4, roles: [] }], { tier: 'desktop' }),
    /identifier/,
  );
  assert.throws(
    () =>
      planTextureBudget(
        [
          { id: 'x', width: 4, height: 4, roles: [] },
          { id: 'x', width: 4, height: 4, roles: [] },
        ],
        { tier: 'desktop' },
      ),
    /unique/,
  );
  assert.throws(() => planTextureBudget([], { tier: 'mobile', maxEdge: 2048 }), /policy/);
  assert.deepEqual(planTextureBudget([], { tier: 'mobile' }).images, []);
});

async function model() {
  const document = new Document(),
    buffer = document.createBuffer();
  // Nonconstant images exercise actual textures rather than prune's intentional
  // folding of a uniform texture into a material factor before budgeting.
  const colorPixels = Buffer.alloc(16 * 8 * 4),
    dataPixels = Buffer.alloc(16 * 8 * 3);
  for (let pixel = 0; pixel < 16 * 8; pixel++) {
    colorPixels.set([80 + (pixel % 16), 40 + Math.floor(pixel / 16), 20, 128], pixel * 4);
    dataPixels.set([80 + (pixel % 16), 120 + Math.floor(pixel / 16), 200], pixel * 3);
  }
  const colorImage = await sharp(colorPixels, { raw: { width: 16, height: 8, channels: 4 } })
    .png()
    .toBuffer();
  const dataImage = await sharp(dataPixels, { raw: { width: 16, height: 8, channels: 3 } })
    .png()
    .toBuffer();
  const color = document.createTexture('color').setImage(colorImage).setMimeType('image/png'),
    data = document.createTexture('shared ORM').setImage(dataImage).setMimeType('image/png');
  const material = document
    .createMaterial('Map')
    .setBaseColorTexture(color)
    .setMetallicRoughnessTexture(data)
    .setOcclusionTexture(data)
    .setAlphaMode('BLEND');
  material
    .getBaseColorTextureInfo()
    .setExtension(
      'KHR_texture_transform',
      document.createExtension(KHRTextureTransform).createTransform().setScale([0.25, 0.125]),
    );
  const position = document
    .createAccessor('position')
    .setBuffer(buffer)
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 3, 0, 0, 0, 2, 0]));
  const uv = document
    .createAccessor('uv')
    .setBuffer(buffer)
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('TEXCOORD_0', uv)
    .setMaterial(material);
  const root = document
    .createNode('cswatch_skybox')
    .setExtras({ cswatch: { kind: 'skybox', schemaVersion: 1 } })
    .setScale([16, 16, 16])
    .setTranslation([1, 2, 3]);
  root.addChild(
    document.createNode('native mesh').setMesh(document.createMesh().addPrimitive(primitive)),
  );
  document.createScene().addChild(root);
  return document;
}

test('actual post-compression metadata stays under plan, retains alpha, shared images and exact provenance', async () => {
  const document = await model(),
    positions = Array.from(document.getRoot().listAccessors()[0].getArray());
  const result = await applyTextureBudget(document, { tier: 'mobile', budgetBytes: 64 });
  assert.equal(result.plan.images.length, 2);
  assert.equal(document.getRoot().listTextures().length, 2);
  assert.ok(result.manifest.decodedRGBABytes <= 64);
  assert.ok(result.manifest.residentBaseRGBABytes <= 64);
  assert.equal(
    result.manifest.planSha256,
    createHash('sha256').update(result.planBytes).digest('hex'),
  );
  let actual = 0;
  for (const texture of document.getRoot().listTextures()) {
    const metadata = await sharp(texture.getImage()).metadata();
    actual += metadata.width * metadata.height * 4;
    assert.equal(metadata.format, 'webp');
    if (texture.getName() === 'color') assert.equal(metadata.hasAlpha, true);
  }
  assert.equal(actual, result.manifest.decodedRGBABytes);
  assert.deepEqual(Array.from(document.getRoot().listAccessors()[0].getArray()), positions);
  assert.deepEqual(result.plan.images.find((row) => row.roles.includes('occlusionTexture')).roles, [
    'metallicRoughnessTexture',
    'occlusionTexture',
  ]);
  const reconstructed = JSON.parse(result.planBytes);
  assert.equal(reconstructed.images.length, 2);
  const encodedBefore = document
    .getRoot()
    .listTextures()
    .map((texture) => Buffer.from(texture.getImage()));
  const second = await applyTextureBudget(document, { tier: 'mobile', budgetBytes: 64 });
  for (const [index, texture] of document.getRoot().listTextures().entries())
    assert.deepEqual(Buffer.from(texture.getImage()), encodedBefore[index]);
  assert.equal(second.manifest.sourceEncodedImageBytes, second.manifest.encodedImageBytes);
});

test('identical source images share an encoding only for matching dimensions and alpha processing', async () => {
  const document = new Document();
  const png = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < png.length; i += 4) {
    const pixel = i / 4;
    png[i] = (pixel * 7) % 256;
    png[i + 1] = 200;
    png[i + 2] = 80;
    png[i + 3] = (pixel * 11) % 256;
  }
  const image = await sharp(png, { raw: { width: 32, height: 32, channels: 4 } })
    .png()
    .toBuffer();
  const textures = [];
  for (const mode of ['OPAQUE', 'OPAQUE', 'MASK', 'MASK']) {
    const texture = document.createTexture().setImage(Buffer.from(image)).setMimeType('image/png');
    document.createMaterial().setBaseColorTexture(texture).setAlphaMode(mode).setAlphaCutoff(0.4);
    textures.push(texture);
  }
  const result = await applyTextureBudget(document, {
    tier: 'mobile',
    maxEdge: 16,
    preserveCutoutCoverage: true,
  });
  assert.strictEqual(textures[0].getImage(), textures[1].getImage());
  assert.strictEqual(textures[2].getImage(), textures[3].getImage());
  assert.notStrictEqual(textures[0].getImage(), textures[2].getImage());
  assert.equal(result.plan.images.length, 4);
  assert.equal(result.manifest.residentBaseRGBABytes, 4 * 16 * 16 * 4);
  const partlyResized = await applyTextureBudget(document, {
    tier: 'mobile',
    budgetBytes: 4 * 16 * 16 * 3,
  });
  assert.ok(new Set(partlyResized.plan.images.map((row) => row.actual.width)).size > 1);
  for (const [i, row] of partlyResized.plan.images.entries()) {
    assert.equal((await sharp(textures[i].getImage()).metadata()).width, row.planned.width);
  }
});

test('ordinary map packing applies both default decoded budgets and binds complete texture plans', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-pack-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'source.glb'),
    output = join(root, 'new-packs');
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(input, await model());
  await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL('./prepare-map.mjs', import.meta.url)),
      '--input',
      input,
      '--output',
      output,
      '--map',
      'de_qa',
      '--asset-version',
      'texture-fixture',
    ],
    { timeout: 30000, maxBuffer: 128 * 1024 },
  );
  for (const tier of ['desktop', 'mobile']) {
    const target = join(output, 'de_qa', tier),
      manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')),
      plan = await readFile(join(target, 'texture-plan.json'));
    assert.equal(manifest.textureBudget.budgetBytes, textureBudgetPolicies[tier].budgetBytes);
    assert.equal(manifest.textureBudget.maxEdge, textureBudgetPolicies[tier].maxEdge);
    assert.equal(
      manifest.textureBudget.planSha256,
      createHash('sha256').update(plan).digest('hex'),
    );
    assert.equal(manifest.bytes, (await readFile(join(target, 'scene.glb'))).length);
    assert.equal(JSON.parse(plan).images.length, 2);
  }
});
