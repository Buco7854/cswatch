import type { PlaybackManifest } from '../../shared/playback';
import { frameAt } from './playback';
import type { Playback } from './types';

type OpeningMetadata = Pick<PlaybackManifest, 'firstTick' | 'lastTick' | 'rounds' | 'matchState'>;

export function openingTick(
  { firstTick, lastTick, rounds, matchState }: OpeningMetadata,
  requested?: number,
) {
  const bounded = (tick: number) => Math.max(firstTick, Math.min(lastTick, tick));
  if (requested !== undefined && Number.isSafeInteger(requested)) return bounded(requested);
  let live = Infinity;
  let start = Infinity;
  for (const round of rounds) {
    if (round.tick > lastTick || (round.endTick ?? lastTick) < firstTick) continue;
    start = Math.min(start, round.tick);
    if (round.liveTick !== undefined && round.liveTick <= lastTick)
      live = Math.min(live, round.liveTick);
  }
  if (!Number.isFinite(live)) {
    for (const sample of matchState?.samples ?? []) {
      if (sample.phase === 'live' && sample.tick >= firstTick && sample.tick <= lastTick)
        live = Math.min(live, sample.tick);
    }
  }
  return Number.isFinite(live)
    ? bounded(live)
    : Number.isFinite(start)
      ? bounded(start)
      : firstTick;
}

export function openingPlayer(data: Playback, tick: number, requested?: string) {
  if (requested && data.players.some(({ id }) => id === requested)) return requested;
  const { frame } = frameAt(data, tick);
  const alive = new Set(frame.players.filter(({ alive }) => alive).map(({ id }) => id));
  return data.players.find(({ id }) => alive.has(id))?.id ?? '';
}

/** A live-round marker can arrive before the first living pawn in the slice. */
export function firstPovTick(data: Playback, start: number) {
  if (openingPlayer(data, start)) return start;
  const roster = new Set(data.players.map(({ id }) => id));
  return (
    data.frames.find(
      (frame) => frame.tick > start && frame.players.some((p) => p.alive && roster.has(p.id)),
    )?.tick ?? start
  );
}

export function playerShortcut(index: number) {
  return index >= 0 && index < 10 ? String((index + 1) % 10) : undefined;
}
