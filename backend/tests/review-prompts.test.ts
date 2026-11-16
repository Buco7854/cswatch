import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompts, reviewPromptsAt } from '../../frontend/src/review-prompts.js';
import type { GameEvent, Playback } from '../../shared/playback.js';

const selected = '76561198000000001',
  duplicateName = '76561198000000002',
  target = '76561198000000003';
const first = 100,
  last = 4000;
function replay(events: GameEvent[]): Playback {
  return {
    version: 1,
    map: 'de_fixture',
    sample: false,
    tickRate: 64,
    players: [
      { id: selected, name: 'same name', team: 2 },
      { id: duplicateName, name: 'same name', team: 3 },
      { id: target, name: 'other', team: 3 },
    ],
    frames: [],
    rounds: [
      { number: 1, tick: first },
      { number: 2, tick: 2000 },
    ],
    events,
  };
}
const release = (tick = 600, extra: Partial<GameEvent> = {}): GameEvent => ({
  type: 'grenade_thrown',
  tick,
  user_steamid: selected,
  user_name: 'same name',
  weapon: 'flashbang',
  ...extra,
});
const impact = (tick = 700, extra: Partial<GameEvent> = {}): GameEvent => ({
  type: 'flashbang_detonate',
  tick,
  user_steamid: selected,
  x: 1280,
  y: -1024,
  z: 64,
  ...extra,
});
const kill = (tick = 900, extra: Partial<GameEvent> = {}): GameEvent => ({
  type: 'player_death',
  tick,
  attacker_steamid: selected,
  user_steamid: target,
  attacker_name: 'same name',
  user_name: 'other',
  weapon: 'ak47',
  ...extra,
});

test('kill replay prompts follow immutable player IDs and clamp their context to global/round bounds', () => {
  const data = replay([
    kill(),
    kill(1980),
    kill(1100, { attacker_steamid: duplicateName }),
    kill(1200, { attacker_steamid: undefined }),
    kill(1300, { user_steamid: selected }),
  ]);
  const index = buildReviewPrompts(data, selected, first, last);
  assert.equal(index.kills.length, 2);
  assert.deepEqual(
    index.kills.map((prompt) => [
      prompt.tick,
      prompt.startTick,
      prompt.endTick,
      prompt.attackerId,
      prompt.target,
    ]),
    [
      [900, 708, 1028, selected, 'other'],
      [1980, 1788, 1999, selected, 'other'],
    ],
  );
  assert.equal(reviewPromptsAt(index, 899).kill, null);
  assert.equal(reviewPromptsAt(index, 900).kill?.tick, 900);
  assert.equal(reviewPromptsAt(index, 1980).kill?.tick, 1980);
  assert.equal(reviewPromptsAt(index, 2364).kill, null);
  assert.equal(
    reviewPromptsAt(index, 900).kill?.tick,
    900,
    'backward seeks do not retain the later kill',
  );
  assert.equal(buildReviewPrompts(data, duplicateName, first, last).kills.length, 1);
});

test('exact entity association keeps recorded landing coordinates and deduplicates native release representations', () => {
  const data = replay([
    release(600, { type: 'weapon_fire', entityid: 81 }),
    release(600, { entityid: 81, user_X: 10, user_Y: -20, user_Z: 30 }),
    impact(700, { entityid: '81' }),
    release(620, { user_steamid: duplicateName, entityid: 82 }),
    impact(720, { user_steamid: duplicateName, entityid: 82 }),
  ]);
  const index = buildReviewPrompts(data, selected, first, last);
  assert.equal(index.landings.length, 1);
  const prompt = index.landings[0];
  assert.deepEqual(
    {
      tick: prompt.tick,
      start: prompt.startTick,
      end: prompt.endTick,
      impact: prompt.impactTick,
      source: prompt.source,
      association: prompt.association,
      target: prompt.target,
      origin: prompt.origin,
    },
    {
      tick: 600,
      start: 584,
      end: 828,
      impact: 700,
      source: 'recorded-detonation',
      association: 'entity-id',
      target: { x: 1280, y: -1024, z: 64 },
      origin: { x: 10, y: -20, z: 30 },
    },
  );
  assert.equal(prompt.throwerId, selected);
  assert.equal(reviewPromptsAt(index, 599).landing, null);
  assert.equal(reviewPromptsAt(index, 600).landing?.id, prompt.id);
  assert.equal(reviewPromptsAt(index, 983.9).landing?.id, prompt.id);
  assert.equal(reviewPromptsAt(index, 984).landing, null);
});

test('unambiguous owner fallback supports sequential flights but never overlapping or contradictory releases', () => {
  const sequential = buildReviewPrompts(
    replay([release(), impact(), release(1000), impact(1100)]),
    selected,
    first,
    last,
  );
  assert.equal(sequential.landings.length, 2);
  assert.ok(sequential.landings.every((prompt) => prompt.association === 'unambiguous-owner'));
  assert.deepEqual(sequential.landings[0].target, { x: 1280, y: -1024, z: 64 });
  const overlapping = replay([release(), release(620), impact(), impact(720)]);
  assert.equal(buildReviewPrompts(overlapping, selected, first, last).landings.length, 0);
  const exact = replay([
    release(600, { entityid: 81 }),
    release(620, { entityid: 82 }),
    impact(700, { entityid: 81 }),
    impact(720, { entityid: 82 }),
  ]);
  assert.equal(buildReviewPrompts(exact, selected, first, last).landings.length, 2);
  assert.equal(
    buildReviewPrompts(
      replay([release(600, { entityid: 81 }), impact(700, { entityid: 82 })]),
      selected,
      first,
      last,
    ).landings.length,
    0,
  );
  assert.equal(
    buildReviewPrompts(replay([release(), release(), impact()]), selected, first, last).landings
      .length,
    0,
    'two explicit unidentifiable throws cannot be deduplicated by nickname/tick',
  );
});

test('partial, invalid, wrong-owner or cross-round data never becomes a guessed landing', () => {
  const cases: GameEvent[][] = [
    [release()],
    [release(), impact(700, { user_steamid: undefined, user_name: 'same name' })],
    [release(), impact(700, { user_steamid: duplicateName })],
    [release(), impact(700, { z: undefined })],
    [release(), impact(700, { z: Infinity })],
    [release(), impact(700, { x: 10_000_001 })],
    [
      release(),
      impact(700, { x: undefined, y: undefined, z: undefined, user_X: 1, user_Y: 2, user_Z: 3 }),
    ],
    [release(1980), impact(2010)],
    [release(), impact(1369)],
    [release(600, { entityid: 81, entity_id: 82 }), impact()],
    [release(600, { user_steamid: selected, owner_steamid: duplicateName }), impact()],
    [release(600, { entityid: Number.MAX_SAFE_INTEGER + 1 }), impact()],
    [release(600, { user_steamid: Number(selected) as unknown as string }), impact()],
  ];
  for (const events of cases)
    assert.equal(buildReviewPrompts(replay(events), selected, first, last).landings.length, 0);
  const zero = buildReviewPrompts(
    replay([release(), impact(700, { x: 0, y: 0, z: 0 })]),
    selected,
    first,
    last,
  ).landings[0];
  assert.deepEqual(zero.target, { x: 0, y: 0, z: 0 });
  assert.equal(zero.origin, undefined, 'missing origin is not inferred from a later player frame');
});

test('global event prompt IDs and endpoints remain stable when loaded chunk trajectories/frames change', () => {
  const data = replay([release(), impact(), kill()]);
  const full = buildReviewPrompts(data, selected, first, last);
  const chunk = buildReviewPrompts(
    {
      ...data,
      frames: [],
      grenades: [
        { id: 'clipped', kind: 'flashbang', points: [{ tick: 640, x: 999, y: 999, z: 999 }] },
      ],
    },
    selected,
    first,
    last,
  );
  assert.deepEqual(chunk, full);
  assert.deepEqual(reviewPromptsAt(full, first - 1), { kill: null, landing: null });
  assert.deepEqual(reviewPromptsAt(full, last + 1), { kill: null, landing: null });
  assert.deepEqual(reviewPromptsAt(full, NaN), { kill: null, landing: null });
  assert.deepEqual(buildReviewPrompts(data, 'unknown', first, last).landings, []);
});

test('conflicting terminal records never choose an arbitrary landing and future exact evidence outranks a weak earlier event', () => {
  for (const entity of [undefined, 73]) {
    const data = replay([
      release(600, { entityid: entity }),
      impact(700, { entityid: entity }),
      impact(720, { entityid: entity, x: 4000 }),
    ]);
    assert.equal(buildReviewPrompts(data, selected, first, last).landings.length, 0);
  }
  const exactLater = buildReviewPrompts(
    replay([
      release(600, { entityid: 73 }),
      impact(680, { x: 4000 }),
      impact(700, { entityid: 73 }),
    ]),
    selected,
    first,
    last,
  );
  assert.equal(exactLater.landings.length, 1);
  assert.equal(exactLater.landings[0].impactTick, 700);
  assert.deepEqual(exactLater.landings[0].target, { x: 1280, y: -1024, z: 64 });
  assert.equal(exactLater.landings[0].association, 'entity-id');
  const reused = buildReviewPrompts(
    replay([
      release(600, { entityid: 73 }),
      impact(700, { entityid: 73 }),
      release(1000, { entityid: 73 }),
      impact(1100, { entityid: 73, x: 900 }),
    ]),
    selected,
    first,
    last,
  );
  assert.deepEqual(
    reused.landings.map((prompt) => prompt.impactTick),
    [700, 1100],
  );
});

test('only explicit practice data may use unique synthetic names; kind compatibility never invents endpoints', () => {
  const data = replay([
    release(600, { user_steamid: undefined, user_name: 'other', weapon: 'incgrenade' }),
    impact(700, { user_steamid: undefined, user_name: 'other', type: 'inferno_startburn' }),
  ]);
  assert.equal(buildReviewPrompts(data, target, first, last).landings.length, 0);
  assert.equal(
    buildReviewPrompts({ ...data, sample: true }, target, first, last).landings.length,
    1,
  );
  assert.equal(
    buildReviewPrompts(
      {
        ...replay([
          release(600, { user_steamid: undefined }),
          impact(700, { user_steamid: undefined, user_name: 'same name' }),
        ]),
        sample: true,
      },
      selected,
      first,
      last,
    ).landings.length,
    0,
  );
  assert.equal(
    buildReviewPrompts(
      replay([release(600, { weapon: 'ak47', type: 'weapon_fire' }), impact()]),
      selected,
      first,
      last,
    ).landings.length,
    0,
  );
  assert.equal(
    buildReviewPrompts(
      replay([release(600, { weapon: 'decoy' }), impact(700, { type: 'decoy_firing' })]),
      selected,
      first,
      last,
    ).landings.length,
    0,
  );
});
