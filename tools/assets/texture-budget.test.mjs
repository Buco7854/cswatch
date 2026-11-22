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
import { retierPreparedMap } from './retier-map.mjs';

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

test('retiering creates a new verified tier with geometry/tag/alpha intact and refuses live overwrite or relabeling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-retier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = join(root, 'input'),
    output = join(root, 'new-mobile');
  await mkdir(inputDir);
  const input = join(inputDir, 'scene.glb');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS),
    original = await model();
  await io.write(input, original);
  const before = await readFile(input),
    sourceHash = createHash('sha256').update(before).digest('hex');
  await writeFile(
    join(inputDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      map: 'de_qa',
      tier: 'mobile',
      bytes: before.length,
      outputSha256: sourceHash,
      assetVersion: 'texture-fixture',
      s2v: 'original-fixture',
    }),
  );
  const result = await retierPreparedMap({
    input,
    output,
    map: 'de_qa',
    tier: 'mobile',
    budgetBytes: 64,
  });
  assert.equal(result.manifest.sourceSha256, sourceHash);
  assert.equal(result.manifest.sourceBytes, before.length);
  assert.equal(result.manifest.assetVersion, 'texture-fixture');
  assert.ok(result.manifest.textureBudget.decodedRGBABytes <= 64);
  assert.equal(
    result.manifest.outputSha256,
    createHash('sha256')
      .update(await readFile(result.path))
      .digest('hex'),
  );
  const after = await io.read(result.path);
  assert.deepEqual(
    Array.from(after.getRoot().listAccessors()[0].getArray()),
    Array.from(original.getRoot().listAccessors()[0].getArray()),
  );
  const sky = after
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'cswatch_skybox');
  assert.deepEqual(sky.getExtras(), { cswatch: { kind: 'skybox', schemaVersion: 1 } });
  assert.deepEqual(sky.getScale(), [16, 16, 16]);
  assert.deepEqual(sky.getTranslation(), [1, 2, 3]);
  assert.deepEqual(
    after
      .getRoot()
      .listMaterials()[0]
      .getBaseColorTextureInfo()
      .getExtension('KHR_texture_transform')
      .getScale(),
    [0.25, 0.125],
  );
  const plan = await readFile(join(output, 'texture-plan.json'));
  assert.equal(
    createHash('sha256').update(plan).digest('hex'),
    result.manifest.textureBudget.planSha256,
  );
  await assert.rejects(
    retierPreparedMap({ input, output, map: 'de_qa', tier: 'mobile', budgetBytes: 64 }),
    /EEXIST/,
  );
  await assert.rejects(
    retierPreparedMap({ input, output: inputDir, map: 'de_qa', tier: 'mobile' }),
    /new output/,
  );
  await assert.rejects(
    retierPreparedMap({ input, output: join(root, 'wrong'), map: 'de_other', tier: 'mobile' }),
    /does not match/,
  );
  const manifest = join(inputDir, 'manifest.json');
  const unbound = JSON.parse(await readFile(manifest, 'utf8'));
  delete unbound.outputSha256;
  await writeFile(manifest, JSON.stringify(unbound));
  await assert.rejects(
    retierPreparedMap({ input, output: join(root, 'unbound'), map: 'de_qa', tier: 'mobile' }),
    /does not match/,
  );
  assert.deepEqual(await readFile(input), before);
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
