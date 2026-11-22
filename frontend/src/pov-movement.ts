import { recordedLocomotion } from './agent-locomotion';
import { recordedMotion, type PreviousPose } from './recorded-motion';
import type { PoseTiming } from './player-pose';
import type { Position } from './types';

/** Add a small stride to the weapon rig from observed motion and absolute replay time. */
export function povMovement(
  position: Position,
  next: Position | undefined,
  alpha: number,
  timing?: PoseTiming,
  previous?: PreviousPose,
  travelMeters?: number,
) {
  if (!timing || timing.roundBoundary || !Number.isFinite(alpha)) return;
  if (next && Math.abs(next.z - position.z) > 128) return;
  const { fromTick, nextTick, tickRate } = timing;
  const { duck } = recordedLocomotion(position, next, fromTick, nextTick, tickRate, alpha);
  const { speed, rise, yaw, pitch } = recordedMotion(position, next, alpha, timing, previous);
  if (!(speed > 0.08) && !rise && !yaw && !pitch) return;
  const amplitude = Math.max(0, Math.min(1, (speed - 0.08) / 4)) * (1 - duck * 0.55);
  const time = (fromTick + (nextTick - fromTick) * Math.max(0, Math.min(1, alpha))) / tickRate;
  const step = 2 * Math.PI * (travelMeters === undefined ? 1.6 * time : travelMeters / 1.55);
  return {
    side: Math.sin(step) * 0.023 * amplitude - yaw * 0.000035,
    lift: (Math.cos(step * 2) - 1) * 0.012 * amplitude - rise * 0.002,
    depth: Math.cos(step * 2) * 0.016 * amplitude,
    roll: Math.sin(step) * 0.023 * amplitude - yaw * 0.000045,
    pitch: -pitch * 0.00008 - rise * 0.0012,
    yaw: -yaw * 0.000065,
  };
}
