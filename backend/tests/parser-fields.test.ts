import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectColumnFrameState, collectFrameState } from '../src/frame-state.js';
import { playerColumns, readPlayerColumns, recordedCameraFov } from '../src/parser-fields.js';
import { columnsOf } from './fixtures/player-columns.js';

const alice = '76561198000000001',
  bob = '76561198000000002';
const row = (tick: number, steamid = alice, extra: Record<string, unknown> = {}) => ({
  tick,
  steamid,
  name: 'Same display name',
  X: tick,
  Y: 10,
  Z: 20,
  health: 100,
  team_num: 2,
  is_alive: true,
  is_freeze_period: tick < 12,
  ...extra,
});

test('reload timing requires a recorded transition on the same active weapon handle', () => {
  const snapshot = (tick: number, active: unknown, handle = 0x200001) =>
    row(tick, alice, {
      active_weapon_name: 'AK-47',
      active_weapon: handle,
      is_in_reload: active,
      RELOAD: true,
    });
  const result = collectColumnFrameState(
    columnsOf([
      snapshot(4, true),
      snapshot(8, true),
      snapshot(12, false),
      snapshot(16, true),
      snapshot(20, true),
      snapshot(24, true, 0x400001),
      snapshot(28, false),
      snapshot(32, null),
      snapshot(36, true),
      snapshot(40, false),
      snapshot(48, true),
    ]),
  );
  assert.deepEqual(
    result.frames.map((frame) => frame.players[0].reloadStarted),
    [
      undefined,
      undefined,
      undefined,
      16,
      16,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
  );
});

test('column projection preserves unordered recorded frames, nulls, counters and input evidence', () => {
  const rows = [
    row(12, alice, { balance: 0, armor_value: 0, kills_total: 0, buttons: '0' }),
    row(4, bob, { balance: null, armor_value: null, usercmd_mouse_dx: -2 }),
    row(8, alice, { inventory: ['Flashbang', 'Flashbang'], FORWARD: true }),
    row(4, alice, { has_helmet: false, has_defuser: true, kills_total: 12 }),
    row(-1),
    row(64 * 60 * 180 + 1),
    row(16, alice, { X: null }),
    row(20, alice, { steamid: 76561198000000000 }),
  ];
  const result = collectColumnFrameState(columnsOf(rows));
  assert.deepEqual(result, collectFrameState(rows));
  assert.deepEqual(
    result.frames.map((frame) => frame.tick),
    [4, 8, 12],
  );
  assert.deepEqual(result.deadTimes, [{ start: 4, end: 12, kind: 'freeze' }]);
  assert.equal(result.frames[0].players[0].money, undefined);
  assert.equal(result.frames[2].players[0].money, 0);
  assert.deepEqual(result.frames[2].players[0].stats, { kills: 0 });
});

test('optional columns join only immutable tick/player identity across reordered and missing rows', () => {
  const base = columnsOf([row(8), row(4, bob), row(4)]);
  const result = readPlayerColumns(
    (fields) => {
      if (fields.includes('unsupported')) throw new Error('Unsupported native field');
      if (fields.includes('X')) return base;
      if (fields.includes('balance'))
        return columnsOf([
          row(4, alice, { balance: 0 }),
          row(8, alice, { balance: 800 }),
          row(4, '76561198000000003', { balance: 999999 }),
        ]);
      if (fields.includes('armor_value'))
        return columnsOf([row(4, bob, { armor_value: 70 }), row(4, alice, { armor_value: 0 })]);
      return columnsOf([]);
    },
    ['X'],
    [['balance'], ['armor_value', 'unsupported']],
  );
  const frames = collectColumnFrameState(result).frames;
  assert.deepEqual(
    frames.map((frame) => frame.players.map((player) => [player.id, player.money, player.armor])),
    [
      [
        [bob, undefined, 70],
        [alice, 0, 0],
      ],
      [[alice, 800, undefined]],
    ],
  );
  assert.deepEqual(result.tick, [8, 4, 4]);
  assert.deepEqual(result.steamid, [alice, bob, alice]);
});

test('nullable optional retries cannot erase prior economy values or fabricate key releases', () => {
  const base = columnsOf([row(4), row(8)]);
  const result = readPlayerColumns(
    (fields) => {
      if (fields.includes('unsupported')) throw new Error('Unsupported native field');
      if (fields.includes('X')) return base;
      if (fields.includes('balance'))
        return columnsOf([row(4, alice, { balance: 0 }), row(8, alice, { balance: 400 })]);
      if (fields.includes('FORWARD'))
        return columnsOf([
          row(4, alice, { balance: null, FORWARD: false }),
          row(8, alice, { balance: null, FORWARD: false }),
        ]);
      return columnsOf([]);
    },
    ['X'],
    [['balance'], ['FORWARD', 'unsupported']],
  );
  const frames = collectColumnFrameState(result).frames;
  assert.deepEqual(
    frames.map((frame) => frame.players[0].money),
    [0, 400],
  );
  assert.ok(frames.every((frame) => frame.players[0].input === undefined));
});

test('native columns reject malformed identities, unequal lengths and excess rows', () => {
  for (const invalid of [
    null,
    [],
    {},
    { tick: [4] },
    { tick: [4], steamid: [] },
    { tick: [4], steamid: [alice], X: 4 },
  ])
    assert.throws(() => playerColumns(invalid), /Invalid player columns/);
  assert.throws(() => playerColumns(columnsOf([row(4), row(8)]), 1), /Invalid player columns/);
  assert.throws(
    () => readPlayerColumns(() => ({ tick: [4], steamid: [alice], X: [] }), ['X'], []),
    /Invalid player columns/,
  );
});

test('scope projection requires explicit recorded FOV and a living scoped player', () => {
  const data = columnsOf([
    row(4, alice, { is_scoped: true, [recordedCameraFov]: 40 }),
    row(8, alice, { is_scoped: true, [recordedCameraFov]: 10 }),
    row(12, alice, { is_scoped: false, [recordedCameraFov]: 10 }),
    row(16, alice, { is_scoped: true, is_alive: false, [recordedCameraFov]: 10 }),
    row(20, alice, { is_scoped: true, [recordedCameraFov]: 0 }),
    row(24, alice, { is_scoped: true }),
  ]);
  assert.deepEqual(
    collectColumnFrameState(data).frames.map(({ players }) => players[0].scopeFov),
    [40, 10, undefined, undefined, undefined, undefined],
  );
});
