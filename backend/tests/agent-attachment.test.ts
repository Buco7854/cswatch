import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bone,
  Group,
  Matrix4,
  Vector3,
} from '../../frontend/node_modules/three/build/three.module.js';
import { fitWeaponGrip, nativeWeaponFrame } from '../../frontend/src/agent-attachment.js';
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
test('stale other-actor, detached, non-bone and singular native anchors keep the held model hidden without reparenting', () => {
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

test('the authored model grip stays between the moving thumb and middle knuckle', () => {
  const actor = new Group(),
    rig = new Group(),
    model = new Group(),
    grip = new Group();
  const weapon = new Bone(),
    thumb = new Bone(),
    middle = new Bone();
  actor.add(rig, model);
  rig.add(weapon, thumb, middle);
  model.add(grip);
  actor.rotation.y = 0.73;
  actor.position.set(-7, 2, 3);
  weapon.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  weapon.position.set(0.35, 1.3, 0.2);
  grip.position.set(-0.087, -0.115, -0.005);
  model.matrixAutoUpdate = false;
  const mount = new Matrix4();
  const scratch = [new Vector3(), new Vector3(), new Vector3(), new Matrix4()] as const;
  for (const height of [1.42, 0.88, 1.27]) {
    thumb.position.set(-0.1, height, 0.3);
    middle.position.set(-0.12, height - 0.03, 0.31);
    assert.ok(nativeWeaponFrame(mount, actor, weapon));
    const forward = new Vector3(1, 0, 0).transformDirection(mount);
    fitWeaponGrip(mount, grip, model, actor, [thumb, middle], [...scratch]);
    model.matrix.copy(mount);
    assert.ok(new Vector3(1, 0, 0).transformDirection(mount).distanceTo(forward) < 1e-10);
    const left = thumb
      .getWorldPosition(new Vector3())
      .lerp(middle.getWorldPosition(new Vector3()), 0.5);
    assert.ok(grip.getWorldPosition(new Vector3()).distanceTo(left) < 1e-10);
  }
});
