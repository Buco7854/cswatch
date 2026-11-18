import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bone,
  Group,
  Matrix4,
  Vector3,
} from '../../frontend/node_modules/three/build/three.module.js';
import { nativeWeaponFrame } from '../../frontend/src/agent-attachment.js';
test('native Source weapon bone maps canonical equipment axes once and follows deformation without duplicate actor travel', () => {
  const actor = new Group(),
    body = new Group(),
    bone = new Bone();
  actor.position.set(10, 3, -5);
  actor.rotation.y = 0.7;
  body.rotation.y = Math.PI / 2;
  actor.add(body);
  bone.quaternion.set(-0.5, -0.5, -0.5, 0.5);
  bone.position.set(0, 1.3, 0.4);
  body.add(bone);
  const frame = new Matrix4();
  assert.equal(nativeWeaponFrame(frame, actor, bone), true);
  const position = new Vector3().setFromMatrixPosition(frame);
  assert.ok(position.distanceTo(new Vector3(0.4, 1.3, 0)) < 1e-10);
  assert.ok(
    new Vector3(1, 0, 0).transformDirection(frame).distanceTo(new Vector3(1, 0, 0)) < 1e-10,
  );
  assert.ok(
    new Vector3(0, 1, 0).transformDirection(frame).distanceTo(new Vector3(0, 1, 0)) < 1e-10,
  );
  bone.position.y = 0.65;
  assert.equal(nativeWeaponFrame(frame, actor, bone), true);
  assert.ok(Math.abs(new Vector3().setFromMatrixPosition(frame).y - 0.65) < 1e-10);
  assert.deepEqual(actor.position.toArray(), [10, 3, -5]);
  assert.equal(body.children.length, 1);
  actor.position.x = 90;
  nativeWeaponFrame(frame, actor, bone);
  assert.ok(
    new Vector3().setFromMatrixPosition(frame).distanceTo(new Vector3(0.4, 0.65, 0)) < 1e-10,
  );
});
test('stale other-actor, detached, non-bone and singular native anchors fail back to operator preset without reparenting', () => {
  const actor = new Group(),
    other = new Group(),
    bone = new Bone(),
    matrix = new Matrix4();
  other.add(bone);
  assert.equal(nativeWeaponFrame(matrix, actor, bone), false);
  actor.add(bone);
  assert.equal(nativeWeaponFrame(matrix, actor, bone), true);
  assert.equal(bone.parent, actor);
  actor.remove(bone);
  assert.equal(nativeWeaponFrame(matrix, actor, bone), false);
  assert.equal(nativeWeaponFrame(matrix, actor, new Group()), false);
  actor.add(bone);
  actor.scale.x = 0;
  assert.equal(nativeWeaponFrame(matrix, actor, bone), false);
});
