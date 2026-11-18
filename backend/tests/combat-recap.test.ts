import assert from 'node:assert/strict';
import test from 'node:test';
import type { Playback } from '../../shared/playback.js';
import { combatDamage } from '../../frontend/src/combat-recap.js';
import { buildReviewMoments } from '../../frontend/src/review-moments.js';

const selected = '76561198000000001',
  killer = '76561198000000002',
  support = '76561198000000003';
function fixture(): Playback {
  return {
    version: 1,
    sample: false,
    map: 'de_explicit_damage_fixture',
    tickRate: 64,
    players: [selected, killer, support].map((id) => ({ id, name: 'Duplicate nickname', team: 2 })),
    frames: [],
    rounds: [
      { number: 1, tick: 0 },
      { number: 2, tick: 1000 },
    ],
    eventAvailability: { player_death: true, player_hurt: true },
    events: [
      { type: 'round_start', tick: 0 },
      {
        type: 'player_hurt',
        tick: 100,
        attacker_steamid: killer,
        user_steamid: selected,
        dmg_health: 70,
      },
      {
        type: 'player_hurt',
        tick: 110,
        attacker_steamid: support,
        user_steamid: selected,
        dmg_health: 83,
      },
      {
        type: 'player_hurt',
        tick: 120,
        attacker_steamid: selected,
        user_steamid: killer,
        dmg_health: 37,
      },
      {
        type: 'player_hurt',
        tick: 128,
        attacker_steamid: killer,
        user_steamid: selected,
        dmg_health: 34,
      },
      {
        type: 'player_death',
        tick: 128,
        attacker_steamid: killer,
        user_steamid: selected,
        weapon: 'fiveseven',
        headshot: true,
      },
      {
        type: 'player_hurt',
        tick: 129,
        attacker_steamid: support,
        user_steamid: selected,
        dmg_health: 999,
      },
      { type: 'round_start', tick: 1000 },
      {
        type: 'player_hurt',
        tick: 1100,
        attacker_steamid: support,
        user_steamid: selected,
        dmg_health: 12,
      },
      {
        type: 'player_death',
        tick: 1200,
        attacker_steamid: support,
        user_steamid: selected,
        weapon: 'ak47',
      },
    ],
  };
}
test('combat recap aggregates actual round damage by immutable player IDs through the exact elimination', () => {
  const data = fixture(),
    moment = buildReviewMoments(data, 0, 1500).kills[0];
  const damage = combatDamage(data, moment, selected, 1500);
  assert.equal(damage.coverage, 'complete');
  assert.deepEqual(
    damage.taken.map((row) => [row.playerId, row.damage]),
    [
      [killer, 104],
      [support, 83],
    ],
  );
  assert.deepEqual(
    damage.dealt.map((row) => [row.playerId, row.damage]),
    [[killer, 37]],
  );
  const reversed = combatDamage(data, moment, killer, 1500);
  assert.deepEqual(
    reversed.taken.map((row) => [row.playerId, row.damage]),
    [[selected, 37]],
  );
  assert.deepEqual(
    reversed.dealt.map((row) => [row.playerId, row.damage]),
    [[selected, 104]],
  );
  const second = combatDamage(data, buildReviewMoments(data, 0, 1500).kills[1], selected, 1500);
  assert.deepEqual(
    second.taken.map((row) => [row.playerId, row.damage]),
    [[support, 12]],
  );
  assert.deepEqual(second.dealt, []);
});
test('a death event never fabricates damage and missing query or round coverage cannot promise zeroes', () => {
  const data = fixture();
  data.events = data.events.filter((event) => event.type !== 'player_hurt');
  const moment = buildReviewMoments(data, 0, 1500).kills[0];
  assert.deepEqual(combatDamage(data, moment, selected, 1500), {
    taken: [],
    dealt: [],
    coverage: 'complete',
  });
  data.eventAvailability = undefined;
  assert.deepEqual(combatDamage(data, moment, selected, 1500), {
    taken: [],
    dealt: [],
    coverage: 'unavailable',
  });
  data.eventAvailability = { player_death: true, player_hurt: true };
  data.events = data.events.filter((event) => event.type !== 'round_start');
  assert.equal(combatDamage(data, moment, selected, 1500).coverage, 'unavailable');
});
test('partial hit evidence stays partial and duplicate nicknames cannot attach unresolved hits to a player', () => {
  const data = fixture(),
    moment = buildReviewMoments(data, 0, 1500).kills[0];
  data.events.push(
    {
      type: 'player_hurt',
      tick: 115,
      attacker_name: 'Duplicate nickname',
      user_name: 'Duplicate nickname',
      dmg_health: 500,
    },
    {
      type: 'player_hurt',
      tick: 116,
      attacker_steamid: killer,
      user_steamid: selected,
      dmg_health: '200',
    },
  );
  const result = combatDamage(data, moment, selected, 1500);
  assert.equal(result.coverage, 'partial');
  assert.deepEqual(
    result.taken.map((row) => [row.playerId, row.damage]),
    [
      [killer, 104],
      [support, 83],
    ],
  );
  assert.deepEqual(
    result.dealt.map((row) => [row.playerId, row.damage]),
    [[killer, 37]],
  );
});
