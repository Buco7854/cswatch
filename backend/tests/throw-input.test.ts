import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectThrowInputs, readEventRows, removeEventInputExtras } from '../src/throw-input.js';
import type { GameEvent } from '../../shared/playback.js';
const actor = '76561198000000001';
const players = [{ id: actor, name: 'Duplicate name', team: 3 }];

test('throw input metadata reads event-time64-bit command/network snapshots without16Hz-frame or nickname inference', () => {
  const events: GameEvent[] = [
    {
      type: 'weapon_fire',
      tick: 101,
      user_steamid: actor,
      weapon: 'weapon_smokegrenade',
      user_buttons: '9223372036854777867',
    },
    {
      type: 'grenade_thrown',
      tick: 102,
      user_steamid: actor,
      weapon: 'flashbang',
      user_usercmd_buttons_held: '2051',
      user_usercmd_buttons_released: '1',
    },
    {
      type: 'grenade_thrown',
      tick: 103,
      user_steamid: actor,
      weapon: 'flashbang',
      user_usercmd_buttons_held: null,
      user_FORWARD: false,
      user_FIRE: false,
    },
    {
      type: 'grenade_thrown',
      tick: 104,
      user_name: 'Duplicate name',
      weapon: 'flashbang',
      user_buttons: '1',
    },
    { type: 'weapon_fire', tick: 105, user_steamid: actor, weapon: 'ak47', user_buttons: '1' },
  ];
  const { snapshots, complete } = collectThrowInputs(events, players);
  assert.equal(complete, true);
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[0].eventIndex, 0);
  assert.equal(snapshots[0].sampleTick, 101);
  assert.equal(snapshots[0].provenance, 'event-network');
  assert.equal(snapshots[0].input?.buttons, '9223372036854777867');
  assert.equal(snapshots[0].input?.attack, true);
  assert.equal(snapshots[0].input?.attack2, true);
  assert.equal(snapshots[0].input?.jump, true);
  assert.equal(snapshots[1].provenance, 'event-usercmd');
  assert.equal(snapshots[1].input?.releasedButtons, '1');
  assert.deepEqual(snapshots[2], {
    eventIndex: 2,
    tick: 103,
    actorId: actor,
    provenance: 'unavailable',
  });
  removeEventInputExtras(events);
  assert.equal(events[0].user_buttons, undefined);
  assert.equal(
    snapshots[0].input?.buttons,
    '9223372036854777867',
    'global input metadata survives event-extra cleanup',
  );
});

test('optional event fields fail independently and incompatible event sequences cannot merge identities', () => {
  const base = { tick: 100, user_steamid: actor, weapon: 'smokegrenade' };
  const rows = readEventRows(
    (fields) => {
      if (fields.includes('unsupported')) throw new Error('unsupported field');
      return [
        {
          ...base,
          ...(fields.includes('X') ? { user_X: 12 } : {}),
          ...(fields.includes('buttons') ? { user_buttons: '1' } : {}),
        },
      ];
    },
    [['X'], ['buttons', 'unsupported']],
  );
  assert.equal(rows[0].user_X, 12);
  assert.equal(rows[0].user_buttons, '1');
  const incompatible = readEventRows(
    (fields) => {
      if (fields.length > 1) throw new Error('force independent groups');
      return fields.length
        ? [{ ...base, user_steamid: '76561198000000002', user_buttons: '2048' }]
        : [{ ...base }];
    },
    [['buttons'], ['unsupported']],
  );
  assert.equal(
    incompatible[0].user_buttons,
    undefined,
    'same name/time cannot merge another actor’s fields',
  );
});

test('throw snapshots are bounded and report incomplete metadata without inventing unavailable commands', () => {
  const events: GameEvent[] = Array.from({ length: 10001 }, (_, tick) => ({
    type: 'grenade_thrown',
    tick,
    user_steamid: actor,
    weapon: 'smokegrenade',
  }));
  const result = collectThrowInputs(events, players);
  assert.equal(result.snapshots.length, 10000);
  assert.equal(result.complete, false);
  assert.equal(result.snapshots.at(-1)!.provenance, 'unavailable');
});
