import assert from 'node:assert/strict';
import test from 'node:test';
import { entityPlayback } from '../../frontend/src/world/entity-playback.ts';
import { modelResourceId } from '../../shared/model-resource-id.mjs';
const model = 'models/tests/door.vmdl',
  modelId = modelResourceId(model);
const origin: [number, number, number] = [14, 32, 0],
  angles: [number, number, number] = [0, 0, 0];
const entity = {
  classname: 'prop_door_rotating',
  model,
  origin,
  angles,
  hammeruniqueid: '2:5',
  initialVisibility: true,
};
test('native hinge, stage visibility, deletion and rewind use the same entity in rendering and queries', () => {
  const state = new Map<number, { visible: boolean; basis: number[] }>(),
    ids: number[] = [];
  const damage = 'models/tests/damage.vmdl';
  const seek = entityPlayback(
    [entity, { ...entity, model: damage, parentEntity: 0, initialVisibility: false }],
    [],
    [
      {
        modelId,
        origin,
        angles,
        samples: [
          [60, 0],
          [61, 90],
        ],
        hidden: [[70, 80]],
        models: [[62, modelResourceId(damage)]],
      },
    ],
    [],
    (id, matrix, visible) => state.set(id, { visible, basis: matrix.toArray() }),
    (id) => ids.push(id),
  );
  seek(60.5);
  assert.ok(Math.abs(state.get(0)!.basis[0] - Math.SQRT1_2) < 1e-6);
  seek(65);
  assert.equal(state.get(0)?.visible, false);
  assert.equal(state.get(1)?.visible, true);
  seek(75);
  assert.equal(state.get(1)?.visible, false);
  seek(59);
  assert.equal(state.get(0)?.visible, true);
  assert.equal(state.get(0)?.basis[0], 1);
  assert.ok(ids.includes(1));
});
test('breakable removal and source-disabled brushes reverse on seek', () => {
  const tags = [
    { ...entity, classname: 'func_breakable' },
    { ...entity, classname: 'func_brush', initialVisibility: false },
  ];
  const visible = [true, false];
  const seek = entityPlayback(
    tags,
    [{ className: 'func_breakable', modelId, origin, angles, hidden: [[10, 20]] }],
    [],
    [{ className: 'func_brush', modelId, origin, angles, visible: [[15, 30]] }],
    (id, _m, value) => (visible[id] = value),
    () => {},
  );
  seek(17);
  assert.deepEqual(visible, [false, true]);
  seek(1);
  assert.deepEqual(visible, [true, false]);
});
