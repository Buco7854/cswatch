import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from '../../frontend/node_modules/three/build/three.module.js';
import { bindMapBreakables } from '../../frontend/src/map-breakables.js';
import { cloneMapModel } from '../../frontend/src/map-model.js';
import { followObstruction } from '../../frontend/src/follow-obstruction.js';
import type { MapVisibility } from '../../shared/map-breakables.mjs';

test('mode geometry defaults to its source state and follows only the named recording placement', () => {
  const pose = { modelId: '321', origin: [100, 4, -8], angles: [0, 180, 0] } as const;
  const source = new Group();
  const enabled = new Mesh(new PlaneGeometry(5, 5), new MeshBasicMaterial());
  const blocker = enabled.clone();
  blocker.userData.cswatchInitiallyDisabled = {
    ...pose,
    className: 'func_brush',
    model: 'maps/test/panel.vmdl',
    hammerId: '4',
  };
  enabled.position.x = 12;
  source.add(enabled, blocker);
  const root = cloneMapModel(source) as Group;
  const [fixed, conditional] = root.children;
  assert.equal(blocker.visible, true);
  assert.equal(fixed.visible, true);
  assert.equal(conditional.visible, false);
  assert.equal(bindMapBreakables(root, undefined), undefined);
  const row: MapVisibility = {
    ...pose,
    origin: [...pose.origin],
    angles: [...pose.angles],
    className: 'func_brush',
    visible: [[10, 20]],
  };
  const mismatch = bindMapBreakables(root, undefined, undefined, [
    { ...row, className: 'prop_dynamic' },
  ]);
  assert.equal(mismatch, undefined);
  const bound = bindMapBreakables(root, undefined, undefined, [row])!;
  const ray = {
    target: [0, 0, 1] as [number, number, number],
    position: [0, 0, -2] as [number, number, number],
  };
  const trace = followObstruction(root);
  for (const [tick, shown] of [
    [20, false],
    [10, true],
    [19.9, true],
    [9.9, false],
    [15, true],
  ] as const) {
    bound.seek(tick);
    assert.equal(conditional.visible, shown);
    assert.equal(fixed.visible, true);
    assert.equal(trace(ray)[2] !== ray.position[2], shown);
  }
  bound.dispose();
  assert.equal(conditional.visible, false);
});
