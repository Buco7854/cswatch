import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { batchMapMeshes } from './batch-map-meshes.mjs';
import { compressPreparedGeometry } from './compress-prepared-map.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { applyTextureBudget } from './texture-budget.mjs';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

function fixture() {
  const document = new Document(),
    buffer = document.createBuffer(),
    scene = document.createScene('original QA, not game artwork'),
    material = document
      .createMaterial('materials/dev/black_simple.vmat')
      .setExtras({ ShaderName: 'csgo_black_unlit.vfx', g_bFogEnabled: 1 }),
    sky = document
      .createNode('cswatch_skybox')
      .setExtras({ cswatch: { kind: 'skybox', schemaVersion: 1 } })
      .setTranslation([0, 10, 0]);
  scene.addChild(sky);
  function add(name, parent = scene, options = {}) {
    const position = document
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
        .setBuffer(buffer),
      primitive = document
        .createPrimitive()
        .setAttribute('POSITION', position)
        .setMaterial(options.material || material),
      node = document
        .createNode(name)
        .setTranslation(options.translation || [0, 0, 0])
        .setRotation([0, 0, Math.sin(0.15), Math.cos(0.15)])
        .setMesh(document.createMesh(name).addPrimitive(primitive));
    if (options.normalized !== undefined)
      primitive.setAttribute(
        'COLOR_0',
        document
          .createAccessor()
          .setType('VEC4')
          .setNormalized(options.normalized)
          .setArray(new Uint8Array(12).fill(1))
          .setBuffer(buffer),
      );
    parent.addChild(node);
    return node;
  }
  return { document, scene, sky, material, add };
}
function worldTriangles(document) {
  const result = [];
  for (const scene of document.getRoot().listScenes())
    scene.traverse((node) => {
      const matrix = node.getWorldMatrix();
      for (const primitive of node.getMesh()?.listPrimitives() || []) {
        const positions = primitive.getAttribute('POSITION'),
          indices = primitive.getIndices(),
          count = indices?.getCount() ?? positions.getCount();
        for (let i = 0; i < count; i += 3) {
          const vertices = [];
          for (let j = 0; j < 3; j++) {
            const p = positions.getElement(indices ? indices.getScalar(i + j) : i + j, []);
            vertices.push(
              [0, 1, 2].map((axis) =>
                Number(
                  (
                    matrix[axis] * p[0] +
                    matrix[4 + axis] * p[1] +
                    matrix[8 + axis] * p[2] +
                    matrix[12 + axis]
                  ).toFixed(5),
                ),
              ),
            );
          }
          result.push(JSON.stringify([primitive.getMaterial()?.getName(), vertices]));
        }
      }
    });
  return result.sort();
}
test('static batching preserves actual world triangles, exact source material metadata and named sky hierarchy', async () => {
  const { document, scene, sky, material, add } = fixture();
  add('main-a', scene, { translation: [2, 0, 0] });
  add('main-b', scene, { translation: [4, 0, 0] });
  add('sky-a', sky, { translation: [2, 0, 0] });
  add('sky-b', sky, { translation: [4, 0, 0] });
  const triangles = worldTriangles(document),
    nodes = document
      .getRoot()
      .listNodes()
      .map((node) => ({
        node,
        matrix: node.getMatrix(),
        parent: node.getParentNode(),
        name: node.getName(),
        extras: node.getExtras(),
      }));
  const report = await batchMapMeshes(document);
  assert.equal(report.initialPrimitives, 4);
  assert.equal(report.finalPrimitives, 2);
  assert.deepEqual(worldTriangles(document), triangles);
  for (const prior of nodes) {
    assert.ok(document.getRoot().listNodes().includes(prior.node));
    assert.deepEqual(prior.node.getMatrix(), prior.matrix);
    assert.equal(prior.node.getParentNode(), prior.parent);
    assert.equal(prior.node.getName(), prior.name);
    assert.deepEqual(prior.node.getExtras(), prior.extras);
  }
  assert.deepEqual(material.getExtras(), { ShaderName: 'csgo_black_unlit.vfx', g_bFogEnabled: 1 });
  const roundtrip = await new NodeIO().readBinary(await new NodeIO().writeBinary(document));
  assert.deepEqual(worldTriangles(roundtrip), triangles);
  assert.equal(roundtrip.getRoot().listMaterials().length, 1);
  assert.deepEqual(roundtrip.getRoot().listMaterials()[0].getExtras(), material.getExtras());
});
test('batching keeps animated branches, source extras, transparency, spatial cells and integer normalized layouts separate', async () => {
  const { document, scene, add } = fixture(),
    moving = document.createNode('animated-parent');
  scene.addChild(moving);
  const animatedA = add('animated-a', moving),
    animatedB = add('animated-b', moving),
    buffer = document.getRoot().listBuffers()[0],
    input = document
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Float32Array([0, 1]))
      .setBuffer(buffer),
    output = document
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0]))
      .setBuffer(buffer),
    sampler = document.createAnimationSampler().setInput(input).setOutput(output),
    channel = document
      .createAnimationChannel()
      .setTargetNode(moving)
      .setTargetPath('translation')
      .setSampler(sampler);
  document.createAnimation('real QA motion').addSampler(sampler).addChannel(channel);
  const extras = add('metadata');
  extras.setExtras({ source: 'keep exact' });
  const transparent = document.createMaterial('transparent').setAlphaMode('BLEND');
  const alphaA = add('alpha-a', scene, { material: transparent }),
    alphaB = add('alpha-b', scene, { material: transparent });
  const integerA = add('integer-a', scene, { normalized: true }),
    integerB = add('integer-b', scene, { normalized: false });
  const far = add('far', scene, { translation: [512, 0, 0] });
  const reflected = add('reflected', scene);
  reflected.setScale([-1, 2, 1]);
  const before = worldTriangles(document);
  const report = await batchMapMeshes(document);
  assert.equal(report.initialPrimitives, report.finalPrimitives);
  for (const node of [
    animatedA,
    animatedB,
    extras,
    alphaA,
    alphaB,
    integerA,
    integerB,
    far,
    reflected,
  ])
    assert.equal(node.getMesh().listPrimitives().length, 1);
  assert.deepEqual(worldTriangles(document), before);
  assert.deepEqual(extras.getExtras(), { source: 'keep exact' });
});

test('existing-tier batching writes a fresh hash-bound lossless tier and preserves encoded image bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-static-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { document, scene, add, material } = fixture();
  add('a', scene, { translation: [2, 0, 0] });
  add('b', scene, { translation: [4, 0, 0] });
  const raster = await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#a0b0c0' },
  })
    .png()
    .toBuffer();
  material.setBaseColorTexture(
    document.createTexture('original QA raster').setMimeType('image/png').setImage(raster),
  );
  const budget = await applyTextureBudget(document, { tier: 'desktop' });
  const preparedRaster = Buffer.from(material.getBaseColorTexture().getImage());
  const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder }),
    original = Buffer.from(await io.writeBinary(document));
  await writeFile(join(root, 'scene.glb'), original);
  await writeFile(join(root, 'texture-plan.json'), budget.planBytes);
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      map: 'de_original_qa',
      tier: 'desktop',
      assetVersion: 'QA',
      bytes: original.length,
      outputSha256: createHash('sha256').update(original).digest('hex'),
      textureBudget: budget.manifest,
    }),
  );
  const result = await compressPreparedGeometry({
    input: join(root, 'scene.glb'),
    output: join(root, 'new-tier'),
    map: 'de_original_qa',
    tier: 'desktop',
    batchStatic: true,
  });
  assert.equal(result.manifest.staticBatching.initialPrimitives, 2);
  assert.equal(result.manifest.staticBatching.finalPrimitives, 1);
  await MeshoptDecoder.ready;
  const after = await io.read(result.path);
  assert.deepEqual(worldTriangles(after), worldTriangles(document));
  assert.deepEqual(Buffer.from(after.getRoot().listTextures()[0].getImage()), preparedRaster);
  assert.deepEqual(await readFile(join(root, 'scene.glb')), original);
  await assert.rejects(
    compressPreparedGeometry({
      input: join(root, 'scene.glb'),
      output: root,
      map: 'de_original_qa',
      tier: 'desktop',
      batchStatic: true,
    }),
    /new tier/,
  );
});
