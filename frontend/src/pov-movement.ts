import { recordedLocomotion } from './agent-locomotion';
import type { PoseTiming } from './player-pose';
import type { Position } from './types';

/** Add a small stride to the weapon rig from observed motion and absolute replay time. */
export function povMovement(
  position: Position,
  next: Position | undefined,
  alpha: number,
  timing?: PoseTiming,
) {
  if (!timing || timing.roundBoundary || !Number.isFinite(alpha)) return;
  if (next && Math.abs(next.z - position.z) > 128) return;
  const { fromTick, nextTick, tickRate } = timing;
  const { speed, duck } = recordedLocomotion(position, next, fromTick, nextTick, tickRate, alpha);
  if (!(speed > 0.08)) return;
  const amplitude = Math.min(1, (speed - 0.08) / 4) * (1 - duck * 0.55);
  const time = (fromTick + (nextTick - fromTick) * Math.max(0, Math.min(1, alpha))) / tickRate;
  const step = 2 * Math.PI * 1.6 * time;
  return {
    side: Math.sin(step) * 0.023 * amplitude,
    lift: (Math.cos(step * 2) - 1) * 0.012 * amplitude,
    depth: Math.cos(step * 2) * 0.016 * amplitude,
    roll: Math.sin(step) * 0.023 * amplitude,
  };
}
