import type { Position } from './types';
import { decodeAimChunk, sampleAim, type AimTrack } from '../../shared/aim-track.mjs';
import type { PlaybackChunk, ReplayChunkInfo } from '../../shared/playback';

const recordedAim = new WeakMap<object, { tick: number; track: AimTrack }>();

/** Bind validated angle evidence to canonical frame positions. Trail positions
 * stay spatial-only. The cache owns the positions and their evidence lifetime. */
export function attachAim(
  chunk: PlaybackChunk,
  info: ReplayChunkInfo,
  actors: ReadonlySet<string>,
) {
  if (chunk.aim === undefined) return;
  if (!chunk.frames.some((frame) => frame.tick === info.startTick))
    throw new Error('Invalid recorded aim boundary');
  const aim = decodeAimChunk(chunk.aim, info.startTick, info.endTick, actors);
  for (const { tick, players } of chunk.frames) {
    if (tick < info.startTick) continue;
    for (const player of players) {
      const track = aim.get(player.id);
      if (track && player.alive === true) recordedAim.set(player, { tick, track });
    }
  }
}

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
  const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
  const bound = recordedAim.get(from);
  let aim: ReturnType<typeof sampleAim>;
  if (bound && timing && bound.tick === timing.fromTick && timing.nextTick >= bound.tick) {
    const tick = bound.tick + (timing.nextTick - bound.tick) * blend;
    const nearest = Math.round(tick);
    // Reconstructing an integer source tick from a fractional coarse interval
    // can land a few ULPs to either side of an aim discontinuity.
    aim = sampleAim(bound.track, Math.abs(tick - nearest) < 1e-8 ? nearest : tick);
  }
  if (!continuous || !blend) return aim ? { ...from, ...aim } : from;
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
    yaw: aim?.yaw ?? from.yaw + shortestAngle(from.yaw, next.yaw) * blend,
    ...(eyeOffset ? { eyeOffset } : {}),
    ...(aim
      ? { pitch: aim.pitch }
      : from.pitch !== undefined && next.pitch !== undefined
        ? { pitch: from.pitch + shortestAngle(from.pitch, next.pitch) * blend }
        : {}),
    ...(from.duck !== undefined && next.duck !== undefined
      ? { duck: Math.min(1, Math.max(0, from.duck + (next.duck - from.duck) * blend)) }
      : {}),
  };
}
