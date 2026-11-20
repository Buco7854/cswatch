import type { Position } from './types';
export type PoseTiming = {
  fromTick: number;
  nextTick: number;
  tickRate: number;
  roundBoundary?: boolean;
};
export function shortestAngle(from: number, to: number) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}
/** Interpolate continuous recorded transforms only; categorical/input/economy fields stay at their sample. */
export function playerPose<
  T extends Pick<Position, 'id' | 'x' | 'y' | 'z' | 'yaw' | 'alive'> & {
    pitch?: number;
    duck?: number;
    eyeOffset?: Position['eyeOffset'];
  },
>(from: T, next: T | undefined, alpha: number, timing?: PoseTiming): T {
  const seconds = timing ? (timing.nextTick - timing.fromTick) / timing.tickRate : undefined;
  const continuous =
    next?.id === from.id &&
    next.alive === from.alive &&
    !timing?.roundBoundary &&
    (seconds === undefined || (Number.isFinite(seconds) && seconds > 0 && seconds <= 0.25)) &&
    Math.hypot(next.x - from.x, next.y - from.y, next.z - from.z) <=
      (seconds === undefined ? 512 : Math.max(128, 4096 * seconds));
  if (!continuous) return from;
  const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
  if (!blend) return from;
  let eyeOffset = from.eyeOffset;
  if (from.eyeOffset && next.eyeOffset) {
    const a = from.eyeOffset,
      b = next.eyeOffset;
    const height = a[a.length - 1] * (1 - blend) + b[b.length - 1] * blend;
    eyeOffset =
      a.length === 1 && b.length === 1
        ? [height]
        : [
            (a.length === 3 ? a[0] : 0) * (1 - blend) + (b.length === 3 ? b[0] : 0) * blend,
            (a.length === 3 ? a[1] : 0) * (1 - blend) + (b.length === 3 ? b[1] : 0) * blend,
            height,
          ];
  }
  return {
    ...from,
    x: from.x + (next.x - from.x) * blend,
    y: from.y + (next.y - from.y) * blend,
    z: from.z + (next.z - from.z) * blend,
    yaw: from.yaw + shortestAngle(from.yaw, next.yaw) * blend,
    ...(eyeOffset ? { eyeOffset } : {}),
    ...(from.pitch !== undefined && next.pitch !== undefined
      ? { pitch: from.pitch + shortestAngle(from.pitch, next.pitch) * blend }
      : {}),
    ...(from.duck !== undefined && next.duck !== undefined
      ? { duck: Math.min(1, Math.max(0, from.duck + (next.duck - from.duck) * blend)) }
      : {}),
  };
}
