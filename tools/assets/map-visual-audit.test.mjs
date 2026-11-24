import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '@gltf-transform/core';
import { inspectMapGraphics } from './map-visual-audit.mjs';
import { filterMapWorldMaterials } from './map-world-materials.mjs';
import { readBoundVisualAudit } from './map-graphics-contract.mjs';
import { createHash } from 'node:crypto';

function setup() {
  const doc = new Document(),
    scene = doc.createScene(),
    buf = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 3, 0, 0, 0, 3, 0]))
    .setBuffer(buf);
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buf);
  function add(shader, name, materialExtras = {}) {
    const material = doc
      .createMaterial(name)
      .setExtras({ vmat: { ShaderName: shader + '.vfx', Name: name }, ...materialExtras });
    const mesh = doc
      .createMesh()
      .addPrimitive(
        doc
          .createPrimitive()
          .setMaterial(material)
          .setAttribute('POSITION', position)
          .setIndices(indices),
      );
    const node = doc.createNode().setMesh(mesh);
    scene.addChild(node);
    return node;
  }
  return { doc, scene, add };
}

test('unknown future shaders remain explicit alongside omitted, authored and approximated families', () => {
  const { doc, add } = setup();
  add('brand_new_shader', 'materials/new.vmat');
  add('csgo_water_fancy', 'materials/water.vmat');
  add('csgo_glass', 'materials/window.vmat', { cswatch: { constantGlass: { schemaVersion: 1 } } })
    .getMesh()
    .listPrimitives()[0]
    .getMaterial()
    .setAlphaMode('BLEND');
  add('toolsclip', 'materials/tools/invisible.vmat');
  const audit = inspectMapGraphics(doc);
  assert.deepEqual(audit, inspectMapGraphics(doc));
  const coverage = Object.fromEntries(audit.materials.map((r) => [r.feature, r.coverage]));
  assert.deepEqual(coverage, {
    unknown: 'unknown',
    water: 'omitted',
    glass: 'source_backed',
    helper: 'intentionally_hidden',
  });
  assert.equal(audit.views.length, 3);
  filterMapWorldMaterials(doc);
  assert.equal(inspectMapGraphics(doc).materials.length, 2);
  const metadata = {
    schemaVersion: 1,
    map: 'de_future',
    tier: 'mobile',
    assetVersion: 'source',
    sourceSha256: '1'.repeat(64),
    modelSha256: '2'.repeat(64),
    coordinateSystem: 'gltf-meters-y-up',
  };
  const bytes = Buffer.from(JSON.stringify({ ...metadata, ...audit }));
  const manifest = {
    ...metadata,
    outputSha256: metadata.modelSha256,
    visualAuditSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  assert.deepEqual(readBoundVisualAudit(bytes, manifest).views, audit.views);
});

test('world-space cameras face the rendered side of mirrored, instanced indexed geometry', () => {
  const { doc, scene, add } = setup();
  const main = add('csgo_foliage', 'leaves').setScale([-1, 1, 1]).setTranslation([7, 4, -8]);
  scene.addChild(doc.createNode().setMesh(main.getMesh()));
  add('csgo_simple', 'sky').setExtras({ cswatch: { kind: 'skybox' } });
  const audit = inspectMapGraphics(doc);
  assert.equal(audit.views.length, 1);
  assert.deepEqual(audit.views[0].target, [6, 5, -8]);
  assert.ok(audit.views[0].eye[2] > -8);
  assert.equal(audit.materials.find((m) => m.feature === 'foliage').primitives, 1);
  main
    .getMesh()
    .listPrimitives()[0]
    .getIndices()
    .setArray(new Uint16Array([0, 0, 0]));
  assert.equal(inspectMapGraphics(doc).views.length, 0);
});

test('camera sampling remains bounded while material inventory retains all families', () => {
  const { doc, add } = setup();
  for (let i = 0; i < 30; i++) add('future_' + i, 'materials/test' + i);
  add('csgo_glass', 'materials/test-glass');
  const audit = inspectMapGraphics(doc);
  assert.equal(audit.materials.length, 31);
  assert.equal(audit.views.length, 24);
  assert.ok(audit.views.some((v) => v.feature === 'glass'));
});
