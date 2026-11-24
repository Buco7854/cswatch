import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { writeMapTier } from './map-tier-output.mjs';
import { prepareCompactMap } from './prepare-compact-map.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { modelResourceId, tagBreakableGeometry } from './recorded-breakable-geometry.mjs';

const path = 'models/fixture/grille.vmdl';
const dump = (id, x, extra = '') => `====0====
classname "prop_dynamic"
model resource_name:"${path}"
origin [${x},0,0]
angles [0,0,0]
scales [1,1,1]
hammeruniqueid "${id}"
${extra}
`;
function makeScene() {
  const document = new Document();
  const buffer = document.createBuffer();
  const material = document.createMaterial();
  const geometry = document
    .createPrimitive()
    .setAttribute(
      'POSITION',
      document
        .createAccessor()
        .setType('VEC3')
        .setBuffer(buffer)
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])),
    )
    .setIndices(
      document
        .createAccessor()
        .setType('SCALAR')
        .setBuffer(buffer)
        .setArray(new Uint16Array([0, 1, 2])),
    )
    .setMaterial(material);
  const mesh = document.createMesh('grille.unnamed_1').addPrimitive(geometry);
  const scene = document.createScene();
  for (const x of [10, 20, 30, 40])
    scene.addChild(
      document
        .createNode(mesh.getName())
        .setMesh(mesh)
        .setTranslation([0, 0, x * 0.0254]),
    );
  return document;
}
const tagged = (document) =>
  document
    .getRoot()
    .listNodes()
    .filter((n) => n.getExtras().cswatchBreakable);

test('CS2 resource handles preserve all 64 bits and coupled placement fails closed', () => {
  // Recorded CDynamicProp.m_hModel in a Cache match; its corresponding path is from the official entity lump.
  assert.equal(modelResourceId('models/de_cache_s2/newvent/newvent.vmdl'), '7565743517706365842');
  const doc = makeScene();
  const rows = [
    dump('12', 10, '@OnBreak Once A B'),
    dump('13', 10, '@OnBreak Once A B'),
    dump('14', 20, '@OnBreak Once A B\nparentname "moving_parent"'),
    dump('15', 30),
    dump('16', 40, '@OnBreak Once A B'),
  ];
  const counts = new Map();
  rows.push('====1====\nclassname "func_breakable"\nhealth 1');
  assert.equal(tagBreakableGeometry(doc, rows, counts), 1);
  assert.deepEqual(Object.fromEntries(counts), { prop_dynamic: 4, func_breakable: 1 });
  assert.deepEqual(
    tagged(doc).map((n) => n.getExtras().cswatchBreakable.hammerId),
    ['16'],
  );
  const other = makeScene();
  assert.equal(
    tagBreakableGeometry(other, [
      dump('12', 10, '@OnBreak Once A B'),
      dump('12', 20, '@OnBreak Once A B'),
    ]),
    0,
  );
  assert.equal(
    tagBreakableGeometry(other, [
      dump('17', 40, '@OnBreak Once A B').replace('angles [0,0,0]', 'angles [0,90,0]'),
    ]),
    0,
  );
});

test('independently placed brush fragments bind only to matching Source evidence', () => {
  const rows = [dump('20', 10, 'health 1'), dump('21', 20, 'health 1'), dump('22', 30)];
  const brushRows = rows.map((text) =>
    text
      .replace('prop_dynamic', 'func_breakable')
      .replace(path, 'maps/de_fixture/entities/grille.vmdl'),
  );
  const doc = makeScene();
  const mesh = doc.getRoot().listMeshes()[0];
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getTranslation()[2] === 20 * 0.0254);
  node.setName('aggregated-world');
  assert.equal(tagBreakableGeometry(doc, brushRows), 1);
  const [tag] = tagged(doc).map((n) => n.getExtras().cswatchBreakable);
  assert.equal(tag.className, 'func_breakable');
  assert.equal(tag.modelId, modelResourceId('maps/de_fixture/entities/grille.vmdl'));
  assert.equal(tag.hammerId, '20');
  assert.ok(node.getMesh() === mesh);
});

test('a detached skinned mesh belongs only to an exclusively owned, placed armature', () => {
  function rig(ambiguous) {
    const doc = makeScene();
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const mesh = doc.getRoot().listMeshes()[0];
    for (const node of scene.listChildren()) node.dispose();
    const root = doc.createNode('root');
    const slat = doc.createNode('slat');
    root.addChild(slat);
    const anchor = doc.createNode('grille').setTranslation([0, 0, 0.254]).addChild(root);
    const skin = doc.createSkin().addJoint(root).addJoint(slat);
    const body = doc.createNode('grille.body').setSkin(skin).setMesh(mesh);
    scene.addChild(anchor).addChild(body);
    if (ambiguous === 'two meshes') {
      scene.addChild(doc.createNode('grille.other').setMesh(mesh).setSkin(skin));
    } else if (ambiguous === 'shared bones') {
      const secondSkin = doc.createSkin().addJoint(root).addJoint(slat);
      scene.addChild(doc.createNode('grille.other').setMesh(mesh).setSkin(secondSkin));
    }
    return doc;
  }
  const evidence = [dump('2:61814:42349', 10, '@OnBreak Kill switch')];
  const exclusive = rig();
  assert.equal(tagBreakableGeometry(exclusive, evidence), 1);
  assert.deepEqual(
    tagged(exclusive).map((node) => node.getName()),
    ['grille.body'],
  );
  for (const conflict of ['two meshes', 'shared bones']) {
    const shared = rig(conflict);
    assert.equal(tagBreakableGeometry(shared, evidence), 0);
    assert.equal(tagged(shared).length, 0);
  }
});

test('independent instances survive static sibling batching, tier serialization and Compact simplification', async (t) => {
  await MeshoptDecoder.ready;
  const dir = await mkdtemp(join(tmpdir(), 'cswatch-breakables-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const metadata = {
    map: 'de_fixture',
    assetVersion: 'fixture',
    source: { file: 'source.glb', sha256: '1'.repeat(64), bytes: 64 },
  };
  for (const tier of ['desktop', 'mobile']) {
    const doc = makeScene();
    const color = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < color.length; i++) color[i] = (i * 47 + Math.floor(i / 31) * 53) & 255;
    const image = await sharp(color, { raw: { width: 64, height: 64, channels: 3 } })
      .png()
      .toBuffer();
    doc
      .getRoot()
      .listMaterials()[0]
      .setBaseColorTexture(doc.createTexture().setMimeType('image/png').setImage(image));
    assert.equal(
      tagBreakableGeometry(doc, [
        dump('12', 10, '@OnBreak Once A B'),
        dump('13', 20, 'health 1').replace('prop_dynamic', 'func_breakable'),
        dump('14', 30, 'startdisabled true').replace('prop_dynamic', 'func_brush'),
      ]),
      3,
    );
    await writeMapTier({
      ...metadata,
      document: doc,
      io,
      target: join(dir, tier),
      tier,
      batchStatic: tier === 'desktop',
      s2v: 'fixture',
    });
  }
  const compact = await prepareCompactMap({
    input: join(dir, 'mobile/scene.glb'),
    output: join(dir, 'compact'),
    map: 'de_fixture',
  });
  assert.ok(compact);
  for (const tier of ['desktop', 'mobile', 'compact']) {
    const model = await io.read(join(dir, tier, 'scene.glb'));
    const tags = tagged(model);
    assert.equal(tags.length, 2);
    const conditional = model
      .getRoot()
      .listNodes()
      .filter((n) => n.getExtras().cswatchInitiallyDisabled);
    assert.equal(conditional.length, 1);
    assert.equal(conditional[0].getExtras().cswatchInitiallyDisabled.className, 'func_brush');
    assert.equal(conditional[0].getExtras().cswatchInitiallyDisabled.hammerId, '14');
    assert.ok(conditional[0].getMesh()?.listPrimitives().length);
    assert.equal(new Set(tags.map((n) => n.getExtras().cswatchBreakable.hammerId)).size, 2);
    for (const node of tags) {
      assert.equal(node.getExtras().cswatchBreakable.modelId, modelResourceId(path));
      assert.ok(node.getMesh()?.listPrimitives().length);
    }
    assert.ok(
      model
        .getRoot()
        .listNodes()
        .some(
          (n) =>
            n.getMesh() &&
            !n.getExtras().cswatchBreakable &&
            !n.getExtras().cswatchInitiallyDisabled,
        ),
    );
  }
});

test('authored disabled props and brushes are independent of names and materials', () => {
  const doc = makeScene();
  const rows = [
    dump('11', 10, 'startdisabled true'),
    dump('12', 20, 'startdisabled false').replace('prop_dynamic', 'func_brush'),
    dump('13', 30, 'startdisabled true\nparentname "moving"'),
    dump('14', 40, 'startdisabled true'),
    dump('15', 40),
  ];
  assert.equal(tagBreakableGeometry(doc, rows), 1);
  const tags = doc
    .getRoot()
    .listNodes()
    .flatMap((n) => n.getExtras().cswatchInitiallyDisabled ?? []);
  assert.deepEqual(
    tags.map((t) => t.hammerId),
    ['11'],
  );
});
