import type { Playback } from './types';
import { eventPlayer, roundAt } from './review-events';
import { buildReviewPrompts, type ThrowPrompt } from './review-prompts';
import type { ThrowInputSnapshot } from '../../shared/throw-input';

export type CombatMoment = {
  kind: 'combat';
  id: string;
  tick: number;
  startTick: number;
  endTick: number;
  attackerId?: string;
  victimId?: string;
  attackerTeam?: 2 | 3;
  victimTeam?: 2 | 3;
  attacker: string;
  victim: string;
  weapon?: string;
  headshot: boolean;
};
type ReviewMomentIndex = {
  kills: CombatMoment[];
  utilities: ThrowPrompt[];
  byPlayer: Map<string, { kills: CombatMoment[]; utilities: ThrowPrompt[] }>;
  first: number;
  last: number;
  windowTicks: number;
};
const order = (a: { tick: number; id: string }, b: { tick: number; id: string }) =>
  a.tick - b.tick || a.id.localeCompare(b.id);

/** Global, recorded review navigation; never depends on the loaded frame slice. */
export function buildReviewMoments(data: Playback, first: number, last: number): ReviewMomentIndex {
  const result: ReviewMomentIndex = {
    kills: [],
    utilities: [],
    byPlayer: new Map(),
    first,
    last,
    windowTicks: 6 * data.tickRate,
  };
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    first < 0 ||
    last < first ||
    !Number.isFinite(data.tickRate) ||
    data.tickRate <= 0 ||
    data.tickRate > 1024
  )
    return result;
  for (const [eventIndex, event] of data.events.entries()) {
    if (
      event.type !== 'player_death' ||
      !Number.isSafeInteger(event.tick) ||
      event.tick < first ||
      event.tick > last
    )
      continue;
    const attacker = eventPlayer(data, event, 'attacker');
    const victim = eventPlayer(data, event, 'user');
    if (!attacker && !victim) continue;
    const round = roundAt(data, event.tick, last);
    result.kills.push({
      kind: 'combat',
      id: `combat:${event.tick}:${eventIndex}`,
      tick: event.tick,
      startTick: Math.max(first, round.start, Math.floor(event.tick - 3 * data.tickRate)),
      endTick: Math.min(last, round.end, Math.ceil(event.tick + 2 * data.tickRate)),
      attackerId: attacker?.id,
      victimId: victim?.id,
      attacker:
        typeof event.attacker_name === 'string' ? event.attacker_name : attacker?.name || '',
      victim: typeof event.user_name === 'string' ? event.user_name : victim?.name || '',
      attackerTeam:
        event.attacker_team_num === 2 || event.attacker_team_num === 3
          ? event.attacker_team_num
          : undefined,
      victimTeam:
        event.user_team_num === 2 || event.user_team_num === 3 ? event.user_team_num : undefined,
      weapon: typeof event.weapon === 'string' ? event.weapon : undefined,
      headshot: event.headshot === true,
    });
  }
  // Reuse the sole conservative throw/detonation association implementation.
  // Its per-player grouping preserves ambiguous/missing endpoints as unavailable.
  for (const player of data.players)
    result.utilities.push(...buildReviewPrompts(data, player.id, first, last).throws);
  result.kills.sort(order);
  result.utilities.sort(order);
  for (const player of data.players) result.byPlayer.set(player.id, { kills: [], utilities: [] });
  for (const moment of result.kills) {
    if (moment.attackerId) result.byPlayer.get(moment.attackerId)?.kills.push(moment);
    if (moment.victimId && moment.victimId !== moment.attackerId)
      result.byPlayer.get(moment.victimId)?.kills.push(moment);
  }
  for (const moment of result.utilities)
    result.byPlayer.get(moment.throwerId)?.utilities.push(moment);
  return result;
}

/** Lead into the selected event without crossing the recording or round boundary. */
export function replayLeadInTick(
  data: Playback,
  eventTick: number,
  seconds: number,
  first: number,
  last: number,
) {
  return Math.max(
    first,
    roundAt(data, eventTick, last).start,
    Math.floor(eventTick - seconds * data.tickRate),
  );
}

function latest<T extends { tick: number }>(
  items: T[],
  tick: number,
  matches: (item: T) => boolean,
  window: number,
) {
  let lo = 0,
    hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0 && tick < items[i].tick + window; i--)
    if (matches(items[i])) return items[i];
  return null;
}

/** One recent card wins by recorded time; other moments remain in the review list. */
export function recentReviewMoment(
  index: ReviewMomentIndex,
  tick: number,
  selected: string,
  enabled: { kills: boolean; utilities: boolean },
) {
  if (!Number.isFinite(tick) || tick < index.first || tick > index.last) return null;
  const player = index.byPlayer.get(selected);
  if (!player) return null;
  const combat = enabled.kills
    ? latest(
        player.kills,
        tick,
        (moment) => moment.attackerId === selected || moment.victimId === selected,
        index.windowTicks,
      )
    : null;
  const utility = enabled.utilities
    ? latest(player.utilities, tick, (moment) => moment.throwerId === selected, index.windowTicks)
    : null;
  return utility && (!combat || utility.tick > combat.tick) ? utility : combat;
}

/** Exact event/actor binding prevents nearby throws or duplicate names sharing input evidence. */
export function indexThrowInputs(data: Playback) {
  return new Map((data.throwInputs || []).map((snapshot) => [snapshot.eventIndex, snapshot]));
}
export function throwInputAt(index: Map<number, ThrowInputSnapshot>, moment: ThrowPrompt) {
  const snapshot = index.get(moment.eventIndex);
  return snapshot?.tick === moment.tick && snapshot.actorId === moment.throwerId
    ? snapshot
    : undefined;
}
