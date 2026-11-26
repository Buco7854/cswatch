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

type PosePoint = Pick<Position, 'id' | 'x' | 'y' | 'z' | 'alive'>;
/** A recorded sample beside the interpolated interval. */
export type PoseNeighbor = { tick: number; pose: CurvePoint };
export type PoseTiming = {
  fromTick: number;
  nextTick: number;
  tickRate: number;
  roundBoundary?: boolean;
  /** Continuous samples before `fromTick` and after `nextTick` make the position path C1. */
  before?: PoseNeighbor;
  after?: PoseNeighbor;
};
/** Recorded movement continues across the interval: same live actor, no round
 * boundary, a sampled gap of at most 250 ms and no teleport. */
function continuousStep(
  from: PosePoint,
  next: PosePoint | undefined,
  seconds: number | undefined,
  roundBoundary?: boolean,
): next is PosePoint {
  return (
    next?.id === from.id &&
    next.alive === from.alive &&
    !roundBoundary &&
    (seconds === undefined || (Number.isFinite(seconds) && seconds > 0 && seconds <= 0.25)) &&
    Math.hypot(next.x - from.x, next.y - from.y, next.z - from.z) <=
      (seconds === undefined ? 512 : Math.max(128, 4096 * seconds))
  );
}
/** One-sided slope at a recorded sample (Fritsch-Butland weighted harmonic mean).
 * It is zero at a local extremum, so the curve never overshoots either sample. */
function sampleSlope(previous: number, current: number, h0: number, h1: number) {
  if (previous === 0 || current === 0 || previous > 0 !== current > 0) return 0;
  const w0 = 2 * h1 + h0,
    w1 = h1 + 2 * h0;
  return (w0 + w1) / (w0 / previous + w1 / current);
}
/** Monotone cubic Hermite position between two recorded samples. Missing or
 * discontinuous neighbours use the interval's own slope at that end, so an
 * isolated interval stays linear and respawns or teleports never bend the path. */
function curvedAxis(
  a: number,
  b: number,
  span: number,
  s: number,
  before?: { value: number; span: number },
  after?: { value: number; span: number },
) {
  const slope = (b - a) / span;
  const m0 = before
    ? sampleSlope((a - before.value) / before.span, slope, before.span, span)
    : slope;
  const m1 = after ? sampleSlope(slope, (after.value - b) / after.span, span, after.span) : slope;
  const s2 = s * s,
    s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * a +
    (s3 - 2 * s2 + s) * span * m0 +
    (3 * s2 - 2 * s3) * b +
    (s3 - s2) * span * m1
  );
}
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
  const continuous = continuousStep(from, next, seconds, timing?.roundBoundary);
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
  const curve = poseCurve(from, next!, blend, timing);
  const position = {
    x: curve((pose) => pose.x),
    y: curve((pose) => pose.y),
    z: curve((pose) => pose.z),
  };
  let eyeOffset = from.eyeOffset;
  if (from.eyeOffset && next.eyeOffset) {
    // Curve the absolute eye point so origin and view-offset changes that cancel
    // (a crouch jump) stay smooth together, then store it as the offset again.
    const offset = (pose: CurvePoint, index: number) =>
      pose.eyeOffset && (pose.eyeOffset.length === 3 ? pose.eyeOffset[index] : 0);
    const height = curve((pose) => pose.eyeOffset && pose.z + pose.eyeOffset.at(-1)!) - position.z;
    eyeOffset =
      from.eyeOffset.length === 1 && next.eyeOffset.length === 1
        ? [height]
        : [
            curve((pose) => pose.eyeOffset && pose.x + offset(pose, 0)!) - position.x,
            curve((pose) => pose.eyeOffset && pose.y + offset(pose, 1)!) - position.y,
            height,
          ];
  }
  return {
    ...from,
    ...position,
    yaw: aim?.yaw ?? from.yaw + shortestAngle(from.yaw, next.yaw) * blend,
    ...(eyeOffset ? { eyeOffset } : {}),
    ...(aim
      ? { pitch: aim.pitch }
      : from.pitch !== undefined && next.pitch !== undefined
        ? { pitch: from.pitch + shortestAngle(from.pitch, next.pitch) * blend }
        : {}),
    ...(from.duck !== undefined && next.duck !== undefined
      ? {
          duck: Math.min(
            1,
            Math.max(
              0,
              curve((pose) => pose.duck),
            ),
          ),
        }
      : {}),
  };
}
type CurvePoint = PosePoint & { duck?: number; eyeOffset?: Position['eyeOffset'] };
/** Monotone cubic interpolation of any recorded scalar between two continuous
 * samples. A neighbour contributes only when recorded movement continues to it
 * and it carries the value; otherwise that end uses the interval's own slope. */
function poseCurve(from: CurvePoint, next: CurvePoint, blend: number, timing?: PoseTiming) {
  const before = timing?.before,
    after = timing?.after;
  const span = timing ? (timing.nextTick - timing.fromTick) / timing.tickRate : 0;
  const beforeSpan = before && timing && (timing.fromTick - before.tick) / timing.tickRate;
  const afterSpan = after && timing && (after.tick - timing.nextTick) / timing.tickRate;
  const useBefore =
    beforeSpan !== undefined && continuousStep(before!.pose, from, beforeSpan)
      ? beforeSpan
      : undefined;
  const useAfter =
    afterSpan !== undefined && continuousStep(next, after!.pose, afterSpan) ? afterSpan : undefined;
  return (value: (pose: CurvePoint) => number | undefined) => {
    const a = value(from)!,
      b = value(next)!;
    if (!(span > 0)) return a + (b - a) * blend;
    const previous = useBefore === undefined ? undefined : value(before!.pose);
    const following = useAfter === undefined ? undefined : value(after!.pose);
    return curvedAxis(
      a,
      b,
      span,
      blend,
      previous === undefined ? undefined : { value: previous, span: useBefore! },
      following === undefined ? undefined : { value: following, span: useAfter! },
    );
  };
}
/** Position at `blend` between two continuous recorded samples. */
export function curvedPosition(
  from: PosePoint,
  next: PosePoint,
  blend: number,
  timing?: PoseTiming,
): { x: number; y: number; z: number } {
  const curve = poseCurve(from, next, blend, timing);
  return { x: curve((pose) => pose.x), y: curve((pose) => pose.y), z: curve((pose) => pose.z) };
}
