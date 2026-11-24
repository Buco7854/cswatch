import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { DemoReader } from 'cs2parser';
import { observeMapBreakables } from '../src/map-breakables.js';

const firstPane = 6701466429079771529n;
const secondPane = 12219124112549963979n;
function fixture() {
  const reader = Object.assign(new EventEmitter(), {
    entities: [] as { className: string; properties: Record<string, unknown> }[],
    currentTick: 0,
  });
  const finish = observeMapBreakables(reader as unknown as DemoReader, 130, [
    { type: 'round_start', tick: 20 },
    { type: 'round_start', tick: 100 },
  ]);
  function put(
    tick: number,
    index: number,
    serial: number,
    model = firstPane,
    name = 'CBreakable',
  ) {
    const body =
      name === 'CBreakable' ? 'CBodyComponentBaseModelEntity' : 'CBodyComponentBaseAnimGraph';
    const root = name + '.' + body + '.m_skeletonInstance.';
    const props: Record<string, unknown> = {
      [root + 'm_modelState.m_hModel']: model,
      [root + 'm_hParent']: 16777215,
      [root + 'm_angRotation']: [0, 0, 0],
      [root + 'm_flScale']: 1,
    };
    for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
      const shifted = [1414.5, model === secondPane ? -601 : -391, -341][i] + 16384;
      const cell = Math.floor(shifted / 512);
      props[root + 'm_vecOrigin.m_cell' + axis] = cell;
      props[root + 'm_vecOrigin.m_vec' + axis] = shifted - cell * 512;
    }
    reader.currentTick = tick;
    reader.entities[index] = { className: name, properties: props };
    reader.emit('entitycreated', [index, 0, 0, name, serial]);
    reader.emit('tickend');
    return props;
  }
  function remove(tick: number, index: number) {
    reader.currentTick = tick;
    delete reader.entities[index];
    reader.emit('entitydeleted', index);
  }
  return { put, remove, finish: () => finish(true) };
}
test('an explicit Nuke brush deletion removes only its stationary mesh until restoration or next round', () => {
  const f = fixture();
  f.put(1, 1, 7);
  f.put(1, 2, 5, secondPane);
  f.put(1, 3, 6, firstPane, 'CDynamicProp'); // The same ID and transform belongs to a different class.
  f.put(20, 4, 8); // Old and new generations coexist at the reset.
  f.put(20, 5, 9, secondPane);
  f.remove(22, 1);
  f.put(23, 2, 5, secondPane); // Full packet snapshot of the retired instance.
  f.remove(24, 2);
  f.remove(40, 4);
  f.put(49, 6, 18);
  f.remove(63, 5);
  f.remove(72, 3);
  const rows = f.finish()!;
  assert.deepEqual(
    rows
      .filter((x) => x.className === 'func_breakable')
      .map((x) => [x.modelId, x.origin, x.hidden]),
    [
      [String(firstPane), [1414.5, -391, -341], [[40, 49]]],
      [String(secondPane), [1414.5, -601, -341], [[63, 100]]],
    ],
  );
  assert.deepEqual(rows.find((x) => !x.className)?.hidden, [[72, 100]]);
});
test('simultaneous same-generation brushes and moved or reparented brushes never certify geometry loss', () => {
  const d = fixture();
  d.put(20, 3, 41);
  d.put(20, 5, 72);
  d.remove(37, 3);
  d.remove(70, 5);
  assert.equal(d.finish(), undefined);
  for (const [field, changed] of [
    ['m_vecOrigin.m_vecY', 123],
    ['m_hParent', 72],
    ['m_flScale', 2],
  ] as const) {
    const f = fixture();
    const props = f.put(1, 3, 7);
    props['CBreakable.CBodyComponentBaseModelEntity.m_skeletonInstance.' + field] = changed;
    f.remove(35, 3);
    assert.equal(f.finish(), undefined);
  }
});
