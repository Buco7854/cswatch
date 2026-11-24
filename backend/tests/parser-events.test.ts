import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGameEvents } from '../src/parser-events.js';

test('shared event scans retain same-tick kind and source order, including absent events', () => {
  let scans = 0;
  const { events, warnings, eventAvailability } = readGameEvents(
    'fixture',
    (_, kinds) => {
      scans++;
      return kinds!.includes('round_end')
        ? [
            { tick: 71, event_name: 'round_end', winner: 3 },
            { tick: 72, event_name: 'round_freeze_end' },
            { tick: 71, event_name: 'round_start', round: 2 },
            { tick: 71, event_name: 'round_start', round: 3 },
          ]
        : [];
    },
    () => assert.fail('Unnecessary per-kind parse'),
  );
  assert.equal(scans, 5);
  assert.deepEqual(
    events.map((row) => [row.type, row.tick, row.round]),
    [
      ['round_start', 71, 2],
      ['round_start', 71, 3],
      ['round_end', 71, undefined],
      ['round_freeze_end', 72, undefined],
    ],
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(eventAvailability, { player_death: true, player_hurt: true });
});

test('unreadable batch or unexpected names fall back to individual events and optional fields', () => {
  const { events, warnings, eventAvailability } = readGameEvents(
    'fixture',
    (_, kinds) => {
      if (kinds!.includes('bomb_planted')) return [{ tick: 51, event_name: 'unexpected' }];
      if (kinds!.includes('player_hurt')) throw Error();
      return [];
    },
    (_, kind, player, other) => {
      if (kind === 'player_hurt' || player?.length || other?.length) throw Error();
      return kind === 'player_death' || kind === 'bomb_planted'
        ? [{ tick: 51, event_name: kind }]
        : [];
    },
  );
  assert.deepEqual(
    events.map((row) => row.type),
    ['player_death', 'bomb_planted'],
  );
  assert.deepEqual(warnings, ['Event player_hurt is unavailable.']);
  assert.deepEqual(eventAvailability, { player_death: true, player_hurt: false });
});
