import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { writeMapTier } from './map-tier-output.mjs';
import { prepareCompactMap } from './prepare-compact-map.mjs';
import { Document, NodeIO } from '@gltf-transform/core';
import { declaredDoorStages, exportDoorStages, singleDoorDraw } from './install-door-stages.mjs';
import { attachDoorStages } from './prepare-door-stages.mjs';
import { modelResourceId, tagBreakableGeometry } from './recorded-breakable-geometry.mjs';
import { rigidMapMesh } from './prepare-rigid-door.mjs';

const base = 'models/test/door.vmdl',
  variant = 'models/test/opening.vmdl',
  vmat = 'materials/test/paint.vmat';
const declaration = (path) => `m_name = "${base}"
door_options =
{
 defaults =
 {
   damage1 = "${path}"
 }
}`;
const draw = `m_nPrimitiveType = "RENDER_PRIM_TRIANGLES"
m_nBaseVertex = 0
m_nStartIndex = 0
m_nVertexCount = 3
m_nIndexCount = 3
m_material = resource:"${vmat}"`;
const entity = (hammer, x) => `====0====
classname "prop_door_rotating"
model resource_name:"${base}"
origin [${x},0,0]
angles [0,0,0]
hammeruniqueid "${hammer}"`;

test('only named door defaults, matching RERL and an unambiguous material draw authorize stages', () => {
  assert.deepEqual(declaredDoorStages(base, declaration('test/opening'), [variant + '_c']), [
    { stage: 1, path: variant },
  ]);
  assert.deepEqual(declaredDoorStages(base, declaration('test/opening'), []), []);
  assert.deepEqual(declaredDoorStages(base, declaration('../test/opening'), [variant + '_c']), []);
  assert.deepEqual(
    declaredDoorStages(base, declaration('test/opening') + declaration('test/opening'), [
      variant + '_c',
    ]),
    [],
  );
  assert.deepEqual(singleDoorDraw(draw, [vmat + '_c']), {
    indices: 3,
    vertices: 3,
    material: vmat,
  });
  assert.equal(singleDoorDraw(draw, []), undefined);
  assert.equal(singleDoorDraw(draw + '\n' + draw, [vmat + '_c']), undefined);
  assert.equal(
    singleDoorDraw(draw.replace('m_nStartIndex = 0', 'm_nStartIndex = 1'), [vmat + '_c']),
    undefined,
  );
});

test('dry maps and unavailable optional data make no native or download requests, while cancellation propagates', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'cswatch-door-source-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const unavailable = {
    entities: entity('1', 0),
    banks: async () => [
      {
        index: {
          entries: new Map([[base + '_c', { length: 32, preloadBytes: 0, crc32: 1 }]]),
          readEntry: async () => undefined,
        },
      },
    ],
    directory: join(folder, 'door'),
    execute: assert.fail,
    download: assert.fail,
  };
  assert.deepEqual(
    await exportDoorStages({
      ...unavailable,
      entities: '====0====\nclassname "light"',
      banks: assert.fail,
    }),
    [],
  );
  assert.deepEqual(await exportDoorStages(unavailable), []);
  assert.deepEqual(await exportDoorStages(unavailable), []);
  const stopped = {
    ...unavailable,
    banks: async () => {
      throw new Error('cancelled');
    },
  };
  await assert.rejects(exportDoorStages(stopped), /cancelled/);
  const proof = Buffer.alloc(32);
  proof.writeUInt16LE(12, 4);
  proof.writeUInt32LE(0xffffffff, 0);
  const malformed = {
    ...unavailable,
    banks: async () => [
      {
        index: {
          entries: new Map([[base + '_c', { length: 32, preloadBytes: 0, crc32: 1 }]]),
          readEntry: async () => proof,
        },
      },
    ],
    execute: async () => ({ code: 0, stdout: declaration('test/opening') }),
  };
  assert.deepEqual(await exportDoorStages(malformed), []);
  await assert.rejects(
    exportDoorStages({ ...malformed, execute: async () => ({ code: null, signal: 'SIGKILL' }) }),
    /SIGKILL/,
  );
});

function mesh(doc, name = 'door.body') {
  const buffer = doc.createBuffer(),
    a = (type, values) => doc.createAccessor().setType(type).setBuffer(buffer).setArray(values);
  const p = doc
    .createPrimitive()
    .setIndices(a('SCALAR', new Uint16Array([0, 1, 2])))
    .setAttribute('POSITION', a('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute('NORMAL', a('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute('TEXCOORD_0', a('VEC2', new Float32Array([0, 0, 1, 0, 0, 1])));
  return doc.createMesh(name).addPrimitive(p);
}
test('immutable damage geometry reuses each placed leaf’s original authored paint, never a namesake', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cswatch-door-geometry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stage = new Document();
  stage.createScene().addChild(stage.createNode().setMesh(mesh(stage)));
  const io = new NodeIO(),
    file = join(dir, 'stage.glb');
  await io.write(file, stage);
  const doc = new Document(),
    sc = doc.createScene();
  const paints = [];
  for (let i = 0; i < 3; i++) {
    const m = mesh(doc),
      mat = doc
        .createMaterial('paint')
        .setExtras({ vmat: { Name: i === 2 ? 'materials/other/paint.vmat' : vmat } })
        .setBaseColorFactor([1, i / 3, 0, 1]);
    m.listPrimitives()[0].setMaterial(mat);
    paints.push(mat);
    sc.addChild(
      doc
        .createNode('door.body')
        .setTranslation([0, 0, i * 0.0254])
        .setMesh(m),
    );
  }
  const sources = [0, 1, 2].map((i) => entity(String(i + 1), i));
  assert.equal(tagBreakableGeometry(doc, sources), 3);
  const row = { base, stage: 1, path: variant, material: vmat, file, indices: 3, vertices: 3 };
  assert.deepEqual(await attachDoorStages(doc, [{ ...row, vertices: 4 }]), []);
  const invalid = join(dir, 'broken.glb');
  await writeFile(invalid, 'invalid', { mode: 0o600 });
  assert.deepEqual(await attachDoorStages(doc, [{ ...row, file: invalid }]), []);
  assert.deepEqual(await attachDoorStages(doc, [row]), [
    { model: base, stage: 1, modelId: modelResourceId(variant), instances: 2, triangles: 1 },
  ]);
  const doors = sc.listChildren();
  for (let i = 0; i < 3; i++) {
    const holders = doors[i].listChildren();
    assert.equal(holders.length, i === 2 ? 1 : 2);
    assert.deepEqual(holders[0].getScale(), [1, 1, 1]);
    if (i !== 2) {
      assert.deepEqual(holders[1].getScale(), [0, 0, 0]);
      assert.equal(
        holders[1].listChildren()[0].getMesh().listPrimitives()[0].getMaterial(),
        paints[i],
      );
    }
  }
  const noise = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 23 + Math.floor(i / 31) * 67) & 255;
  const image = await sharp(noise, { raw: { width: 64, height: 64, channels: 3 } })
    .png()
    .toBuffer();
  paints[0].setBaseColorTexture(doc.createTexture().setMimeType('image/png').setImage(image));
  await MeshoptDecoder.ready;
  io.registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const map = 'de_fixture';
  await doc.transform(unpartition());
  await writeMapTier({
    document: doc,
    io,
    target: join(dir, 'mobile'),
    map,
    tier: 'mobile',
    s2v: 'fixture',
    assetVersion: 'fixture',
    source: { file: 'source.glb', sha256: '1'.repeat(64), bytes: 64 },
  });
  assert.ok(
    await prepareCompactMap({
      input: join(dir, 'mobile', 'scene.glb'),
      output: join(dir, 'compact'),
      map,
    }),
  );
  const compact = await io.read(join(dir, 'compact', 'scene.glb'));
  const compactDoors = compact
    .getRoot()
    .listNodes()
    .filter((n) => n.getExtras().cswatchDoor);
  assert.equal(compactDoors.length, 3);
  for (const door of compactDoors) {
    const stage = door.listChildren().find((n) => n.getExtras().cswatchDoorStage?.stage === 1);
    if (door.getExtras().cswatchDoor.hammerId === '3') {
      assert.equal(stage, undefined);
      continue;
    }
    assert.deepEqual(stage.getScale(), [0, 0, 0]);
    const shape = stage.listChildren()[0].getMesh().listPrimitives()[0].getAttribute('POSITION');
    assert.ok(shape.getMax([])[0] > shape.getMin([])[0], 'hidden geometry retained its width');
  }
});
test('only a motionless, fully rigid single joint can become a rigid door or Compact breakable', () => {
  const d = new Document(),
    m = mesh(d),
    primitive = m.listPrimitives()[0],
    b = d.getRoot().listBuffers()[0];
  const att = (type, values) => d.createAccessor().setBuffer(b).setType(type).setArray(values);
  const weights = att('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  primitive
    .setAttribute('WEIGHTS_0', weights)
    .setAttribute('JOINTS_0', att('VEC4', new Uint8Array(12)));
  const joint = d.createNode('root');
  const ib = att('MAT4', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const skin = d.createSkin().addJoint(joint).setInverseBindMatrices(ib),
    node = d.createNode('door.body').setMesh(m).setSkin(skin);
  assert.ok(rigidMapMesh(d, node, new Set(), new Map()));
  assert.ok(primitive.getAttribute('WEIGHTS_0'));
  assert.equal(rigidMapMesh(d, node, new Set([joint]), new Map()), undefined);
  weights.getArray()[0] = 0.5;
  assert.equal(rigidMapMesh(d, node, new Set(), new Map()), undefined);
  weights.getArray()[0] = 1;
  const anchor = d.createNode('door').addChild(joint).setTranslation([0, 0, 0.254]);
  d.createScene().addChild(node).addChild(anchor);
  const metadata =
    entity('42', 10).replace('prop_door_rotating', 'prop_dynamic') + '\n@OnBreak Kill switch';
  assert.equal(tagBreakableGeometry(d, metadata), 1);
  assert.equal(node.getExtras().cswatchBreakable.hammerId, '42');
  assert.equal(node.getSkin(), null);
  assert.equal(node.getMesh().listPrimitives()[0].getAttribute('JOINTS_0'), null);
  assert.deepEqual(node.getTranslation(), [0, 0, 0.254]);
});
