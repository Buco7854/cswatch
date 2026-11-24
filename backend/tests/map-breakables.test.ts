import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DemoReader } from 'cs2parser';
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from '../../frontend/node_modules/three/build/three.module.js';
import { observeMapBreakables } from '../src/map-breakables.js';
import { bindMapBreakables, mapBreakableVisibility } from '../../frontend/src/map-breakables.js';
import { followObstruction } from '../../frontend/src/follow-obstruction.js';
import {
  breakableKey,
  validMapBreakables,
  type MapPropPose,
} from '../../shared/map-breakables.mjs';

const modelId = '7565743517706365842';
const left: MapPropPose = { modelId, origin: [374.25, -276, 1789.25], angles: [0, 90, 0] };
const right: MapPropPose = { modelId, origin: [544.75, -169.375, 1789.25], angles: [0, 0, 0] };
const skeleton = 'CDynamicProp.CBodyComponentBaseAnimGraph.m_skeletonInstance.';
function recording() {
  const source = Object.assign(new EventEmitter(), {
    entities: [] as { className: string; properties: Record<string, unknown> }[],
    currentTick: 0,
  });
  const finish = observeMapBreakables(
    source as unknown as DemoReader,
    96999,
    [65, 5945, 11538].map((tick) => ({ type: 'round_start', tick })),
  );
  function present(tick: number, id: number, serial: number, pose: MapPropPose = left) {
    const props: Record<string, unknown> = {};
    for (const [i, a] of ['X', 'Y', 'Z'].entries()) {
      const p = pose.origin[i] + 16384,
        c = Math.floor(p / 512);
      props[skeleton + 'm_vecOrigin.m_cell' + a] = c;
      props[skeleton + 'm_vecOrigin.m_vec' + a] = p - c * 512;
    }
    Object.assign(props, {
      [skeleton + 'm_angRotation']: pose.angles,
      [skeleton + 'm_hParent']: 16777215,
      [skeleton + 'm_flScale']: 1,
      [skeleton + 'm_modelState.m_hModel']: BigInt(pose.modelId),
    });
    source.currentTick = tick;
    source.entities[id] = { className: 'CDynamicProp', properties: props };
    source.emit('entitycreated', [id, 0, 0, 'CDynamicProp', serial]);
    source.emit('tickend');
    return props;
  }
  function remove(tick: number, id: number) {
    source.currentTick = tick;
    delete source.entities[id];
    source.emit('entitydeleted', id);
  }
  return { finish, present, remove, source };
}
function node(pose: MapPropPose) {
  const n = new Group();
  n.userData.cswatchBreakable = {
    className: 'prop_dynamic',
    hammerId: '123804',
    model: 'models/source.vmdl',
    ...pose,
  };
  return n;
}
test('recorded Cache deletions, same-serial snapshots, independent vents and round respawn survive cold seeks and rewinds', () => {
  const c = recording();
  c.present(65, 152, 1017, right);
  c.present(65, 153, 957, left);
  c.remove(2763, 152);
  c.remove(3261, 153);
  c.present(5945, 72, 382, left);
  c.present(5945, 84, 38, right);
  c.present(7681, 72, 382, left);
  const bank = c.finish(true)!;
  assert.deepEqual(
    bank.map((x) => x.hidden),
    [[[2763, 5945]], [[3261, 5945]]],
  );
  assert.equal(validMapBreakables(bank, 96999), true);
  const root = new Group(),
    west = node(left),
    east = node(right);
  root.add(west, east);
  const state = bindMapBreakables(root, bank)!;
  for (const [tick, w, e] of [
    [3841, false, false],
    [5945, true, true],
    [3260.9, true, false],
    [3261, false, false],
    [2762.9, true, true],
    [2763, true, false],
    [11538, true, true],
  ] as const) {
    state.seek(tick);
    assert.deepEqual([west.visible, east.visible], [w, e]);
  }
  state.seek(4000);
  state.dispose();
  assert.ok(west.visible && east.visible);
  assert.equal(mapBreakableVisibility(root), undefined);
});
test('a breakable gate immediately updates cached follow/POV ray results, including a map opened while the prop was absent', () => {
  const root = new Group(),
    gate = node(right);
  gate.add(new Mesh(new PlaneGeometry(5, 5), new MeshBasicMaterial()));
  root.add(gate);
  const index = bindMapBreakables(root, [{ ...right, hidden: [[20, 40]] }])!;
  index.seek(21);
  const trace = followObstruction(root),
    ray = {
      target: [0, 0, 1] as [number, number, number],
      position: [0, 0, -2] as [number, number, number],
    },
    fork = trace.fork();
  for (const fn of [trace, fork]) {
    assert.deepEqual(fn(ray), ray.position);
    index.seek(19);
    assert.ok(fn(ray)[2] > 0);
    index.seek(20);
    assert.deepEqual(fn(ray), ray.position);
  }
  index.seek(40);
  assert.ok(trace(ray)[2] > 0);
  index.dispose();
});
test('missing exact identities, moved entities, simultaneous duplicate poses, implicit slot reuse and partial parses retain map geometry', () => {
  const d = recording();
  d.present(1, 1, 0);
  d.present(1, 2, 0);
  d.remove(42, 1);
  d.remove(43, 2);
  assert.equal(d.finish(true), undefined);
  const out = recording();
  const props = out.present(1, 5, 5);
  props[skeleton + 'm_vecOrigin.m_vecX'] = 2;
  out.remove(4, 5);
  out.present(10, 5, 6);
  out.present(14, 5, 7, right);
  assert.equal(out.finish(true), undefined);
  const p = recording();
  p.present(4, 1, 0);
  p.remove(8, 1);
  assert.equal(p.finish(false), undefined);
  const badMap = new Group(),
    a = node(right),
    b = node(right),
    other = node({ ...right, origin: [544.751, -169.375, 1789.25] });
  badMap.add(a, b, other);
  assert.equal(bindMapBreakables(badMap, [{ ...right, hidden: [[10, 20]] }]), undefined);
  assert.equal(breakableKey({ ...left, modelId: '18446744073709551616' }), undefined);
  assert.equal(
    validMapBreakables(
      [
        {
          ...left,
          hidden: [
            [11, 12],
            [10, 11],
          ],
        },
      ],
      20,
    ),
    false,
  );
  assert.equal(
    validMapBreakables(
      [
        { ...left, hidden: [[10, 21]] },
        { ...left, hidden: [[4, 5]] },
      ],
      20,
    ),
    false,
  );
});
