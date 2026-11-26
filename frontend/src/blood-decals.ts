/** Short-lived blood on the surface behind a recorded bullet hit: the wall the shot carries on
 * to, or the floor below the victim when no wall is near. Placement uses only the recorded
 * victim position, hitgroup and attacker aim at the hit tick and the static world, so any seek
 * gives the same splat. */
import { Vector3 } from 'three';
import { frameAt, poseTimingAt } from './playback';
import { playerPose } from './player-pose';
import { activeBodyHits, recordedAim, type BodyHit } from './body-hits';
import type { WorldQueries } from './world/queries';
import type { Playback } from './types';

export const bloodDecalSeconds = 6;
const fadeSeconds = 2;
export const bloodDecalLimit = 24;
/** Blood carries this far past the body to a wall. */
const wallReach = 2.4;
const inchesToMeters = 0.0254;

/** Standing hitgroup heights above the feet, metres; a full crouch lowers them by 28%. */
const heights: Record<string, number> = {
  head: 1.62,
  neck: 1.5,
  chest: 1.3,
  stomach: 1.02,
  left_arm: 1.25,
  right_arm: 1.25,
  left_leg: 0.55,
  right_leg: 0.55,
  generic: 1.15,
};

export type BloodPlacement = {
  center: Vector3;
  normal: Vector3;
  /** Unit direction of travel projected on the surface: the splat stretches along it. */
  along: Vector3;
  size: number;
  wall: boolean;
};

type Hit = WorldQueries['hit'];
const placements = new WeakMap<Hit, WeakMap<Playback, Map<string, BloodPlacement | null>>>();
const key = (hit: BodyHit) => `${hit.tick}:${hit.victim}:${hit.seed}`;

export function bloodPlacement(data: Playback, hit: BodyHit, query: Hit) {
  let byReplay = placements.get(query);
  if (!byReplay) placements.set(query, (byReplay = new WeakMap()));
  let cache = byReplay.get(data);
  if (!cache) byReplay.set(data, (cache = new Map()));
  const id = key(hit);
  if (cache.has(id)) return cache.get(id) ?? undefined;
  const result = place(data, hit, query);
  if (cache.size > 512) cache.delete(cache.keys().next().value!);
  cache.set(id, result ?? null);
  return result;
}

function place(data: Playback, hit: BodyHit, query: Hit): BloodPlacement | undefined {
  const aim = hit.attacker ? recordedAim(data, hit.attacker, hit.tick) : undefined;
  const span = frameAt(data, hit.tick);
  const victim = span.frame.players.find((player) => player.id === hit.victim);
  if (!aim || !victim) return;
  const pose = playerPose(
    victim,
    span.next.players.find((player) => player.id === hit.victim),
    span.alpha,
    poseTimingAt(data, span, hit.victim),
  );
  const height = (heights[hit.hitgroup] ?? heights.generic) * (1 - 0.28 * (pose.duck ?? 0));
  const point = new Vector3(
    pose.x * inchesToMeters,
    pose.z * inchesToMeters + height,
    -pose.y * inchesToMeters,
  );
  const direction = aim.direction.clone().normalize();
  const head = hit.hitgroup === 'head' || hit.hitgroup === 'neck';
  const start = point.clone().addScaledVector(direction, 0.15);
  const wall = query({
    target: start.toArray() as [number, number, number],
    position: start.clone().addScaledVector(direction, wallReach).toArray() as [
      number,
      number,
      number,
    ],
  });
  let center: Vector3, normal: Vector3, size: number;
  if (wall) {
    if (!wall.normal) return;
    normal = wall.normal.clone();
    // The visible face is the one the shot arrives at.
    if (normal.dot(direction) > 0) normal.negate();
    center = wall.point.clone();
    // Further walls catch a wider, thinner spray.
    size = (head ? 0.42 : 0.32) * (0.75 + 0.25 * Math.min(1, wall.distance / 1.2));
  } else {
    // Blood that meets no wall falls to the floor a little past the body.
    const drop = point.clone().addScaledVector(direction, 0.6);
    const floor = query({
      target: drop.toArray() as [number, number, number],
      position: [drop.x, drop.y - 3, drop.z],
    });
    if (!floor?.normal) return;
    normal = floor.normal.clone();
    if (normal.y < 0) normal.negate();
    if (normal.y < 0.5) return;
    center = floor.point.clone();
    size = head ? 0.3 : 0.24;
  }
  if (hit.lethal) size *= 1.2;
  center.addScaledVector(normal, 0.004);
  const along = direction.clone().addScaledVector(normal, -direction.dot(normal));
  if (along.lengthSq() < 1e-6) along.set(1, 0, 0).addScaledVector(normal, -normal.x);
  along.normalize();
  return { center, normal, along, size, wall: Boolean(wall) };
}

export type BloodDecal = BloodPlacement & { alpha: number; grow: number; seed: number };
/** Decals visible at `tick`, newest last. */
export function activeBloodDecals(data: Playback, tick: number, query: Hit) {
  const decals: BloodDecal[] = [];
  for (const hit of activeBodyHits(data, tick, bloodDecalSeconds, bloodDecalLimit)) {
    const age = (tick - hit.tick) / data.tickRate;
    // The spray reaches the surface a moment after the hit.
    if (age < 0.04) continue;
    const placement = bloodPlacement(data, hit, query);
    if (!placement) continue;
    decals.push({
      ...placement,
      alpha: Math.min(1, (bloodDecalSeconds - age) / fadeSeconds),
      grow: Math.min(1, 0.55 + age / 0.25),
      seed: hit.seed,
    });
  }
  return decals;
}
