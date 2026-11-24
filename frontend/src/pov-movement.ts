import { recordedLocomotion } from './agent-locomotion';
import { recordedMotion, type PreviousPose } from './recorded-motion';
import type { PoseTiming } from './player-pose';
import type { Playback, Position } from './types';
import { strideDisplacement } from '../../shared/stride-distance.mjs';
import { canonicalEquipmentKey } from './equipment-key';

const landingDuration = 0.24;

export function landingEnvelope(age: number, descent: number) {
  if (!Number.isFinite(age) || age <= 0 || age >= landingDuration || !(descent >= 2.4)) return 0;
  const peak = 0.055;
  const phase = age < peak ? age / peak : (landingDuration - age) / (landingDuration - peak);
  return (0.028 + 0.02 * Math.min(1, (descent - 2.4) / 5)) * phase * phase * (3 - 2 * phase);
}

type PovHistory = Pick<Playback, 'frames' | 'rounds' | 'tickRate'>;

/** Walk back from the primary frame into its spatial overlap. Each interval
 * requires the same live pawn and stays on the current side of round resets. */
function* recentIntervals(
  history: PovHistory,
  position: Position,
  frameTick: number,
  earliest: number,
) {
  const { frames, rounds, tickRate } = history;
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].tick < frameTick) low = middle + 1;
    else high = middle;
  }
  if (frames[low]?.tick !== frameTick) return;
  let round = -Infinity;
  for (let index = rounds.length - 1; index >= 0; index--) {
    if (rounds[index].tick <= frameTick) {
      round = rounds[index].tick;
      break;
    }
  }
  let current = position;
  for (let index = low; index > 0 && frames[index].tick >= earliest; index--) {
    const tick = frames[index].tick;
    const previous = frames[index - 1];
    if (previous.tick < round) return;
    const from = previous.players.find((player) => player.id === position.id);
    const seconds = (tick - previous.tick) / tickRate;
    const delta = strideDisplacement(from, current, seconds);
    if (!from || !delta) return;
    yield { from, current, tick, delta, verticalSpeed: (delta.vertical * 0.0254) / seconds };
    current = from;
  }
}

/** Replay chunks lack a grounded flag. Infer impact only after a substantial
 * downward interval followed by a near-level one. Start after that sample so
 * the envelope needs no lookahead across a chunk boundary. */
export function povLanding(
  history: PovHistory,
  position: Position,
  frameTick: number,
  tick: number,
) {
  const earliest = tick - landingDuration * history.tickRate;
  let settledAt: number | undefined;
  for (const { tick: at, delta, verticalSpeed } of recentIntervals(
    history,
    position,
    frameTick,
    earliest - 0.25 * history.tickRate,
  )) {
    if (Math.abs(verticalSpeed) > 14) break;
    if (
      settledAt !== undefined &&
      settledAt >= earliest &&
      delta.vertical <= -4 &&
      verticalSpeed <= -2.4
    )
      return landingEnvelope((tick - settledAt) / history.tickRate, -verticalSpeed);
    settledAt = Math.abs(verticalSpeed) <= 0.45 ? at : undefined;
  }
  return 0;
}

/** Sample an optional authored draw only after a known active-weapon switch. */
export function povDraw(
  history: PovHistory,
  position: Position,
  frameTick: number,
  tick: number,
  duration: number,
) {
  const weapon = canonicalEquipmentKey(position.weapon);
  if (!weapon) return;
  for (const { from, tick: switchedAt } of recentIntervals(
    history,
    position,
    frameTick,
    tick - duration * history.tickRate,
  )) {
    const previous = canonicalEquipmentKey(from.weapon);
    if (previous === weapon) continue;
    const age = (tick - switchedAt) / history.tickRate;
    if (previous && age >= 0 && age < duration)
      return { age, weight: Math.min(1, (duration - age) / Math.min(0.08, duration / 2)) };
    return;
  }
}

/** Add a small stride to the weapon rig from observed motion and absolute replay time. */
export function povMovement(
  position: Position,
  next: Position | undefined,
  alpha: number,
  timing?: PoseTiming,
  previous?: PreviousPose,
  travelMeters?: number,
  dip = 0,
  airborne = 0,
) {
  if (!timing || timing.roundBoundary || !Number.isFinite(alpha)) return;
  if (next && Math.abs(next.z - position.z) > 128) return;
  const { fromTick, nextTick, tickRate } = timing;
  const { duck } = recordedLocomotion(position, next, fromTick, nextTick, tickRate, alpha);
  const { speed, rise, yaw, pitch } = recordedMotion(position, next, alpha, timing, previous);
  if (!(speed > 0.08) && !rise && !yaw && !pitch && !dip) return;
  const amplitude =
    Math.max(0, Math.min(1, (speed - 0.08) / 4)) * (1 - duck * 0.55) * (1 - airborne);
  const time = (fromTick + (nextTick - fromTick) * Math.max(0, Math.min(1, alpha))) / tickRate;
  const step = 2 * Math.PI * (travelMeters === undefined ? 1.6 * time : travelMeters / 1.55);
  const sway = amplitude ? Math.sin(step) * 0.016 * amplitude : 0;
  const bounce = amplitude ? Math.cos(step * 2) * amplitude : 0;
  return {
    side: sway + yaw * 0.000028,
    lift: (bounce - amplitude) * 0.009 - rise * 0.0012 - dip,
    depth: bounce * 0.01,
    roll: sway - yaw * 0.000032,
    pitch: pitch * 0.00008 - rise * 0.0012 - dip * 0.75,
    yaw: -yaw * 0.00008,
  };
}
