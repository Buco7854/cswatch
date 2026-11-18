import registry from '../../shared/agent-animation.json';
import type { AgentAnimationRole } from '../../shared/agent-animation';
import type { Position } from './types';
export type LocomotionWeights = Record<AgentAnimationRole, number>;
export const nativeAgentRoles = Object.keys(registry.clips) as AgentAnimationRole[];
export const nativeAgentNames: Readonly<Record<AgentAnimationRole, string>> = registry.clips;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
/** Analytical blending thresholds in meters/second, not Source AnimGraph or authored stride speeds. */
export function locomotionWeights(speed: number, duck: number): LocomotionWeights {
  const moving = clamp(((Number.isFinite(speed) ? Math.max(0, speed) : 0) - 0.05) / 0.45),
    running = clamp(((Number.isFinite(speed) ? Math.max(0, speed) : 0) - 3) / 2),
    crouch = clamp(Number.isFinite(duck) ? duck : 0);
  return {
    idle: (1 - crouch) * (1 - moving),
    walk: (1 - crouch) * moving * (1 - running),
    run: (1 - crouch) * moving * running,
    'crouch-idle': crouch * (1 - moving),
    'crouch-walk': crouch * moving,
  };
}
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
/** Native metadata is exact and complete; old generic clips retain their separate fallback. */
export function nativeClipIndices(
  clips: readonly { name: string; duration: number }[],
  declarations: unknown,
): Record<AgentAnimationRole, number> | undefined {
  if (!Array.isArray(declarations)) return;
  const indices = {} as Record<AgentAnimationRole, number>;
  for (const role of nativeAgentRoles) {
    const matches = clips
      .map((clip, index) => ({ clip, index }))
      .filter(({ clip }) => clip.name === nativeAgentNames[role]);
    if (
      matches.length !== 1 ||
      !Number.isFinite(matches[0].clip.duration) ||
      matches[0].clip.duration <= 0 ||
      matches[0].clip.duration > 30
    )
      return;
    const source = declarations.filter((item) => item?.name === nativeAgentNames[role]);
    const meta = source[0]?.extras?.cswatch;
    if (
      source.length !== 1 ||
      meta?.kind !== 'native-locomotion' ||
      meta.schemaVersion !== 1 ||
      meta.role !== role ||
      meta.rootMotion !== 'recorded-position'
    )
      return;
    indices[role] = matches[0].index;
  }
  return indices;
}
