import { shortestAngle, type PoseTiming } from './player-pose';
import type { Frame, Playback, Position } from './types';
import { strideCentimeters, strideDisplacement } from '../../shared/stride-distance.mjs';

export type PreviousPose = { position?: Position; tick: number };
const zero = { speed: 0, rise: 0, yaw: 0, pitch: 0, velocityX: 0, velocityY: 0 };
const blend = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (value: number, limit: number) =>
  Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : 0;

function velocity(from: Position | undefined, to: Position | undefined, seconds: number) {
  if (!from || !to) return;
  const delta = strideDisplacement(from, to, seconds);
  if (!delta) return;
  return {
    speed: (delta.horizontal * 0.0254) / seconds,
    velocityX: ((to.x - from.x) * 0.0254) / seconds,
    velocityY: ((to.y - from.y) * 0.0254) / seconds,
    rise: clamp((delta.vertical * 0.0254) / seconds, 12),
    yaw: clamp(shortestAngle(from.yaw, to.yaw) / seconds, 520),
    pitch: clamp(shortestAngle(from.pitch, to.pitch) / seconds, 380),
  };
}

/** Each loaded slice carries exact travel at its first primary frame. Trails
 * provide the look-back velocity but never invent an earlier distance. */
export function indexRecordedTravel(
  frames: readonly Frame[],
  anchor: Playback['strideAnchor'],
  rounds: Playback['rounds'],
  rate: number,
) {
  if (!anchor) return;
  const start = frames.findIndex((frame) => frame.tick === anchor.tick);
  if (start < 0) return;
  const travel = new Map(
    anchor.players.map(([id, centimeters]) => {
      const series = new Uint32Array(frames.length - start);
      series[0] = centimeters;
      return [id, series];
    }),
  );
  const offsets = new Map<Frame, number>([[frames[start], 0]]);
  for (let index = start + 1; index < frames.length; index++) {
    const from = frames[index - 1],
      to = frames[index];
    const offset = index - start;
    offsets.set(to, offset);
    for (const series of travel.values()) series[offset] = series[offset - 1];
    if (!rounds.some((round) => round.tick > from.tick && round.tick <= to.tick)) {
      const positions = new Map(from.players.map((position) => [position.id, position]));
      const elapsed = (to.tick - from.tick) / rate;
      for (const position of to.players) {
        const series = travel.get(position.id);
        if (series)
          series[offset] += strideCentimeters(positions.get(position.id), position, elapsed);
      }
    }
  }
  return (from: Frame, to: Frame, id: string, alpha: number) => {
    const series = travel.get(id),
      a = offsets.get(from),
      b = offsets.get(to);
    return series && a !== undefined && b !== undefined
      ? blend(series[a], series[b], alpha) / 100
      : undefined;
  };
}

/** Blend measured interval velocities. The previous interval is also present
 * in the ordinary chunk overlap, so playback and arbitrary seeks agree. */
export function recordedMotion(
  from: Position,
  to: Position | undefined,
  alpha: number,
  timing: PoseTiming | undefined,
  previous?: PreviousPose,
) {
  if (!timing || timing.roundBoundary || !Number.isFinite(alpha)) return zero;
  const { fromTick, nextTick, tickRate } = timing;
  const current = velocity(from, to, (nextTick - fromTick) / tickRate);
  if (!current) return zero;
  if (!previous) return current;
  const before = velocity(previous.position, from, (fromTick - previous.tick) / tickRate) ?? zero;
  const t = Math.max(0, Math.min(1, alpha));
  const weight = t * t * (3 - 2 * t);
  return {
    speed: blend(before.speed, current.speed, weight),
    velocityX: blend(before.velocityX, current.velocityX, weight),
    velocityY: blend(before.velocityY, current.velocityY, weight),
    rise: blend(before.rise, current.rise, weight),
    yaw: blend(before.yaw, current.yaw, weight),
    pitch: blend(before.pitch, current.pitch, weight),
  };
}
