import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundAt, roundEvents } from '../../frontend/src/review-events.js';
import type { Playback } from '../../shared/playback.js';
const data: Playback = {
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

test('timeline projection uses the complete visible axis including endpoints and degenerate ranges', async () => {
  const { timelinePosition } = await import('../../frontend/src/timeline.js');
  assert.equal(timelinePosition(100, { start: 100, end: 1100 }), 0);
  assert.equal(timelinePosition(600, { start: 100, end: 1100 }), 0.5);
  assert.equal(timelinePosition(1100, { start: 100, end: 1100 }), 1);
  assert.equal(timelinePosition(100, { start: 100, end: 100 }), 0);
  assert.equal(timelinePosition(600, { start: 400, end: 800 }), 0.5);
});

test('timeline clusters preserve exact recorded members and every event during resize or zoom', async () => {
  const { timelineGroups } = await import('../../frontend/src/timeline.js');
  const events = roundEvents(data, { number: 0, start: 100, end: 2000 }, data.players[0].id);
  const equalTick = { ...events[0], id: 'same-tick-second-event' };
  const all = [...events, equalTick];
  const narrow = timelineGroups(all, { start: 100, end: 2000 }, 240);
  assert.deepEqual(
    narrow
      .flatMap((group) => group.events)
      .map((event) => event.id)
      .sort(),
    all.map((event) => event.id).sort(),
  );
  assert.ok(
    narrow.some((group) => group.events.includes(equalTick) && group.events.includes(events[0])),
  );
  assert.equal(narrow[0].anchor, (events[0].tick - 100) / 1900);
  const wide = timelineGroups(all, { start: 100, end: 2000 }, 1200);
  assert.ok(wide.length >= narrow.length);
  assert.equal(wide[0].events.length, 2);
  const zoom = timelineGroups(all, { start: 400, end: 800 }, 240);
  assert.ok(
    zoom.every((group) => group.events.every((event) => event.tick >= 400 && event.tick <= 800)),
  );
  assert.deepEqual(timelineGroups([], { start: 0, end: 0 }, 0), []);
});
