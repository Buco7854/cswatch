import type { DemoReader } from 'cs2parser';
import type {
  MatchClock,
  MatchPhase,
  MatchStateData,
  MatchStateSample,
} from '../../shared/match-state.js';
import { objectiveDeadline } from './objectives.js';

const matchStateSampleLimit = 10000;
const maxTick = 64 * 60 * 180;
const validTick = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maxTick;
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const integer = (value: unknown, max = 10000) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
const seconds = (value: unknown) => {
  const result = finite(value);
  return result !== undefined && result >= 0 && result <= 10800 ? result : undefined;
};
const prefix = 'CCSGameRulesProxy.CCSGameRules.';

type ClockMap = (time: unknown) => number | undefined;
/** Only explicit recorded flags establish a phase; a timer reaching zero never does. */
export function matchPhase(properties: Record<string, unknown>): MatchPhase | undefined {
  const get = (key: string) => properties[prefix + key];
  if (get('m_gamePhase') === 5) return 'game-over';
  if (get('m_bWarmupPeriod') === true) return 'warmup';
  if (get('m_gamePhase') === 4) return 'intermission';
  if (get('m_bTechnicalTimeOut') === true) return 'technical';
  if (get('m_bCTTimeOutActive') === true || get('m_bTerroristTimeOutActive') === true)
    return 'timeout';
  if (
    get('m_bGamePaused') === true ||
    get('m_bServerPaused') === true ||
    get('m_bMatchWaitingForResume') === true
  )
    return 'paused';
  if (get('m_bFreezePeriod') === true) return 'freeze';
  const win = integer(get('m_iRoundWinStatus'), 255);
  if (win !== undefined && win > 0) return 'round-end';
  if (
    get('m_bWarmupPeriod') === false &&
    get('m_bFreezePeriod') === false &&
    win === 0 &&
    (get('m_bHasMatchStarted') === true || get('m_gamePhase') === 2 || get('m_gamePhase') === 3)
  )
    return 'live';
}

export function recordedMatchClock(
  properties: Record<string, unknown>,
  phase: MatchPhase | undefined,
  tick: number,
  tickRate: number,
  map: ClockMap,
  pausedAtTick?: number,
): MatchClock | undefined {
  const get = (key: string) => properties[prefix + key];
  if (!phase || phase === 'game-over' || phase === 'intermission' || phase === 'round-end') return;
  let clock: MatchClock;
  if (phase === 'timeout') {
    const ct = get('m_bCTTimeOutActive') === true,
      terrorists = get('m_bTerroristTimeOutActive') === true;
    if (ct === terrorists) return;
    const remaining = seconds(get(ct ? 'm_flCTTimeOutRemaining' : 'm_flTerroristTimeOutRemaining'));
    if (remaining === undefined) return;
    // Timeout remaining is itself a recorded countdown, unlike the paused round clock.
    return { kind: 'timeout', endTick: tick + remaining * tickRate, paused: false };
  }
  if (phase === 'warmup') {
    clock = { kind: 'warmup' };
    const start = map(get('m_fWarmupPeriodStart')),
      end = map(get('m_fWarmupPeriodEnd'));
    if (start !== undefined) clock.startTick = start;
    if (end !== undefined) clock.endTick = end;
  } else {
    const startRaw = finite(get('m_fRoundStartTime'));
    if (startRaw === undefined || startRaw <= 0) return;
    const freeze = get('m_bFreezePeriod') === true;
    clock = { kind: freeze ? 'freeze' : 'round' };
    const length = seconds(get(freeze ? 'm_iFreezeTime' : 'm_iRoundTime'));
    const start = map(freeze && length !== undefined ? startRaw - length : startRaw);
    const end = map(freeze ? startRaw : length !== undefined ? startRaw + length : undefined);
    if (start !== undefined && (!freeze || length !== undefined)) clock.startTick = start;
    if (end !== undefined) clock.endTick = end;
  }
  const paused = phase === 'technical' || phase === 'paused';
  if (paused) {
    clock.paused = true;
    if (pausedAtTick !== undefined) clock.pausedAtTick = pausedAtTick;
    // Without a recorded pause-start clock, freezing at a later unrelated
    // sample would silently invent remaining time.
    else {
      delete clock.startTick;
      delete clock.endTick;
    }
  } else if (get('m_bGamePaused') === false) clock.paused = false;
  return clock.startTick !== undefined || clock.endTick !== undefined || clock.paused
    ? clock
    : undefined;
}

/** Reuses the one streaming ALL entity world already required for bomb state.
 * Raw CCSTeam fields follow actual sides through halftime/overtime; no wins or
 * scheduled half lengths are reconstructed from events or player names. */
export function observeMatchState(reader: DemoReader, tickRate: number, lastTick: number) {
  const samples: MatchStateSample[] = [];
  const teams = new Set<number>(),
    rules = new Set<number>();
  let serverTick: number | undefined,
    serverDemoTick: number | undefined,
    interval: number | undefined,
    previous: string | undefined,
    truncated = false;
  let pausedClock: { key: string; clock: MatchClock } | undefined;
  reader.on('serverinfo', (message) => {
    const value = finite(message.tick_interval);
    if (value !== undefined && value > 0 && value <= 1) interval = value;
  });
  reader.on('net_Tick', (message) => {
    if (integer(message.tick, 0xffffffff) !== undefined && validTick(reader.currentTick)) {
      serverTick = message.tick;
      serverDemoTick = reader.currentTick;
    }
  });
  reader.on('entitycreated', ([id, _classId, _type, className]) => {
    if (className === 'CCSTeam') {
      if (teams.size < 64) teams.add(id);
      else truncated = true;
    }
    if (className === 'CCSGameRulesProxy') {
      pausedClock = undefined;
      if (rules.size < 8) rules.add(id);
      else truncated = true;
    }
  });
  reader.on('entitydeleted', (id) => {
    teams.delete(id);
    if (rules.has(id)) pausedClock = undefined;
    rules.delete(id);
  });
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (!validTick(tick) || tick > lastTick || truncated || (!teams.size && !rules.size)) return;
    const sample: MatchStateSample = { tick };
    for (const [side, key] of [
      [3, 'ctScore'],
      [2, 'tScore'],
    ] as const) {
      const values = [...teams].flatMap((id) => {
        const properties = reader.entities[id]?.properties as Record<string, unknown> | undefined;
        if (!properties || properties['CCSTeam.m_iTeamNum'] !== side) return [];
        const score = integer(properties['CCSTeam.m_iScore']);
        return score === undefined ? [] : [score];
      });
      if (values.length && values.every((value) => value === values[0])) sample[key] = values[0];
    }
    if (rules.size === 1) {
      const properties = reader.entities[[...rules][0]]?.properties as
        Record<string, unknown> | undefined;
      if (properties) {
        const get = (key: string) => properties[prefix + key];
        const map: ClockMap = (time) =>
          objectiveDeadline(time, serverDemoTick ?? tick, serverTick, interval, tickRate);
        for (const [field, property] of [
          ['m_totalRoundsPlayed', 'roundsPlayed'],
          ['m_iRoundStartRoundNumber', 'roundNumber'],
          ['m_nOvertimePlaying', 'overtime'],
          ['m_gamePhase', 'gamePhase'],
        ] as const) {
          const value = integer(get(field), field === 'm_gamePhase' ? 255 : 10000);
          if (value !== undefined && (property !== 'roundNumber' || value > 0))
            sample[property] = value;
        }
        const phase = matchPhase(properties);
        if (phase) sample.phase = phase;
        if (sample.roundNumber !== undefined) sample.roundNumberSource = 'round-start';
        else if (
          phase &&
          phase !== 'warmup' &&
          phase !== 'intermission' &&
          sample.roundsPlayed !== undefined
        ) {
          const winStatus = integer(get('m_iRoundWinStatus'), 255);
          if (winStatus !== undefined && !(phase === 'game-over' && winStatus === 0)) {
            const currentRound = sample.roundsPlayed + (winStatus === 0 ? 1 : 0);
            if (currentRound > 0 && currentRound <= 10000) {
              sample.roundNumber = currentRound;
              sample.roundNumberSource = 'completed-counter';
            }
          }
        }
        const pauseStart = integer(get('m_nPauseStartTick'), 0xffffffff);
        const pauseTick =
          pauseStart !== undefined &&
          pauseStart > 0 &&
          serverTick !== undefined &&
          serverDemoTick !== undefined &&
          interval !== undefined
            ? serverDemoTick + (pauseStart - serverTick) * interval * tickRate
            : undefined;
        const pausedAtTick =
          pauseTick !== undefined && pauseTick >= 0 && pauseTick <= tick ? pauseTick : undefined;
        const clock = recordedMatchClock(properties, phase, tick, tickRate, map, pausedAtTick);
        if (clock?.paused) {
          const key = JSON.stringify([
            clock.kind,
            get('m_fRoundStartTime'),
            get('m_iRoundTime'),
            get('m_iFreezeTime'),
            pauseStart,
          ]);
          // Retain the clock captured at this actual pause origin. Repeated
          // network messages while simulation time is stopped must not move it.
          if (pausedClock?.key !== key) pausedClock = { key, clock };
          sample.clock = { ...pausedClock.clock };
        } else {
          pausedClock = undefined;
          if (clock) sample.clock = clock;
        }
      }
    }
    const { tick: _tick, ...values } = sample;
    const serialized = JSON.stringify(values);
    if (serialized === previous) return;
    if (samples.length >= matchStateSampleLimit) {
      truncated = true;
      return;
    }
    samples.push(sample);
    previous = serialized;
  });
  return (complete: boolean): MatchStateData => ({
    complete: complete && !truncated,
    samples: samples.sort((a, b) => a.tick - b.tick),
  });
}
