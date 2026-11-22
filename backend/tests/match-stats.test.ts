import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMatchStats,
  buildMatchTimeline,
  matchAt,
  matchClock,
  matchStatsAt,
} from '../../frontend/src/match-stats.js';
import type { Frame, Playback, RecordedPlayerStats } from '../../shared/playback.js';

const a = '76561198000000001',
  b = '76561198000000002',
  c = '76561198000000003';
function replay(): Playback {
  return {
    sample: false,
    map: 'de_explicit_stats_fixture',
    tickRate: 64,
    players: [
      { id: a, name: 'Same nickname', team: 3 },
      { id: b, name: 'Same nickname', team: 3 },
      { id: c, name: 'Recorded support', team: 3 },
    ],
    frames: [],
    rounds: [{ number: 13, tick: 0 }],
    // A complete event query covers only the recorded segment. It proves no full-match baseline.
    eventAvailability: { player_death: true, player_hurt: true },
    events: [
      {
        type: 'player_death',
        tick: 100,
        attacker_steamid: a,
        user_steamid: b,
        assister_steamid: c,
        headshot: true,
        attacker_team_num: 3,
        user_team_num: 2,
      },
    ],
  };
}
function frame(tick = 0, stats: RecordedPlayerStats | undefined = undefined): Frame {
  return {
    tick,
    players: [a, b, c].map((id, index) => ({
      id,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      team: index === 1 ? 2 : 3,
      health: 100,
      alive: true,
      weapon: 'ak47',
      ...(id === a ? { money: 0, ...(stats ? { stats } : {}) } : {}),
    })),
  };
}

test('match snapshots preserve recorded halftime/overtime side scores, phases and paused clocks across seeks', () => {
  const data = replay();
  data.matchState = {
    complete: true,
    samples: [
      {
        tick: 0,
        ctScore: 7,
        tScore: 5,
        roundNumber: 13,
        phase: 'live',
        clock: { kind: 'round', endTick: 1280 },
      },
      {
        tick: 640,
        ctScore: 5,
        tScore: 8,
        roundNumber: 14,
        phase: 'freeze',
        clock: { kind: 'freeze', endTick: 768 },
      },
      {
        tick: 768,
        ctScore: 5,
        tScore: 8,
        roundNumber: 14,
        phase: 'live',
        clock: { kind: 'round', endTick: 6400 },
      },
      {
        tick: 1280,
        ctScore: 5,
        tScore: 8,
        roundNumber: 14,
        phase: 'paused',
        clock: { kind: 'round', endTick: 6400, paused: true, pausedAtTick: 1200 },
      },
      { tick: 2560, ctScore: 13, tScore: 15, roundNumber: 31, overtime: 1, phase: 'intermission' },
      { tick: 3000, ctScore: 16, tScore: 15, roundNumber: 34, phase: 'game-over' },
    ],
  };
  const index = buildMatchTimeline(data);
  assert.equal(matchAt(index, 639).ctScore, 7);
  assert.equal(matchAt(index, 640).ctScore, 5);
  assert.equal(matchAt(index, 640).tScore, 8);
  assert.equal(matchAt(index, 640).phase, 'freeze');
  assert.equal(matchAt(index, 640).remaining, 2);
  assert.equal(
    matchAt(index, 1920).remaining,
    81.25,
    'actual pause-start remains the frozen clock origin',
  );
  assert.equal(matchAt(index, 10000).phase, 'game-over');
  assert.equal(matchAt(index, 2700).ctScore, 13);
  assert.equal(matchAt(index, 2700).roundNumber, 31);
  assert.equal(
    matchAt(index, 2700).remaining,
    undefined,
    'complete snapshots clear missing clocks',
  );
  assert.equal(matchAt(index, 0).ctScore, 7);
  assert.equal(matchAt(index, -1).ctScore, undefined);
});

test('missing recorded metadata cannot establish match round numbers or scores and clock expiry cannot invent completion', () => {
  const data = replay();
  const missing = matchAt(buildMatchTimeline(data), 200);
  assert.equal(missing.ctScore, undefined);
  assert.equal(missing.remaining, undefined);
  assert.equal(
    missing.roundNumber,
    undefined,
    'local timeline ordinals are not actual match round counters',
  );
  data.matchState = {
    complete: true,
    samples: [
      { tick: 0, ctScore: 0, tScore: 0, phase: 'live', clock: { kind: 'round', endTick: 64 } },
    ],
  };
  const expired = matchAt(buildMatchTimeline(data), 640);
  assert.equal(expired.remaining, 0);
  assert.equal(expired.phase, 'live');
  assert.equal(expired.ctScore, 0);
  assert.equal(matchClock(expired.remaining), '0:00');
  assert.equal(matchClock(61.1), '1:02');
  assert.equal(matchClock(undefined), undefined);
  assert.equal(matchClock(Infinity), undefined);
  assert.equal(matchClock(-1), undefined);
});

test('failed or capped metadata collectors cannot carry scores and phases beyond their known coverage', () => {
  const data = replay();
  data.matchState = {
    complete: false,
    samples: [
      { tick: 0, ctScore: 2, tScore: 8, phase: 'freeze' },
      {
        tick: 640,
        ctScore: 3,
        tScore: 8,
        phase: 'live',
        roundNumber: 12,
        clock: { kind: 'round', endTick: 1280 },
      },
    ],
  };
  const index = buildMatchTimeline(data);
  assert.equal(matchAt(index, 639).ctScore, 2);
  assert.equal(matchAt(index, 640).ctScore, 3);
  assert.equal(matchAt(index, 640).remaining, 10);
  assert.deepEqual(matchAt(index, 640.01), { recorded: false });
  assert.deepEqual(matchAt(index, 1280), { recorded: false });
  assert.equal(
    matchAt(index, 0).ctScore,
    2,
    'rewinding back into known coverage restores recorded state',
  );
  data.matchState = { complete: false, samples: [] };
  assert.deepEqual(matchAt(buildMatchTimeline(data), 0), { recorded: false });
});

test('native controller totals preserve preexisting kills, deaths and assists at a recording starting mid-match', () => {
  const data = replay();
  const index = buildMatchStats(data);
  const initial = frame(0, { kills: 8, deaths: 3, assists: 2, headshotKills: 4 });
  const first = matchStatsAt(index, 0, initial)[0];
  assert.deepEqual(first.stats, {
    kills: 8,
    deaths: 3,
    assists: 2,
    headshots: 4,
    headshotPercent: 50,
  });
  assert.equal(first.source, 'recorded-counters');
  assert.equal(
    first.stats.damage,
    undefined,
    'a missing native damage counter is not a fabricated segment sum',
  );
  assert.equal(
    matchStatsAt(index, 110, initial)[0].stats.kills,
    8,
    'an event does not replace the actual controller baseline',
  );
  const later = frame(128, { kills: 9, deaths: 3, assists: 2, headshotKills: 5, damage: 850 });
  assert.equal(matchStatsAt(index, 128, later)[0].stats.kills, 9);
  assert.equal(matchStatsAt(index, 128, later)[0].stats.damage, 850);
  assert.equal(
    matchStatsAt(index, 0, initial)[0].stats.kills,
    8,
    'a backward seek restores its recorded frame counters',
  );
});

test('complete event categories and attributed kills never silently become whole-match statistics', () => {
  const data = replay();
  const rows = matchStatsAt(buildMatchStats(data), 200, frame());
  assert.deepEqual(rows[0].stats, {});
  assert.deepEqual(rows[1].stats, {});
  assert.equal(rows[0].source, 'unavailable');
  assert.equal(
    rows[0].state?.money,
    0,
    'current recorded zero money remains available independently',
  );
  delete data.eventAvailability;
  assert.deepEqual(matchStatsAt(buildMatchStats(data), 200, frame())[0].stats, {});
});

test('native partial fields and actual zeroes remain distinct and HS percentage needs a valid denominator', () => {
  const index = buildMatchStats(replay());
  const zeroes = matchStatsAt(
    index,
    0,
    frame(0, { kills: 0, deaths: 0, assists: 0, headshotKills: 0, damage: 0 }),
  )[0].stats;
  assert.deepEqual(zeroes, { kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0 });
  assert.equal(zeroes.headshotPercent, undefined);
  const bodyshot = matchStatsAt(index, 0, frame(0, { kills: 1, headshotKills: 0 }))[0].stats;
  assert.equal(bodyshot.headshotPercent, 0);
  assert.equal(bodyshot.deaths, undefined);
  assert.equal(bodyshot.assists, undefined);
  const inconsistent = matchStatsAt(index, 0, frame(0, { kills: 1, headshotKills: 2 }))[0].stats;
  assert.equal(
    inconsistent.headshotPercent,
    undefined,
    'inconsistent snapshots do not yield a percentage over100',
  );
  assert.equal(
    matchStatsAt(index, 0, frame(0, { headshotKills: 1 }))[0].stats.headshotPercent,
    undefined,
  );
});

test('counter identity, historical sides and money use only the current immutable-ID frame', () => {
  const data = replay();
  const current = frame(640, { kills: 8 });
  current.players[0].team = 2;
  current.players[1].team = 3;
  current.players[1].stats = { kills: 2 };
  const index = buildMatchStats(data);
  const rows = matchStatsAt(index, 700, current);
  assert.equal(rows[0].stats.kills, 8);
  assert.equal(rows[1].stats.kills, 2, 'the same nickname never merges native counters');
  assert.equal(rows[0].side, 2, 'final Player.team does not establish a historical side');
  assert.equal(rows[0].state?.money, 0);
  const future = matchStatsAt(index, 600, current)[0];
  assert.equal(future.state, undefined);
  assert.equal(future.side, undefined);
  assert.deepEqual(future.stats, {});
  assert.equal(future.source, 'unavailable');
  current.players[0].id = '76561198000999999';
  assert.deepEqual(
    matchStatsAt(index, 700, current)[0].stats,
    {},
    'a name does not recover an absent immutable ID',
  );
});

test('malformed native fields never coerce into valid counts and synthetic declared zero remains a string ID', () => {
  const data = replay();
  const invalid = frame(0, {
    kills: '8',
    deaths: -1,
    assists: NaN,
    damage: Infinity,
    headshotKills: 1.5,
  } as unknown as RecordedPlayerStats);
  assert.deepEqual(matchStatsAt(buildMatchStats(data), 0, invalid)[0].stats, {});
  data.sample = true;
  data.players[0] = { ...data.players[0], id: '0' };
  const synthetic = frame(0, { kills: 1, assists: 1, headshotKills: 1 });
  synthetic.players[0].id = '0';
  const result = matchStatsAt(buildMatchStats(data), 0, synthetic)[0];
  assert.equal(result.player.id, '0');
  assert.equal(result.stats.kills, 1);
  assert.equal(result.stats.assists, 1);
  assert.equal(result.stats.headshotPercent, 100);
});
