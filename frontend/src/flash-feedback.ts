import { frameAt } from './playback';
import type { Playback } from './types';

const maxSearchFrames = 128;
const durationLimit = 5;

export function flashFeedbackAt(
  data: Pick<Playback, 'frames' | 'tickRate'>,
  selected: string,
  tick: number,
): number | undefined {
  if (
    !data.frames.length ||
    !Number.isFinite(data.tickRate) ||
    data.tickRate <= 0 ||
    tick < data.frames[0].tick
  )
    return;
  const { index, frame } = frameAt(data, tick);
  const player = frame.players.find((value) => value.id === selected);
  const duration = player?.alive ? player.flash : undefined;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return;

  // On the Mirage recording this is a constant duration field, not a countdown.
  // Positive runs normally last about 1.4 times the reported number of seconds.
  const strength = Math.min(duration, durationLimit);
  const span = 1.4 * strength * data.tickRate;
  const maxGap = data.tickRate / 2;
  let onset = frame.tick;
  for (let i = index - 1; i >= 0 && index - i <= maxSearchFrames; i--) {
    const earlier = data.frames[i];
    if (onset - earlier.tick > maxGap) break;
    const previous = earlier.players.find((value) => value.id === selected);
    if (!previous || previous.flash === undefined) break;
    if (!previous.alive || previous.flash !== duration) break;
    onset = earlier.tick;
    if (frame.tick - onset > span + maxGap) break;
  }

  let observedEnd: number | undefined;
  let last = frame.tick;
  for (let i = index + 1; i < data.frames.length && i - index <= maxSearchFrames; i++) {
    const later = data.frames[i];
    if (later.tick - last > maxGap || later.tick - frame.tick > span + maxGap) break;
    const next = later.players.find((value) => value.id === selected);
    if (!next || next.flash === undefined) break;
    if (!next.alive || next.flash === 0) {
      observedEnd = later.tick;
      break;
    }
    if (next.flash !== duration) break;
    last = later.tick;
  }

  const peak = Math.min(0.97, 0.38 + strength * 0.65);
  const end = Math.min(onset + span, observedEnd ?? Infinity);
  const release = onset + Math.min(data.tickRate * 0.22, (end - onset) * 0.18);
  const progress = Math.max(0, Math.min(1, (end - tick) / Math.max(1, end - release)));
  return peak * progress * progress * (3 - 2 * progress);
}
