import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DemoReader } from 'cs2parser';
import { matchPhase, observeMatchState, recordedMatchClock } from '../src/match-state.js';

const prefix = 'CCSGameRulesProxy.CCSGameRules.';
const properties = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [prefix + key, value]));
class Reader extends EventEmitter {
  currentTick = 100;
  currentTime = 100 / 64;
  entities: { properties: Record<string, unknown> }[] = [];
}

test('global match snapshots preserve actual side scores through swaps and overtime, without event winner or half-length guesses', () => {
  const reader = new Reader();
  const finish = observeMatchState(reader as unknown as DemoReader, 64, 10000);
  reader.entities[1] = { properties: { 'CCSTeam.m_iTeamNum': 3, 'CCSTeam.m_iScore': 7 } };
  reader.entities[2] = { properties: { 'CCSTeam.m_iTeamNum': 2, 'CCSTeam.m_iScore': 5 } };
  reader.entities[3] = {
    properties: properties({
      m_bWarmupPeriod: false,
      m_bFreezePeriod: false,
      m_iRoundWinStatus: 0,
      m_bHasMatchStarted: true,
      m_gamePhase: 2,
      m_totalRoundsPlayed: 12,
      m_nOvertimePlaying: 0,
    }),
  };
  for (const [id, name] of [
    [1, 'CCSTeam'],
    [2, 'CCSTeam'],
    [3, 'CCSGameRulesProxy'],
  ] as const)
    reader.emit('entitycreated', [id, 1, 0, name]);
  reader.emit('tickend');
  for (let tick = 101; tick < 150; tick++) {
    reader.currentTick = tick;
    reader.emit('tickend');
  }
  assert.equal(
    finish(true).samples.length,
    1,
    'unchanged network state is not copied at every tick',
  );
  assert.equal(finish(true).samples[0].roundNumber, 13);
  assert.equal(finish(true).samples[0].roundNumberSource, 'completed-counter');
  reader.currentTick = 150;
  reader.entities[1].properties['CCSTeam.m_iTeamNum'] = 2;
  reader.entities[2].properties['CCSTeam.m_iTeamNum'] = 3;
  Object.assign(
    reader.entities[3].properties,
    properties({ m_gamePhase: 4, m_nOvertimePlaying: 1 }),
  );
  reader.emit('tickend');
  const swapped = finish(true).samples.at(-1)!;
  assert.equal(swapped.ctScore, 5);
  assert.equal(swapped.tScore, 7);
  assert.equal(swapped.overtime, 1);
  assert.equal(swapped.phase, 'intermission');
  reader.currentTick = 200;
  reader.entities[2].properties['CCSTeam.m_iScore'] = 8;
  Object.assign(
    reader.entities[3].properties,
    properties({ m_gamePhase: 3, m_iRoundStartRoundNumber: 17, m_totalRoundsPlayed: 16 }),
  );
  reader.emit('tickend');
  assert.equal(finish(true).samples.at(-1)!.ctScore, 8);
  assert.equal(finish(true).samples.at(-1)!.roundNumber, 17);
  assert.equal(finish(true).samples.at(-1)!.roundNumberSource, 'round-start');
  reader.emit('entitydeleted', 2);
  reader.currentTick = 201;
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.at(-1)!.ctScore,
    undefined,
    'deleted side state does not leak a stale score',
  );
  assert.equal(finish(false).complete, false);
});

test('recorded clocks use server/demo mapping, hold the recorded pause origin and retain custom round/timeout durations', () => {
  const reader = new Reader();
  const finish = observeMatchState(reader as unknown as DemoReader, 64, 10000);
  reader.entities[3] = {
    properties: properties({
      m_bWarmupPeriod: false,
      m_bFreezePeriod: true,
      m_iRoundWinStatus: 0,
      m_gamePhase: 2,
      m_iRoundTime: 120,
      m_iFreezeTime: 10,
      m_fRoundStartTime: 20,
      m_bGamePaused: false,
    }),
  };
  reader.emit('entitycreated', [3, 1, 0, 'CCSGameRulesProxy']);
  reader.emit('serverinfo', { tick_interval: 1 / 64 });
  reader.emit('net_Tick', { tick: 1024 });
  reader.emit('tickend');
  const freeze = finish(true).samples[0];
  assert.equal(freeze.phase, 'freeze');
  assert.equal(freeze.clock?.endTick, 356);
  reader.currentTick = 356;
  reader.emit('net_Tick', { tick: 1280 });
  reader.entities[3].properties[prefix + 'm_bFreezePeriod'] = false;
  reader.emit('tickend');
  const live = finish(true).samples.at(-1)!;
  assert.equal(live.phase, 'live');
  assert.equal(live.clock?.startTick, 356);
  assert.equal(live.clock?.endTick, 8036);
  reader.currentTick = 500;
  reader.emit('net_Tick', { tick: 1424 });
  Object.assign(
    reader.entities[3].properties,
    properties({ m_bGamePaused: true, m_nPauseStartTick: 1424 }),
  );
  reader.emit('tickend');
  const pause = finish(true).samples.at(-1)!;
  assert.equal(pause.phase, 'paused');
  assert.equal(pause.clock?.pausedAtTick, 500);
  assert.equal(pause.clock?.endTick, 8036);
  // Demo recording progresses while the recorded simulation clock is stopped.
  reader.currentTick = 510;
  reader.emit('net_Tick', { tick: 1424 });
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.at(-1)!.tick,
    500,
    'stopped simulation messages do not move the captured pause clock',
  );
  reader.currentTick = 520;
  reader.emit('net_Tick', { tick: 1434 });
  reader.entities[3].properties[prefix + 'm_bGamePaused'] = false;
  reader.emit('tickend');
  const resumed = finish(true).samples.at(-1)!;
  assert.equal(resumed.phase, 'live');
  assert.equal(resumed.clock?.endTick, 8046);
  reader.currentTick = 600;
  reader.emit('net_Tick', { tick: 1514 });
  Object.assign(
    reader.entities[3].properties,
    properties({ m_bCTTimeOutActive: true, m_flCTTimeOutRemaining: 30 }),
  );
  reader.emit('tickend');
  const timeout = finish(true).samples.at(-1)!;
  assert.equal(timeout.phase, 'timeout');
  assert.equal(timeout.clock?.kind, 'timeout');
  assert.equal(timeout.clock?.endTick, 2520);
  reader.currentTick = 616;
  reader.entities[3].properties[prefix + 'm_flCTTimeOutRemaining'] = 29.75;
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.at(-1)!.tick,
    600,
    'a running countdown becomes one deadline, not per-tick copies',
  );
});

test('missing and contradictory recorded state stays unknown instead of default scores, phases or countdowns', () => {
  assert.equal(matchPhase({}), undefined);
  assert.equal(matchPhase(properties({ m_bWarmupPeriod: true, m_gamePhase: 2 })), 'warmup');
  assert.equal(matchPhase(properties({ m_gamePhase: 5, m_bFreezePeriod: true })), 'game-over');
  assert.equal(
    recordedMatchClock(
      properties({ m_fRoundStartTime: 20, m_iRoundTime: 120 }),
      'live',
      100,
      64,
      () => undefined,
    ),
    undefined,
  );
  assert.deepEqual(
    recordedMatchClock(
      properties({ m_fRoundStartTime: 20, m_iRoundTime: 120 }),
      'paused',
      100,
      64,
      (value) => (typeof value === 'number' ? value * 64 : undefined),
    ),
    { kind: 'round', paused: true },
  );
  assert.equal(
    recordedMatchClock(
      properties({
        m_bCTTimeOutActive: true,
        m_bTerroristTimeOutActive: true,
        m_flCTTimeOutRemaining: 30,
      }),
      'timeout',
      100,
      64,
      () => undefined,
    ),
    undefined,
  );
  const reader = new Reader(),
    finish = observeMatchState(reader as unknown as DemoReader, 64, 200);
  reader.entities[1] = { properties: { 'CCSTeam.m_iTeamNum': 3 } };
  reader.emit('entitycreated', [1, 1, 0, 'CCSTeam']);
  reader.emit('tickend');
  assert.deepEqual(finish(true).samples, [{ tick: 100 }]);
  reader.currentTick = 201;
  reader.entities[1].properties['CCSTeam.m_iScore'] = 99;
  reader.emit('tickend');
  assert.equal(finish(true).samples.length, 1, 'state past the replay bound is never published');
});

test('completed-round fallback is gated by actual win status and phase, including end frames and overtime', () => {
  const reader = new Reader(),
    finish = observeMatchState(reader as unknown as DemoReader, 64, 1000);
  reader.entities[3] = {
    properties: properties({
      m_gamePhase: 2,
      m_bWarmupPeriod: false,
      m_bFreezePeriod: true,
      m_totalRoundsPlayed: 0,
      m_iRoundWinStatus: 0,
    }),
  };
  reader.emit('entitycreated', [3, 1, 0, 'CCSGameRulesProxy']);
  reader.emit('tickend');
  assert.equal(finish(true).samples.at(-1)!.roundNumber, 1);
  reader.currentTick = 200;
  Object.assign(
    reader.entities[3].properties,
    properties({ m_bFreezePeriod: false, m_totalRoundsPlayed: 1, m_iRoundWinStatus: 2 }),
  );
  reader.emit('tickend');
  assert.equal(finish(true).samples.at(-1)!.phase, 'round-end');
  assert.equal(
    finish(true).samples.at(-1)!.roundNumber,
    1,
    'round-end does not jump ahead when the completed counter increments',
  );
  reader.currentTick = 300;
  Object.assign(
    reader.entities[3].properties,
    properties({ m_bFreezePeriod: true, m_iRoundWinStatus: 0 }),
  );
  reader.emit('tickend');
  assert.equal(finish(true).samples.at(-1)!.roundNumber, 2);
  reader.currentTick = 400;
  Object.assign(
    reader.entities[3].properties,
    properties({ m_bWarmupPeriod: true, m_totalRoundsPlayed: 20 }),
  );
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.at(-1)!.roundNumber,
    undefined,
    'warmup does not become a match round',
  );
  reader.currentTick = 500;
  Object.assign(
    reader.entities[3].properties,
    properties({
      m_bWarmupPeriod: false,
      m_gamePhase: 3,
      m_nOvertimePlaying: 3,
      m_totalRoundsPlayed: 39,
    }),
  );
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.at(-1)!.roundNumber,
    40,
    'overtime follows the recorded counter rather than a fixed half length',
  );
  reader.currentTick = 600;
  delete reader.entities[3].properties[prefix + 'm_iRoundWinStatus'];
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.at(-1)!.roundNumber,
    undefined,
    'a completed counter alone cannot decide the current round',
  );
});

test('recorded match metadata stops at its output bound and declares partial coverage', () => {
  const reader = new Reader(),
    finish = observeMatchState(reader as unknown as DemoReader, 64, 20000);
  reader.entities[1] = { properties: { 'CCSTeam.m_iTeamNum': 3, 'CCSTeam.m_iScore': 0 } };
  reader.emit('entitycreated', [1, 1, 0, 'CCSTeam']);
  for (let index = 0; index <= 10000; index++) {
    reader.currentTick = index;
    reader.entities[1].properties['CCSTeam.m_iScore'] = index % 2;
    reader.emit('tickend');
  }
  assert.equal(finish(true).samples.length, 10000);
  assert.equal(finish(true).complete, false);
});
