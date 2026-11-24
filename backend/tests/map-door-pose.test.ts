import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Group,
  Object3D,
  Vector3,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from '../../frontend/node_modules/three/build/three.module.js';
import { bindMapBreakables, mapBreakableVisibility } from '../../frontend/src/map-breakables';
import { prepareDoorStage } from '../../frontend/src/map-doors';
import { followObstruction } from '../../frontend/src/follow-obstruction';
import type { MapDoor } from '../../shared/map-breakables.mjs';
import { mapDoorPose } from '../../frontend/src/map-door-pose';

for (const baked of [false, true]) {
  test(
    'a recorded hinge keeps its pivot and rewinds exactly on ' +
      (baked ? 'baked' : 'local') +
      ' vertices',
    () => {
      const root = new Group(),
        parent = new Group(),
        door = new Object3D();
      root.rotation.y = Math.PI / 2;
      root.position.set(-4, 2, 1);
      root.add(parent);
      parent.position.set(1, 0, 2);
      parent.add(door);
      // Source pivot [100,200,50] inches, raw metres [5.08,1.27,2.54].
      const hinge = new Vector3(5.08, 1.27, 2.54);
      if (!baked) door.position.copy(hinge).sub(parent.position);
      root.updateMatrixWorld(true);
      const localHinge = door.worldToLocal(root.localToWorld(hinge.clone()));
      const handle = localHinge.clone().add(new Vector3(0, 0, 1));
      const closedHandle = door.localToWorld(handle.clone());
      const pose = mapDoorPose(root, door, [100, 200, 50])!;
      assert.ok(pose.set(90));
      const expected = root.localToWorld(hinge.clone().add(new Vector3(1, 0, 0)));
      assert.ok(door.localToWorld(handle.clone()).distanceTo(expected) < 1e-10);
      assert.ok(
        door.localToWorld(localHinge.clone()).distanceTo(root.localToWorld(hinge.clone())) < 1e-10,
      );
      assert.equal(pose.set(90), false);
      assert.ok(pose.set(0));
      assert.ok(door.localToWorld(handle.clone()).equals(closedHandle));
      pose.set(-85);
      pose.dispose();
      assert.ok(door.localToWorld(handle.clone()).equals(closedHandle));
      assert.equal(door.matrixAutoUpdate, true);
    },
  );
}

test('door pose, observed damage variant, shadow revision and camera collision follow the same tick on direct and backward seeks', () => {
  const track: MapDoor = {
    modelId: '123',
    origin: [0, 0, 0],
    angles: [0, 0, 0],
    samples: [
      [9, 0],
      [10, 90],
      [13, null],
    ],
    hidden: [[20, 25]],
    models: [
      [14, '456'],
      [25, null],
    ],
  };
  const root = new Group(),
    door = new Group();
  const leaf = (id: string, stage: number, width: number) => {
    const o = new Mesh(new PlaneGeometry(width, 2), new MeshBasicMaterial());
    o.userData.cswatchDoorStage = { modelId: id, stage };
    if (stage) o.scale.setScalar(0);
    return o;
  };
  const intact = leaf('123', 0, 3),
    damaged = leaf('456', 1, 0.5);
  door.userData.cswatchDoor = {
    ...track,
    className: 'prop_door_rotating',
    hammerId: '42',
    model: 'models/props/panel.vmdl',
  };
  door.add(intact, damaged);
  root.add(door);
  root.traverse(prepareDoorStage);
  const bound = bindMapBreakables(root, undefined, [track])!;
  bound.seek(14);
  const ray = {
    target: [1, 0, 1] as [number, number, number],
    position: [1, 0, -2] as [number, number, number],
  };
  const trace = followObstruction(root),
    fork = trace.fork();
  assert.deepEqual(trace(ray), ray.position);
  assert.ok(!intact.visible && damaged.visible);
  // The remaining panel still blocks the ray through its centre.
  const center = {
    target: [0, 0, 1] as [number, number, number],
    position: [0, 0, -2] as [number, number, number],
  };
  assert.ok(fork(center)[2] > 0);
  bound.seek(9);
  assert.ok(intact.visible && !damaged.visible && trace(ray)[2] > 0);
  bound.seek(9.5);
  const edge = door.localToWorld(new Vector3(1, 0, 0));
  assert.ok(edge.distanceTo(new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2)) < 1e-9);
  bound.seek(10);
  assert.deepEqual(trace(ray), ray.position);
  const rev = mapBreakableVisibility(root)!.revision;
  bound.seek(11);
  assert.equal(mapBreakableVisibility(root)!.revision, rev);
  bound.seek(20);
  assert.ok(!door.visible);
  assert.deepEqual(fork(center), center.position);
  bound.seek(25);
  assert.ok(door.visible && intact.visible && !damaged.visible && fork(ray)[2] > 0);
  bound.seek(16);
  assert.ok(damaged.visible);
  bound.dispose();
  assert.ok(intact.visible && !damaged.visible && door.visible);
});
