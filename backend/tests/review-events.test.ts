import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundAt, roundEvents } from '../../frontend/src/review-events.js';
import type { Playback } from '../../shared/playback.js';
const data: Playback = {
  version: 1,
  map: 'de_mirage',
  sample: false,
  tickRate: 64,
  frames: [],
  players: [
    { id: '76561198000000001', name: 'same name', team: 2 },
    { id: '76561198000000002', name: 'same name', team: 3 },
    { id: '76561198000000003', name: 'other', team: 2 },
  ],
  rounds: [
    { number: 1, tick: 100, liveTick: 120, endTick: 800 },
    { number: 2, tick: 1000, liveTick: 1020 },
  ],
  events: [
    {
      type: 'player_death',
      tick: 300,
      attacker_steamid: '76561198000000001',
      attacker_name: 'same name',
      user_steamid: '76561198000000003',
      user_name: 'other',
      weapon: 'ak47',
      headshot: true,
    },
    {
      type: 'player_death',
      tick: 400,
      attacker_steamid: '76561198000000003',
      attacker_name: 'other',
      user_steamid: '76561198000000001',
      user_name: 'same name',
    },
    { type: 'bomb_planted', tick: 500, user_steamid: '76561198000000003', user_name: 'other' },
    { type: 'bomb_defused', tick: 700, user_steamid: '76561198000000002', user_name: 'same name' },
    { type: 'round_end', tick: 800, winner: 3 },
    { type: 'bomb_exploded', tick: 1000 },
    { type: 'player_death', tick: 2000, attacker_name: 'same name', user_name: 'other' },
  ],
};
test('round boundaries include post-round events and assign exact next-round/final ticks once', () => {
  const first = roundAt(data, 500, 2000),
    second = roundAt(data, 1000, 2000);
  assert.deepEqual(first, { number: 1, start: 100, end: 999, liveTick: 120 });
  assert.equal(roundAt(data, 50, 2000).number, 1);
  assert.equal(roundAt(data, 3000, 2000).number, 2);
  assert.equal(roundEvents(data, first, '').length, 5);
  assert.deepEqual(
    roundEvents(data, second, '').map((event) => event.tick),
    [1000, 2000],
  );
  assert.equal(roundAt({ ...data, rounds: [] }, 1000, 2000).end, 2000);
});
test('player kills/deaths use exact string IDs, retain objectives and never match duplicate nicknames', () => {
  const round = roundAt(data, 500, 2000);
  const events = roundEvents(data, round, '76561198000000001', 'player');
  assert.deepEqual(
    events.map((event) => event.type),
    ['kill', 'death', 'plant', 'defuse', 'round-end'],
  );
  assert.equal(events[0].headshot, true);
  assert.equal(events[1].selected, true);
  assert.equal(events[2].selected, false);
  const duplicate = roundEvents(data, round, '76561198000000002', 'player');
  assert.deepEqual(
    duplicate.map((event) => event.type),
    ['plant', 'defuse', 'round-end'],
  );
  assert.equal(duplicate[1].selected, true);
  assert.deepEqual(
    roundEvents(data, roundAt(data, 1500, 2000), '76561198000000001', 'player').map(
      (event) => event.type,
    ),
    ['explosion'],
  );
  const all = roundEvents(data, { number: 0, start: 0, end: 2000 }, '76561198000000001');
  const filtered = roundEvents(data, round, '76561198000000001');
  assert.equal(all[0].id, filtered[0].id);
});
test('unavailable events produce an honest empty state; names-only matching is limited to explicit practice data', () => {
  assert.deepEqual(roundEvents({ ...data, events: [] }, roundAt(data, 200, 2000), 'x'), []);
  const fixture = {
    ...data,
    sample: true,
    players: [{ id: 'practice', name: 'only practice name', team: 2 }],
    events: [
      { type: 'player_death', tick: 200, attacker_name: 'only practice name', user_name: 'target' },
    ],
  };
  assert.equal(
    roundEvents(fixture, roundAt(fixture, 200, 2000), 'practice', 'player')[0].type,
    'kill',
  );
});
