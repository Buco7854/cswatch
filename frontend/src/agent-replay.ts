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

export function indexAgentEvents(data: Playback) {
  const { deaths } = indexSpectatorEvents(data);
  const shots = indexWeaponFire(data);
  const anchors = new Map(
    data.agentDeaths?.map((anchor) => [anchor.id + ':' + anchor.tick, anchor]),
  );
  return { deaths, shots, anchors };
}

export function indexAgentDraws(data: Playback) {
  const draws = new Map<string, { tick: number; weapon: string }[]>();
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
      changes.push({ tick: to.tick, weapon });
      draws.set(position.id, changes);
    }
  }
  return draws;
}

export function agentActionAt(
  evidence: ReturnType<typeof indexAgentEvents>,
  draws: ReturnType<typeof indexAgentDraws>,
  position: Position,
  tick: number,
  rate: number,
  roundStart: number,
  enabled: boolean,
  fireEnabled: boolean,
) {
  if (!enabled || !position.alive) return;
  const change = latestAt(draws.get(position.id), tick);
  const draw = change?.weapon === canonicalEquipmentKey(position.weapon) ? change?.tick : undefined;
  const fire = fireEnabled
    ? recentWeaponShot(evidence.shots, position, tick, rate, 30)?.tick
    : undefined;
  const reload = position.reloadStarted;
  let winner: { kind: AgentAction; tick: number } | undefined;
  for (const [kind, start] of [
    ['draw', draw],
    ['reload', reload],
    ['fire', fire],
  ] as const) {
    if (
      start !== undefined &&
      start >= roundStart &&
      start <= tick &&
      (!winner || start >= winner.tick)
    )
      winner = { kind, tick: start };
  }
  if (winner) return { kind: winner.kind, age: (tick - winner.tick) / rate };
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
