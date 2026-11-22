import type { Position } from './types';
const clamp = (value: number) => Math.max(0, Math.min(1, value));
/** Only contiguous recorded horizontal motion supplies speed. No jumping/reload/shot inference. */
export function recordedLocomotion(
  from: Position,
  to: Position | undefined,
  fromTick: number,
  toTick: number,
  rate: number,
  alpha: number,
) {
  const interval = (toTick - fromTick) / rate;
  const known =
    to?.id === from.id &&
    from.alive &&
    to.alive &&
    Number.isFinite(interval) &&
    interval > 0 &&
    interval <= 0.25 &&
    Math.hypot(to.x - from.x, to.y - from.y) <= Math.max(128, 4096 * interval);
  const speed = known ? (Math.hypot(to.x - from.x, to.y - from.y) * 0.0254) / interval : 0;
  const duck =
    from.duck === undefined
      ? 0
      : from.duck + (known && to.duck !== undefined ? (to.duck - from.duck) * clamp(alpha) : 0);
  return { speed: Number.isFinite(speed) ? speed : 0, duck: clamp(duck) };
}
