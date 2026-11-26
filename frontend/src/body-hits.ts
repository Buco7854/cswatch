import { Vector3, type Object3D } from 'three';
import { frameAt, poseTimingAt } from './playback';
import { playerPose } from './player-pose';
import { recordedEyePosition } from './pov-camera';
import type { GameEvent, Playback } from './types';

/** Recorded bullet hits on players: where the attacker's recorded aim meets the victim's
 * posed body part for the recorded hitgroup. Everything is a function of the replay. */
export type BodyHit = {
  tick: number;
  victim: string;
  attacker?: string;
  hitgroup: string;
  armor: boolean;
  lethal: boolean;
  seed: number;
};
const indices = new WeakMap<GameEvent[], BodyHit[]>();
const melee =
  /knife|bayonet|taser|inferno|molotov|incgrenade|hegrenade|flashbang|smokegrenade|decoy|world/;

export function indexBodyHits(events: GameEvent[]) {
  let hits = indices.get(events);
  if (hits) return hits;
  hits = [];
  for (const event of events) {
    if (event.type !== 'player_hurt' || typeof event.user_steamid !== 'string') continue;
    // Bullets only: blades, the taser, grenades, fire and falls leave no bullet wound.
    const weapon = String(event.weapon ?? '').toLowerCase();
    if (!weapon || melee.test(weapon)) continue;
    const attacker =
      typeof event.attacker_steamid === 'string' ? event.attacker_steamid : undefined;
    if (!attacker || attacker === event.user_steamid) continue;
    hits.push({
      tick: event.tick,
      victim: event.user_steamid,
      attacker,
      hitgroup: typeof event.hitgroup === 'string' ? event.hitgroup : 'generic',
      armor: Number(event.dmg_armor) > 0,
      lethal: Number(event.health) === 0,
      seed:
        (event.tick * 2654435761 +
          [...event.user_steamid].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) >>>
        0,
    });
  }
  hits.sort((a, b) => a.tick - b.tick);
  indices.set(events, hits);
  return hits;
}

/** Hits whose effects are still visible at `tick`, newest last, bounded. */
export function activeBodyHits(data: Playback, tick: number, seconds = 1.2, limit = 8) {
  const hits = indexBodyHits(data.events);
  let lo = 0,
    hi = hits.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (hits[middle].tick <= tick) lo = middle + 1;
    else hi = middle;
  }
  const result: BodyHit[] = [];
  for (let i = lo - 1; i >= 0 && tick - hits[i].tick <= seconds * data.tickRate; i--) {
    result.unshift(hits[i]);
    if (result.length >= limit) break;
  }
  return result;
}

/** Capsules (two bones and a radius in metres) standing in for the hitboxes. */
export const hitgroupCapsules: Record<string, [string, string, number]> = {
  head: ['head_0', 'head_0', 0.11],
  neck: ['neck_0', 'head_0', 0.06],
  chest: ['spine_2', 'spine_3', 0.16],
  stomach: ['spine_0', 'spine_1', 0.15],
  left_arm: ['arm_upper_L', 'hand_L', 0.05],
  right_arm: ['arm_upper_R', 'hand_R', 0.05],
  left_leg: ['leg_upper_L', 'ankle_L', 0.08],
  right_leg: ['leg_upper_R', 'ankle_R', 0.08],
  generic: ['spine_1', 'spine_3', 0.16],
};

const a = new Vector3(),
  b = new Vector3(),
  ab = new Vector3(),
  w = new Vector3(),
  onRay = new Vector3(),
  onSegment = new Vector3();
/** The entry point of a ray into a capsule, or the capsule point nearest the ray. */
export function capsuleHit(
  origin: Vector3,
  direction: Vector3,
  start: Vector3,
  end: Vector3,
  radius: number,
  target: Vector3,
) {
  ab.subVectors(end, start);
  w.subVectors(origin, start);
  const aa = direction.dot(direction),
    bb = direction.dot(ab),
    cc = ab.dot(ab),
    dd = direction.dot(w),
    ee = ab.dot(w);
  const denominator = aa * cc - bb * bb;
  let s = denominator > 1e-9 ? (bb * ee - cc * dd) / denominator : -dd / aa;
  let u = cc > 1e-9 ? (aa * ee - bb * dd) / denominator : 0;
  if (cc <= 1e-9 || denominator <= 1e-9) u = 0;
  u = Math.max(0, Math.min(1, u));
  onSegment.copy(start).addScaledVector(ab, u);
  // Re-project the ray onto the clamped segment point.
  s = Math.max(0, w.subVectors(onSegment, origin).dot(direction) / aa);
  onRay.copy(origin).addScaledVector(direction, s);
  const distance = onRay.distanceTo(onSegment);
  if (distance <= radius) {
    const back = Math.sqrt(radius * radius - distance * distance) / Math.sqrt(aa);
    return target.copy(origin).addScaledVector(direction, Math.max(0, s - back));
  }
  return target.copy(onRay).sub(onSegment).setLength(radius).add(onSegment);
}

/** The attacker's recorded eye and aim direction (three.js metres) at a tick. */
export function recordedAim(data: Playback, id: string, tick: number) {
  const span = frameAt(data, tick);
  const from = span.frame.players.find((player) => player.id === id);
  if (!from?.alive) return;
  const to = span.next.players.find((player) => player.id === id);
  const pose = playerPose(from, to, span.alpha, poseTimingAt(data, span, id));
  const yaw = (pose.yaw * Math.PI) / 180,
    pitch = (pose.pitch * Math.PI) / 180;
  return {
    origin: new Vector3(...recordedEyePosition(pose)),
    direction: new Vector3(
      Math.cos(yaw) * Math.cos(pitch),
      -Math.sin(pitch),
      -Math.sin(yaw) * Math.cos(pitch),
    ),
  };
}

/** Where the recorded shot met the victim's posed body part. */
export function bodyHitPoint(
  root: Object3D,
  hit: BodyHit,
  aim: { origin: Vector3; direction: Vector3 },
  target: Vector3,
) {
  const [first, second, radius] = hitgroupCapsules[hit.hitgroup] ?? hitgroupCapsules.generic;
  const start = root.getObjectByName(first),
    end = root.getObjectByName(second);
  if (!start || !end) return;
  start.getWorldPosition(a);
  end.getWorldPosition(b);
  return capsuleHit(aim.origin, aim.direction, a, b, radius, target);
}
