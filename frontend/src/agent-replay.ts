import equipment from '../../shared/equipment-models.json' with { type: 'json' };
import { deathAnchor } from '../../shared/agent-deaths.mjs';
import type { AgentAction } from '../../shared/agent-animation';
import { strideDisplacement } from '../../shared/stride-distance.mjs';
import { canonicalEquipmentKey } from './equipment-key';
import { indexSpectatorEvents } from './spectator-state';
import { indexWeaponFire, recentWeaponShot } from './weapon-fire';
import type { Frame, Playback, Position } from './types';

export type AgentDeathSample = { position: Position; variant: number; age: number };

function latestAt<T extends { tick: number }>(values: readonly T[] | undefined, tick: number) {
  if (!values) return;
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (values[middle].tick <= tick) lo = middle + 1;
    else hi = middle;
  }
  return values[lo - 1];
}

const grenadeKeys = new Set(
  Object.entries(equipment.items)
    .filter(([, item]) => item.kind === 'grenade')
    .map(([key]) => key),
);
type ThrowPose = {
  tick: number;
  start: number;
  weapon: string;
  underhand: boolean;
  observedRelease: boolean;
};
type MeleePose = { tick: number; weapon: string };
export type PovAction = { kind: 'throw' | 'underhand' | 'slash'; age: number; released: boolean };

export function indexAgentEvents(data: Playback) {
  const { deaths } = indexSpectatorEvents(data);
  const shots = indexWeaponFire(data);
  const anchors = new Map(
    data.agentDeaths?.map((anchor) => [anchor.id + ':' + anchor.tick, anchor]),
  );
  const throws = new Map<string, ThrowPose[]>();
  const melee = new Map<string, MeleePose[]>();
  const pending = new Map<string, ThrowPose>();
  const inputs = new Map(data.throwInputs?.map((snapshot) => [snapshot.eventIndex, snapshot]));
  for (const [index, event] of data.events.entries()) {
    if (event.type === 'round_start') pending.clear();
    if (
      (event.type !== 'weapon_fire' && event.type !== 'grenade_thrown') ||
      !event.weapon ||
      !event.user_steamid
    )
      continue;
    const weapon = canonicalEquipmentKey(event.weapon);
    if (
      equipment.items[weapon as keyof typeof equipment.items]?.kind === 'knife' &&
      event.type === 'weapon_fire'
    ) {
      const attacks = melee.get(event.user_steamid) ?? [];
      attacks.push({ tick: event.tick, weapon });
      melee.set(event.user_steamid, attacks);
    }
    if (!grenadeKeys.has(weapon)) continue;
    const snapshot = inputs.get(index);
    const input =
      snapshot?.actorId === event.user_steamid &&
      snapshot.tick === event.tick &&
      snapshot.sampleTick === event.tick
        ? snapshot.input
        : undefined;
    const actor = event.user_steamid;
    const prior = pending.get(actor);
    const underhand = input?.attack2 === true && input.attack === false;
    // A utility weapon_fire starts the action. grenade_thrown records the
    // subsequent projectile release; some recordings supply just one of them.
    if (
      event.type === 'grenade_thrown' &&
      prior?.weapon === weapon &&
      event.tick >= prior.start &&
      event.tick - prior.start <= data.tickRate * 0.25
    ) {
      prior.tick = event.tick;
      prior.observedRelease = true;
      pending.delete(actor);
      continue;
    }
    const entry = {
      tick: event.tick,
      start: event.tick,
      weapon,
      underhand,
      observedRelease: event.type === 'grenade_thrown',
    };
    const list = throws.get(actor) ?? [];
    list.push(entry);
    throws.set(actor, list);
    if (event.type === 'weapon_fire') pending.set(actor, entry);
    else pending.delete(actor);
  }
  for (const list of throws.values()) list.sort((a, b) => a.tick - b.tick);
  for (const list of melee.values()) list.sort((a, b) => a.tick - b.tick);
  return { deaths, shots, anchors, throws, melee };
}

function heldMeleeMatches(attack: MeleePose, weapon: string, team: number) {
  return (
    attack.weapon === weapon || (attack.weapon === 'knifet' && weapon === 'knife' && team === 2)
  );
}

/** Sample the action at demo time. Only the release event retires the held
 * grenade from the viewmodel; the recorded projectile owns its world position. */
export function povActionAt(
  evidence: ReturnType<typeof indexAgentEvents>,
  position: Position,
  tick: number,
  rate: number,
  roundStart: number,
): PovAction | undefined {
  if (!position.alive || !(rate > 0)) return;
  const weapon = canonicalEquipmentKey(position.weapon);
  if (grenadeKeys.has(weapon)) {
    const entries = evidence.throws.get(position.id);
    // Entries are ordered by release. The only following release that can
    // already be winding up belongs to the same action within a quarter second.
    const candidate = latestAt(entries, tick + rate * 0.25);
    const action = candidate && candidate.start <= tick ? candidate : latestAt(entries, tick);
    if (
      action &&
      action.weapon === weapon &&
      action.start >= roundStart &&
      tick < action.start + rate * 2
    )
      return {
        kind: action.underhand ? 'underhand' : 'throw',
        age: (tick - action.start) / rate,
        released: action.observedRelease && tick >= action.tick,
      };
  } else {
    const action = latestAt(evidence.melee.get(position.id), tick);
    if (
      action &&
      heldMeleeMatches(action, weapon, position.team) &&
      action.tick >= roundStart &&
      tick < action.tick + rate * 2
    )
      return { kind: 'slash', age: (tick - action.tick) / rate, released: false };
  }
}

export function indexAgentDraws(data: Playback) {
  const draws = new Map<string, { tick: number; weapon: string; prior: string }[]>();
  for (let index = 1; index < data.frames.length; index++) {
    const from = data.frames[index - 1],
      to = data.frames[index];
    if (data.rounds.some((round) => round.tick > from.tick && round.tick <= to.tick)) continue;
    const previous = new Map(from.players.map((position) => [position.id, position]));
    for (const position of to.players) {
      const before = previous.get(position.id);
      if (!before || !strideDisplacement(before, position, (to.tick - from.tick) / data.tickRate))
        continue;
      const weapon = canonicalEquipmentKey(position.weapon);
      const prior = canonicalEquipmentKey(before.weapon);
      if (!weapon || !prior || prior === weapon) continue;
      const changes = draws.get(position.id) ?? [];
      changes.push({ tick: to.tick, weapon, prior });
      draws.set(position.id, changes);
    }
  }
  return draws;
}

export type AgentActionSample = {
  kind: AgentAction;
  age: number;
  released?: boolean;
  previousWeapon?: string;
  priorFireAge?: number;
  nextFireInterval?: number;
};

export function agentActionAt(
  evidence: ReturnType<typeof indexAgentEvents>,
  draws: ReturnType<typeof indexAgentDraws>,
  position: Position,
  tick: number,
  rate: number,
  roundStart: number,
  enabled: boolean,
  fireEnabled: boolean,
): AgentActionSample | undefined {
  if (!enabled || !position.alive) return;
  const key = canonicalEquipmentKey(position.weapon);
  if (grenadeKeys.has(key)) {
    // Align the observed throw to the start of the native clip's hand-IK
    // disable marker (15/30 s overhand, 13/30 s underhand).
    const shot = latestAt(evidence.throws.get(position.id), tick + rate * 0.5);
    if (shot && shot.weapon === key && shot.tick >= roundStart) {
      const elapsed = (tick - shot.tick) / rate;
      const lead = shot.underhand ? 13 / 30 : 0.5;
      if (elapsed >= -lead && elapsed < 0.2)
        return {
          kind: shot.underhand ? 'throw-underhand' : 'throw',
          age: elapsed + lead,
          released: elapsed >= 0,
        };
    }
  }
  const change = latestAt(draws.get(position.id), tick);
  const draw = change?.weapon === key ? change?.tick : undefined;
  const fire = fireEnabled ? recentWeaponShot(evidence.shots, position, tick, rate, 30) : undefined;
  const attack = latestAt(evidence.melee.get(position.id), tick);
  const melee = attack && heldMeleeMatches(attack, key, position.team) ? attack.tick : undefined;
  const reload = position.reloadStarted;
  let winner: { kind: AgentAction; tick: number } | undefined;
  for (const [kind, start] of [
    ['draw', draw],
    ['reload', reload],
    ['fire', fire?.tick ?? melee],
  ] as const) {
    if (
      start !== undefined &&
      start >= roundStart &&
      start <= tick &&
      (!winner || start >= winner.tick)
    )
      winner = { kind, tick: start };
  }
  if (!winner) return;
  const action: AgentActionSample = { kind: winner.kind, age: (tick - winner.tick) / rate };
  if (winner.kind === 'draw') action.previousWeapon = change?.prior;
  if (winner.kind === 'fire' && fire) {
    if (
      fire.priorTick !== undefined &&
      fire.priorTick >= Math.max(roundStart, draw ?? -Infinity, reload ?? -Infinity)
    )
      action.priorFireAge = (tick - fire.priorTick) / rate;
    if (fire.nextTick !== undefined) action.nextFireInterval = (fire.nextTick - fire.tick) / rate;
  }
  return action;
}

export function deadAgentsAt(
  data: Playback,
  evidence: ReturnType<typeof indexAgentEvents>,
  tick: number,
  round: Playback['rounds'][number] | undefined,
  frame?: Frame,
): AgentDeathSample[] {
  if (!round || (round.endTick !== undefined && tick >= round.endTick)) return [];
  const bodies: AgentDeathSample[] = [];
  for (const [id, events] of evidence.deaths) {
    const event = latestAt(events, tick);
    if (!event || event.tick < round.tick) continue;
    if (
      frame &&
      frame.tick > event.tick &&
      frame.players.some((pawn) => pawn.id === id && pawn.alive)
    )
      continue;
    const anchor =
      evidence.anchors.get(id + ':' + event.tick) ??
      deathAnchor(data.frames, id, event.tick, round.tick, data.tickRate);
    if (!anchor) continue;
    const { team, x, y, z, yaw } = anchor;
    // Stable across seeking, even if the loaded frame no longer contains this pawn.
    const variant = [...id].reduce(
      (value, character) => value + character.charCodeAt(0),
      event.tick,
    );
    bodies.push({
      position: { id, team, x, y, z, yaw, pitch: 0, alive: false, health: 0, weapon: '' },
      variant,
      age: (tick - event.tick) / data.tickRate,
    });
  }
  return bodies;
}

export function agentRoundAt(rounds: Playback['rounds'], tick: number) {
  return latestAt(rounds, tick);
}
