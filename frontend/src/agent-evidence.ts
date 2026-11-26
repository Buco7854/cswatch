import { MathUtils, Vector3 } from 'three';
import { frameAt } from './playback';
import type { Frame, GameEvent, Playback, Position } from './types';

/** Recorded per-player evidence for the action layers. Every value is a pure function of
 * the replay and the tick, so seeking either way gives the same pose. */

type Hit = {
  tick: number;
  hitgroup: string;
  attacker?: string;
  headshot?: boolean;
  damage?: number;
};
const hits = new WeakMap<GameEvent[], Map<string, Hit[]>>();
const deaths = new WeakMap<GameEvent[], Map<string, Hit[]>>();

function indexHits(events: GameEvent[], type: 'player_hurt' | 'player_death') {
  const cache = type === 'player_hurt' ? hits : deaths;
  let index = cache.get(events);
  if (index) return index;
  index = new Map();
  for (const event of events) {
    if (event.type !== type || typeof event.user_steamid !== 'string') continue;
    const list = index.get(event.user_steamid) ?? [];
    list.push({
      tick: event.tick,
      hitgroup: typeof event.hitgroup === 'string' ? event.hitgroup : 'generic',
      attacker: typeof event.attacker_steamid === 'string' ? event.attacker_steamid : undefined,
      headshot: event.headshot === true,
      damage: Number.isFinite(Number(event.dmg_health)) ? Number(event.dmg_health) : undefined,
    });
    index.set(event.user_steamid, list);
  }
  for (const list of index.values()) list.sort((a, b) => a.tick - b.tick);
  cache.set(events, index);
  return index;
}

function latest<T extends { tick: number }>(list: T[] | undefined, tick: number) {
  if (!list) return;
  let lo = 0,
    hi = list.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (list[middle].tick <= tick) lo = middle + 1;
    else hi = middle;
  }
  return list[lo - 1];
}

/** Side of the victim the shot came from: front, left, right or rear. */
function hitSide(data: Playback, hit: Hit, victim: string) {
  if (!hit.attacker || hit.attacker === victim) return 'front';
  const { frame } = frameAt(data, hit.tick);
  const from = frame.players.find((player) => player.id === hit.attacker);
  const to = frame.players.find((player) => player.id === victim);
  if (!from || !to) return 'front';
  const bearing = MathUtils.radToDeg(Math.atan2(from.y - to.y, from.x - to.x)) - to.yaw;
  const relative = (((bearing % 360) + 540) % 360) - 180;
  if (Math.abs(relative) <= 50) return 'front';
  if (Math.abs(relative) >= 130) return 'rear';
  return relative > 0 ? 'left' : 'right';
}

/** Valve's flinch for the recorded hitgroup and the side the shot came from. */
export function flinchRole(hitgroup: string, side: string) {
  const directional = (part: string, sides: string[]) =>
    `flinch:${part}${sides.includes(side) ? '-' + side : ''}`;
  switch (hitgroup) {
    case 'head':
    case 'neck':
      return directional('head', ['left', 'right', 'rear']);
    case 'stomach':
      return directional('stomach', ['rear']);
    case 'left_arm':
      return 'flinch:arm-left';
    case 'right_arm':
      return 'flinch:arm-right';
    case 'left_leg':
      return 'flinch:leg-left';
    case 'right_leg':
      return 'flinch:leg-right';
    default:
      return directional('chest', ['left', 'right', 'rear']);
  }
}

export function recordedFlinch(data: Playback, id: string, tick: number) {
  const hit = latest(indexHits(data.events, 'player_hurt').get(id), tick);
  if (!hit) return;
  const age = (tick - hit.tick) / data.tickRate;
  if (age < 0 || age > 0.75) return;
  return { role: flinchRole(hit.hitgroup, hitSide(data, hit, id)), age };
}

/** Valve's death clip for the recorded kill, and the yaw that sends its fall along
 * the shot. Clips fall backward (chest, shoulder, knee) or forward (gut). */
export function recordedDeath(data: Playback, id: string, tick: number, yaw: number) {
  const death = latest(indexHits(data.events, 'player_death').get(id), tick);
  if (!death) return;
  const variant = death.tick % 2 ? 'a' : 'b';
  const side = hitSide(data, death, id);
  let role: string;
  if (death.hitgroup === 'stomach') role = `death:gut-${variant}`;
  else if (death.hitgroup === 'right_arm' || death.hitgroup === 'left_arm')
    role = 'death:rshoulder';
  else if (death.hitgroup === 'left_leg' || death.hitgroup === 'right_leg')
    role = `death:rknee-${variant}`;
  else role = `death:chest-${variant}`;
  // Turn the body so it falls away from the attacker (or toward, for a gut fall).
  let facing = yaw;
  if (death.attacker && death.attacker !== id) {
    const { frame } = frameAt(data, death.tick);
    const from = frame.players.find((player) => player.id === death.attacker);
    const to = frame.players.find((player) => player.id === id);
    if (from && to) {
      const toward = MathUtils.radToDeg(Math.atan2(from.y - to.y, from.x - to.x));
      facing = role.startsWith('death:gut') ? toward + 180 : toward;
    }
  }
  return { role, yaw: facing, side };
}

/** Recorded airborne state (FL_ONGROUND), from the stored frames around the tick. */
export function recordedAir(data: Playback, id: string, tick: number) {
  if (!data.capabilities?.pawnMovement) return;
  const frames = data.frames;
  const { frame, index } = frameAt(data, tick);
  const state = (at: Frame) => at.players.find((player) => player.id === id);
  const current = state(frame);
  if (!current?.alive) return;
  const rate = data.tickRate;
  const limit = rate * 3;
  if (current.airborne) {
    // Walk back to the take-off: the first airborne sample after ground contact.
    let start = frame.tick;
    for (let i = index - 1; i >= 0 && frame.tick - frames[i].tick <= limit; i--) {
      const pose = state(frames[i]);
      if (!pose?.alive || !pose.airborne) break;
      start = frames[i].tick;
    }
    const air = Math.max(0, (tick - start) / rate);
    return { weight: MathUtils.smoothstep(air, 0, 0.12), jumpAge: air };
  }
  // On the ground: find the landing, the first grounded sample after flight.
  let landing: number | undefined;
  for (let i = index; i > 0 && frame.tick - frames[i].tick <= rate; i--) {
    const pose = state(frames[i]),
      before = state(frames[i - 1]);
    if (!pose?.alive || !before?.alive) break;
    if (before.airborne) {
      landing = frames[i].tick;
      break;
    }
  }
  if (landing === undefined) return { weight: 0 };
  const age = (tick - landing) / rate;
  return { weight: 1 - MathUtils.smoothstep(age, 0, 0.1), landAge: age };
}

/** Recorded ladder movement: the cycle is locked to height so feet keep to the rungs. */
export function recordedLadder(position: Position, next: Position | undefined, seconds: number) {
  if (!position.ladder) return;
  const climbed = position.z * 0.0254;
  const speed = next && seconds > 0 ? ((next.z - position.z) * 0.0254) / seconds : 0;
  return { climbed, speed };
}

const turnThreshold = 50,
  turnSettle = 12,
  turnRate = 320,
  movingSpeed = 0.6;
const angleBetween = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;
/** Aim yaw beyond the feet' yaw while standing. Moving players face their aim; a standing
 * player's feet keep their yaw until the aim leaves a 50° cone, then turn to within 12°.
 * The state is replayed from the recorded yaw samples of the last four seconds, so any
 * seek reaches the same pose. */
export function recordedTwist(data: Playback, id: string, tick: number, aimYaw: number) {
  return recordedStance(data, id, tick, aimYaw).twist;
}

/** A standing turn: the feet catch up with the aim. `turned` is degrees rotated since it began;
 * `restAge` is the seconds since the feet stopped, while the step settles. */
export type RecordedTurn = { side: 'left' | 'right'; turned: number; restAge?: number };

/** The standing feet's yaw lags the aim: `twist` is the aim beyond the feet, and `turn` the
 * most recent step the feet took to catch up (Source yaw grows to the left). */
export function recordedStance(
  data: Playback,
  id: string,
  tick: number,
  aimYaw: number,
): { twist: number; turn?: RecordedTurn } {
  const frames = data.frames;
  const { frame, index } = frameAt(data, tick);
  const state = (i: number) => frames[i].players.find((player) => player.id === id);
  const rate = data.tickRate;
  const moving = (i: number) => {
    const a = state(i - 1),
      b = state(i);
    if (!a?.alive || !b?.alive) return true;
    const seconds = (frames[i].tick - frames[i - 1].tick) / rate;
    return (
      !(seconds > 0) ||
      seconds > 0.25 ||
      (Math.hypot(b.x - a.x, b.y - a.y) * 0.0254) / seconds > movingSpeed ||
      Boolean(b.ladder || b.airborne)
    );
  };
  let start = index;
  while (start > 0 && frame.tick - frames[start - 1].tick <= rate * 4 && !moving(start)) start--;
  const first = state(start);
  if (!first?.alive || moving(index)) return { twist: 0 };
  let body = first.yaw,
    turning = false,
    time = frames[start].tick,
    turn: { side: 'left' | 'right'; from: number; turned: number; stopped?: number } | undefined;
  const step = (aim: number, until: number) => {
    const seconds = (until - time) / rate;
    time = until;
    const offset = angleBetween(body, aim);
    if (!turning && Math.abs(offset) > turnThreshold) {
      turning = true;
      turn = { side: offset > 0 ? 'left' : 'right', from: body, turned: 0 };
    }
    if (!turning) return;
    const change = Math.min(Math.abs(offset), turnRate * seconds);
    body += Math.sign(offset) * change;
    turn!.turned = Math.abs(angleBetween(turn!.from, body));
    if (Math.abs(angleBetween(body, aim)) <= turnSettle) {
      turning = false;
      turn!.stopped = until;
    }
  };
  for (let i = start + 1; i <= index; i++) step(state(i)!.yaw, frames[i].tick);
  step(aimYaw, Math.max(time, tick));
  return {
    twist: angleBetween(body, aimYaw),
    ...(turn
      ? {
          turn: {
            side: turn.side,
            turned: turn.turned,
            ...(turn.stopped === undefined
              ? {}
              : { restAge: Math.max(0, (tick - turn.stopped) / rate) }),
          },
        }
      : {}),
  };
}

/** Ragdoll bodies the recorded hitgroup lands on (skeleton bone names). */
const hitBodies: Record<string, string> = {
  head: 'head_0',
  neck: 'head_0',
  chest: 'spine_2',
  stomach: 'pelvis',
  left_arm: 'arm_upper_L',
  right_arm: 'arm_upper_R',
  left_leg: 'leg_upper_L',
  right_leg: 'leg_upper_R',
};
export type RagdollRequest = {
  key: string;
  velocity: Vector3;
  bone: string;
  direction: Vector3;
  speed: number;
  weapon: string;
  duck: number;
};
/** The recorded death that seeds a ragdoll: the pawn's last velocity, and the killing shot's
 * body part, direction (attacker to victim) and damage. */
export function recordedRagdoll(
  data: Playback,
  id: string,
  tick: number,
): RagdollRequest | undefined {
  const death = latest(indexHits(data.events, 'player_death').get(id), tick);
  if (!death) return;
  const span = frameAt(data, death.tick);
  const frames = data.frames;
  // The last living sample at or before the death, and the one before it for velocity.
  let index = span.index;
  const living = (i: number) => frames[i]?.players.find((p) => p.id === id && p.alive);
  while (index > 0 && !living(index)) index--;
  const last = living(index),
    before = living(index - 1);
  if (!last) return;
  const velocity = new Vector3();
  if (before) {
    const seconds = (frames[index].tick - frames[index - 1].tick) / data.tickRate;
    if (seconds > 0 && seconds <= 0.25)
      velocity
        .set(last.x - before.x, last.z - before.z, -(last.y - before.y))
        .multiplyScalar(0.0254 / seconds);
    if (velocity.length() > 8) velocity.setLength(8);
  }
  const direction = new Vector3(
    Math.cos(MathUtils.degToRad(last.yaw)),
    0,
    -Math.sin(MathUtils.degToRad(last.yaw)),
  ).negate();
  if (death.attacker && death.attacker !== id) {
    const from = span.frame.players.find((p) => p.id === death.attacker);
    if (from) direction.set(last.x - from.x, last.z - from.z, -(last.y - from.y));
  }
  if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
  direction.normalize();
  const damage = Math.min(150, Math.max(10, death.damage ?? 60));
  return {
    key: `${id}:${death.tick}`,
    velocity,
    bone: hitBodies[death.hitgroup] ?? 'spine_2',
    direction,
    // A killing shot throws the hit body at 1.5-4 m/s by its recorded damage.
    speed: Math.min(4, 1.5 + (damage / 100) * 2) * (death.headshot ? 1.15 : 1),
    weapon: last.weapon,
    duck: last.duck ?? 0,
  };
}
