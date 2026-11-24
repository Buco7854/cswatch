import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DemoReader } from 'cs2parser';
import { doorKey, validMapDoors } from '../../shared/map-breakables.mjs';
import { observeMapDoors } from '../src/map-doors.js';

const cls = 'CPropDoorRotating',
  root = cls + '.CBodyComponentBaseAnimGraph.m_skeletonInstance.';
const intact = 13506340285893956814n,
  stage = 11854304573097678638n;
const pos = [305.1924743652344, -1350.3822021484375, -767.989990234375];
function setup(broadcast = true, end = 150, reset = 100) {
  const reader = Object.assign(new EventEmitter(), {
    currentTick: 0,
    entities: [] as { className: string; properties: Record<string, unknown> }[],
  });
  const finish = observeMapDoors(reader as unknown as DemoReader, end, [
    { type: 'round_start', tick: reset },
  ]);
  reader.emit('serverinfo', { is_hltv: broadcast });
  function create(tick: number, index: number, serial: number, origin = pos, model = intact) {
    reader.currentTick = tick;
    reader.emit('entitycreated', [index, 22, 3, cls, serial]);
    const p: Record<string, unknown> = {
      [cls + '.m_closedPosition']: origin,
      [cls + '.m_closedAngles']: [0, 0, 0],
      [cls + '.m_eDoorState']: 0n,
      [root + 'm_angRotation']: [0, 0, 0],
      [root + 'm_modelState.m_hModel']: model,
      [root + 'm_flScale']: 1,
      [root + 'm_hParent']: 16777215,
    };
    for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
      const n = Math.round((origin[i] + 16384) * 32) / 32,
        cell = Math.floor(n / 512);
      p[root + 'm_vecOrigin.m_cell' + axis] = cell;
      p[root + 'm_vecOrigin.m_vec' + axis] = n - cell * 512;
    }
    reader.entities[index] = { className: cls, properties: p };
    return p;
  }
  function tick(t: number) {
    reader.currentTick = t;
    reader.emit('tickend');
  }
  function del(t: number, id: number) {
    reader.currentTick = t;
    reader.emit('entitydeleted', id);
    delete reader.entities[id];
  }
  return { reader, finish, create, tick, del };
}

test('a broadcast door retains exact pivot, recorded swing and same-lifetime model swaps until explicit deletion or round reset', () => {
  const q = setup(),
    p = q.create(2, 443, 670);
  q.tick(2);
  p[root + 'm_angRotation'] = [0, -3.125, 0];
  p[cls + '.m_eDoorState'] = 1n;
  q.tick(5);
  p[root + 'm_angRotation'] = [0, -6.25, 0];
  q.tick(6);
  p[root + 'm_angRotation'] = [0, -89, 0];
  p[cls + '.m_eDoorState'] = 2n;
  q.tick(7);
  q.tick(8);
  q.tick(10);
  p[root + 'm_modelState.m_hModel'] = stage;
  q.tick(12);
  q.tick(20);
  q.del(22, 443);
  const next = q.create(100, 115, 18);
  q.tick(100);
  next[root + 'm_angRotation'] = [0, 3.125, 0];
  next[cls + '.m_eDoorState'] = 1n;
  q.tick(103);
  q.tick(106);
  const rows = q.finish(true);
  assert.ok(validMapDoors(rows, 150));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].samples, [
    [5, -3.125],
    [6, -6.25],
    [7, -89],
    [22, null],
    [103, 3.125],
    [104, null],
  ]);
  assert.deepEqual(rows[0].hidden, [[22, 100]]);
  assert.deepEqual(rows[0].models, [
    [12, String(stage)],
    [22, null],
  ]);
  assert.equal(
    doorKey(rows[0]),
    doorKey({ ...rows[0], origin: [305.192474, -1350.382202, -767.98999], angles: [0, 0, 0] }),
  );
  assert.notEqual(doorKey(rows[0]), doorKey({ ...rows[0], origin: [305.1875, -1350.375, -768] }));
});

test('PVS absence, ambiguous lifetimes, unsupported parents and first-person recordings do not establish deletion', () => {
  for (const mode of ['pvs', 'overlap', 'parent', 'pov', 'reused', 'failed', 'uncertified']) {
    const q = setup(mode !== 'pov'),
      p = q.create(0, 9, 1);
    q.tick(0);
    if (mode === 'overlap') {
      q.create(2, 10, 2);
      q.tick(2);
      q.del(3, 9);
    }
    if (mode === 'parent') {
      p[root + 'm_hParent'] = 5;
      q.tick(1);
      q.del(4, 9);
    }
    if (mode === 'pvs') {
      delete q.reader.entities[9];
      q.tick(9);
      q.del(10, 9);
    }
    if (mode === 'reused') {
      q.reader.currentTick = 3;
      q.reader.emit('entitycreated', [9, 1, 1, 'CCSPlayerPawn', 3]);
      q.del(4, 9);
    }
    if (mode === 'uncertified') {
      q.create(3, 9, 1);
      q.del(3, 9);
    }
    if (mode === 'pov' || mode === 'failed') {
      q.del(11, 9);
    }
    assert.equal(q.finish(mode !== 'failed'), undefined, mode);
  }
});

test('a changed damage model can establish a track on a completely stationary door', () => {
  const q = setup();
  const p = q.create(1, 1, 2);
  q.tick(1);
  p[root + 'm_modelState.m_hModel'] = stage;
  q.tick(2);
  const rows = q.finish(true)!;
  assert.deepEqual(rows[0].samples, []);
  assert.deepEqual(rows[0].models, [
    [2, String(stage)],
    [100, null],
  ]);
  for (const override of [
    { samples: [[1, 181]] },
    { models: [[2, '18446744073709551616']] },
    {
      hidden: [
        [3, 151],
        [9, 100],
      ],
    },
    { foo: true },
  ]) {
    assert.equal(validMapDoors([{ ...rows[0], ...override }], 150), false);
  }
  assert.equal(validMapDoors([rows[0], rows[0]], 150), false);
});

test('successive authenticated Nuke VMDL changes retain one initial identity through complete removal', () => {
  const q = setup(true, 13000, 12500);
  const p = q.create(11000, 95, 166, [257, -1310, -416]);
  q.tick(11000);
  const states: [number, bigint][] = [
    [11210, 11854304573097678638n],
    [11236, 5550701383053343002n],
    [11268, 14367283058860035795n],
  ];
  for (const [t, model] of states) {
    p[root + 'm_modelState.m_hModel'] = model;
    q.tick(t);
  }
  q.del(12017, 95);
  const result = q.finish(true);
  assert.ok(validMapDoors(result, 13000));
  assert.equal(result.length, 1);
  assert.equal(result[0].modelId, String(intact));
  assert.deepEqual(result[0].models, [...states.map(([t, m]) => [t, String(m)]), [12017, null]]);
  assert.deepEqual(result[0].hidden, [[12017, 12500]]);
});
