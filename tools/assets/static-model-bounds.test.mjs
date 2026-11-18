import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { staticModelBounds } from './static-model-bounds.mjs';
function model() {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene(),
    bone = doc.createNode('root').setTranslation([0.4, 1, 0]);
  scene.addChild(bone);
  const array = (type, values) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', array('VEC3', [0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setAttribute(
      'JOINTS_0',
      doc.createAccessor().setType('VEC4').setArray(new Uint8Array(12)).setBuffer(buffer),
    )
    .setAttribute('WEIGHTS_0', array('VEC4', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const skin = doc
    .createSkin()
    .addJoint(bone)
    .setInverseBindMatrices(array('MAT4', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  scene.addChild(
    doc.createNode('native mesh').setMesh(doc.createMesh().addPrimitive(primitive)).setSkin(skin),
  );
  return { doc, primitive, bone };
}
test('native pose bounds apply skin matrices rather than assuming the undeformed POSITION box', () => {
  const { doc, bone } = model();
  assert.deepEqual(staticModelBounds(doc), { min: [0.4, 1, 0], max: [1.4, 2, 0] });
  bone.setTranslation([0.2, 0.5, 0]);
  assert.deepEqual(staticModelBounds(doc), { min: [0.2, 0.5, 0], max: [1.2, 1.5, 0] });
});
test('native pose bounds reject corrupt joints and weights before claiming a measured POV offset', () => {
  const { doc, primitive } = model();
  primitive.getAttribute('JOINTS_0').setElement(0, [3, 0, 0, 0]);
  assert.throws(() => staticModelBounds(doc), /joint index/);
  const next = model();
  next.primitive.getAttribute('WEIGHTS_0').setElement(0, [0, 0, 0, 0]);
  assert.throws(() => staticModelBounds(next.doc), /weights/);
});
