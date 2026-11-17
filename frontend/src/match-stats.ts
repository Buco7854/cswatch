import type { Frame, Playback, Player, Position } from './types';
import type { MatchStateData, MatchStateSample } from '../../shared/match-state';

export type MatchStatValues = {
  kills?: number;
  deaths?: number;
  assists?: number;
  headshots?: number;
  headshotPercent?: number;
  damage?: number;
};
export type MatchStatsIndex = { players: Player[] };
export type MatchStatsRow = {
  player: Player;
  state?: Position;
  /** Only a current recorded frame establishes a historical side. */
  side?: 2 | 3;
  stats: MatchStatValues;
  source: 'recorded-counters' | 'unavailable';
};
export type MatchTimeline = {
  samples: MatchStateSample[];
  tickRate: number;
  complete: boolean;
};
export type MatchView = {
  ctScore?: number;
  tScore?: number;
  roundNumber?: number;
  phase?: MatchStateSample['phase'];
  remaining?: number;
  clockKind?: NonNullable<MatchStateSample['clock']>['kind'];
  paused?: boolean;
  recorded: boolean;
};
export const MATCH_PHASE_LABELS = {
  warmup: 'Warmup',
  freeze: 'Freeze time',
  live: 'Live round',
  timeout: 'Tactical timeout',
  technical: 'Technical timeout',
  paused: 'Paused',
  'round-end': 'Round ended',
  intermission: 'Intermission',
  'game-over': 'Match finished',
} as const;

const boundedInteger = (value: unknown, maximum = 1_000_000): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const tickValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;

function atOrBefore<T extends { tick: number }>(samples: T[], tick: number): T | undefined {
  let lo = 0,
    hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  return samples[lo - 1];
}

/** Global recorded snapshots, independent of streamed frame/chunk boundaries. */
export function buildMatchTimeline(
  data: Pick<Playback, 'tickRate'> & { matchState?: MatchStateData },
): MatchTimeline {
  return {
    samples: (data.matchState?.samples || [])
      .filter((sample) => tickValue(sample.tick))
      .slice()
      .sort((a, b) => a.tick - b.tick),
    tickRate:
      Number.isFinite(data.tickRate) && data.tickRate > 0 && data.tickRate <= 1024
        ? data.tickRate
        : NaN,
    complete: data.matchState?.complete === true,
  };
}

/** Expired clocks stop at zero; they never invent a winner, new phase or next round. */
export function matchAt(timeline: MatchTimeline, tick: number): MatchView {
  if (!timeline.complete && tick > (timeline.samples.at(-1)?.tick ?? -Infinity))
    return { recorded: false };
  const sample = atOrBefore(timeline.samples, tick);
  const result: MatchView = {
    recorded: sample !== undefined,
    roundNumber: boundedInteger(sample?.roundNumber) ? sample.roundNumber : undefined,
  };
  if (!sample) return result;
  if (boundedInteger(sample.ctScore)) result.ctScore = sample.ctScore;
  if (boundedInteger(sample.tScore)) result.tScore = sample.tScore;
  result.phase = sample.phase;
  const clock = sample.clock;
  if (clock) {
    result.clockKind = clock.kind;
    result.paused = clock.paused;
    if (tickValue(clock.endTick)) {
      const reference = clock.paused ? (clock.pausedAtTick ?? sample.tick) : tick;
      const seconds = (clock.endTick - reference) / timeline.tickRate;
      if (Number.isFinite(seconds) && seconds <= 86400) result.remaining = Math.max(0, seconds);
    }
  }
  return result;
}

/** Immutable roster context only. Event queries cover the recorded segment and
 * cannot establish a player's whole-match totals or starting zeroes. */
export function buildMatchStats(data: Pick<Playback, 'players'>): MatchStatsIndex {
  return { players: data.players };
}

/** Each field comes from the current frame's recorded controller counters. No
 * event-derived starting baseline, nickname match or final-side inference is used. */
export function matchStatsAt(index: MatchStatsIndex, tick: number, frame: Frame): MatchStatsRow[] {
  const states = new Map(frame.tick <= tick ? frame.players.map((state) => [state.id, state]) : []);
  return index.players.map((player) => {
    const state = states.get(player.id);
    const counters = state?.stats;
    const stats: MatchStatValues = {};
    for (const key of ['kills', 'deaths', 'assists', 'damage'] as const) {
      const value = counters?.[key];
      if (boundedInteger(value, 1_000_000_000)) stats[key] = value;
    }
    if (boundedInteger(counters?.headshotKills, 1_000_000_000))
      stats.headshots = counters.headshotKills;
    if (
      stats.kills !== undefined &&
      stats.kills > 0 &&
      stats.headshots !== undefined &&
      stats.headshots <= stats.kills
    )
      stats.headshotPercent = (stats.headshots / stats.kills) * 100;
    return {
      player,
      state,
      side: state?.team === 2 || state?.team === 3 ? state.team : undefined,
      stats,
      source: Object.keys(stats).length ? 'recorded-counters' : 'unavailable',
    };
  });
}

export function matchClock(remaining: number | undefined): string | undefined {
  if (remaining === undefined || !Number.isFinite(remaining) || remaining < 0 || remaining > 86400)
    return undefined;
  const seconds = Math.ceil(remaining);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
