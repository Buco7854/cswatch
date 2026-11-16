import type { GameEvent, Playback } from './types';
import { equipmentKey } from './equipment-key';
import { roundEvents } from './review-events';

export type ReviewPoint = { x: number; y: number; z: number };
export type KillPrompt = {
  kind: 'kill';
  id: string;
  tick: number;
  startTick: number;
  endTick: number;
  weapon?: string;
  target?: string;
  attackerId: string;
};
export type LandingPrompt = {
  kind: 'landing';
  id: string;
  tick: number;
  startTick: number;
  endTick: number;
  weapon: string;
  throwerId: string;
  /** Source coordinates (inches, Z-up), not viewer/world coordinates. */
  target: ReviewPoint;
  origin?: ReviewPoint;
  impactTick: number;
  source: 'recorded-detonation';
  association: 'entity-id' | 'unambiguous-owner';
};
export type ReviewPromptIndex = {
  kills: KillPrompt[];
  landings: LandingPrompt[];
  first: number;
  last: number;
  windowTicks: number;
};
type UtilityKind = 'smoke' | 'flash' | 'he' | 'fire' | 'decoy';
type Release = {
  id: string;
  tick: number;
  weapon: string;
  utility: UtilityKind;
  entity?: string;
  origin?: ReviewPoint;
  roundStart: number;
  roundEnd: number;
  explicit: boolean;
};
type Detonation = { tick: number; utility: UtilityKind; entity?: string; point: ReviewPoint };
const detonationKinds: Record<string, UtilityKind> = {
  smokegrenade_detonate: 'smoke',
  flashbang_detonate: 'flash',
  hegrenade_detonate: 'he',
  inferno_startburn: 'fire',
};
const utilityKinds: Record<string, UtilityKind> = {
  smokegrenade: 'smoke',
  flashbang: 'flash',
  hegrenade: 'he',
  molotov: 'fire',
  incgrenade: 'fire',
  decoy: 'decoy',
};
const order = <T extends { tick: number; id?: string }>(a: T, b: T) =>
  a.tick - b.tick || (a.id || '').localeCompare(b.id || '');
const validTick = (tick: unknown): tick is number =>
  Number.isSafeInteger(tick) && Number(tick) >= 0;

function point(event: GameEvent, fields: [string, string, string]): ReviewPoint | undefined {
  const values = fields.map((field) => event[field]);
  if (
    !values.every(
      (value) =>
        typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000,
    )
  )
    return;
  return { x: values[0] as number, y: values[1] as number, z: values[2] as number };
}

/** Entity numbers are native small integers. Steam IDs are never coerced to numbers. */
function entityId(event: GameEvent): string | null | undefined {
  const ids = new Set<string>();
  for (const field of ['entityid', 'entity_id', 'grenade_entity_id', 'projectile_entity_id']) {
    const value = event[field];
    if (value === undefined || value === null || value === '' || value === 0 || value === '0')
      continue;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      ids.add(String(value));
    else if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) ids.add(value);
    else return null;
  }
  return ids.size > 1 ? null : [...ids][0];
}

function owner(event: GameEvent, data: Playback, known: Set<string>): string | undefined {
  const ids = new Set<string>();
  for (const field of ['user_steamid', 'thrower_steamid', 'owner_steamid']) {
    const value = event[field];
    if (value === undefined || value === null || value === '' || value === 0 || value === '0')
      continue;
    if (typeof value !== 'string') return;
    ids.add(value);
  }
  if (ids.size) {
    const id = [...ids][0];
    return ids.size === 1 && known.has(id) ? id : undefined;
  }
  if (data.sample && typeof event.user_name === 'string') {
    const matches = data.players.filter((player) => player.name === event.user_name);
    if (matches.length === 1) return matches[0].id;
  }
}

function upperBound<T extends { tick: number }>(items: T[], tick: number) {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Build once from global events, independent of loaded trajectory/frame slices.
 * The 12-second pairing bound is a conservative association budget, not grenade physics. */
export function buildReviewPrompts(
  data: Playback,
  selected: string,
  first: number,
  last: number,
): ReviewPromptIndex {
  const rate = data.tickRate;
  const result: ReviewPromptIndex = { kills: [], landings: [], first, last, windowTicks: 6 * rate };
  const known = new Set(data.players.map((player) => player.id));
  if (
    !selected ||
    !known.has(selected) ||
    !validTick(first) ||
    !validTick(last) ||
    last < first ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 1024
  )
    return result;
  const rounds = [
    ...new Set(
      data.rounds
        .map((round) => round.tick)
        .filter((tick) => validTick(tick) && tick >= first && tick <= last),
    ),
  ]
    .map((tick) => ({ tick }))
    .sort(order);
  const bounds = (tick: number) => {
    const next = upperBound(rounds, tick);
    return {
      start: next ? rounds[next - 1].tick : first,
      end: next < rounds.length ? rounds[next].tick - 1 : last,
    };
  };
  for (const event of roundEvents(
    data,
    { number: 0, start: first, end: last },
    selected,
    'player',
  )) {
    if (event.type !== 'kill') continue;
    const round = bounds(event.tick);
    const startTick = Math.max(first, round.start, Math.floor(event.tick - 3 * rate));
    const endTick = Math.min(last, round.end, Math.ceil(event.tick + 2 * rate));
    if (endTick <= startTick) continue;
    result.kills.push({
      kind: 'kill',
      id: 'kill:' + event.id,
      tick: event.tick,
      startTick,
      endTick,
      weapon: event.weapon,
      target: event.target,
      attackerId: selected,
    });
  }

  const releases: Release[] = [],
    detonations: Detonation[] = [];
  const seenDetonations = new Set<string>();
  for (const [index, event] of data.events.entries()) {
    if (
      !validTick(event.tick) ||
      event.tick < first ||
      event.tick > last ||
      owner(event, data, known) !== selected
    )
      continue;
    const entity = entityId(event);
    if (entity === null) continue;
    const weapon = typeof event.weapon === 'string' ? equipmentKey(event.weapon) : '';
    const utility = utilityKinds[weapon];
    if ((event.type === 'grenade_thrown' || event.type === 'weapon_fire') && utility) {
      const round = bounds(event.tick);
      releases.push({
        id: `${event.tick}:${event.type}:${index}`,
        tick: event.tick,
        weapon,
        utility,
        entity,
        origin:
          point(event, ['x', 'y', 'z']) ||
          point(event, ['user_X', 'user_Y', 'user_Z']) ||
          point(event, ['user_x', 'user_y', 'user_z']) ||
          point(event, ['X', 'Y', 'Z']),
        roundStart: round.start,
        roundEnd: round.end,
        explicit: event.type === 'grenade_thrown',
      });
    }
    const kind = detonationKinds[event.type];
    const target = kind && (point(event, ['x', 'y', 'z']) || point(event, ['X', 'Y', 'Z']));
    if (kind && target) {
      const fingerprint = `${event.tick}:${kind}:${entity || ''}:${target.x}:${target.y}:${target.z}`;
      if (!seenDetonations.has(fingerprint)) {
        seenDetonations.add(fingerprint);
        detonations.push({ tick: event.tick, utility: kind, entity, point: target });
      }
    }
  }
  // Native weapon_fire and grenade_thrown may describe the same exact release.
  // Separate explicit throws, or differing recorded entities, remain separate.
  const explicit = new Map<string, { unknownEntity: boolean; entities: Set<string> }>();
  for (const release of releases)
    if (release.explicit) {
      const key = `${release.tick}:${release.weapon}`;
      let group = explicit.get(key);
      if (!group) explicit.set(key, (group = { unknownEntity: false, entities: new Set() }));
      if (release.entity) group.entities.add(release.entity);
      else group.unknownEntity = true;
    }
  const exactSeen = new Set<string>();
  const unique = releases
    .sort((a, b) => order(a, b) || Number(b.explicit) - Number(a.explicit))
    .filter((release) => {
      const counterpart = explicit.get(`${release.tick}:${release.weapon}`);
      if (
        !release.explicit &&
        counterpart &&
        (!release.entity || counterpart.unknownEntity || counterpart.entities.has(release.entity))
      )
        return false;
      if (!release.entity) return true;
      const key = `${release.tick}:${release.weapon}:${release.entity}`;
      if (exactSeen.has(key)) return false;
      exactSeen.add(key);
      return true;
    });
  const groups = new Map<UtilityKind, Release[]>();
  for (const release of unique) {
    let group = groups.get(release.utility);
    if (!group) groups.set(release.utility, (group = []));
    group.push(release);
  }
  const terminalGroups = new Map<UtilityKind, Detonation[]>();
  const entityReleases = new Map<string, Release[]>();
  const entityTerminals = new Map<string, Detonation[]>();
  for (const release of unique)
    if (release.entity) {
      const key = `${release.utility}:${release.entity}`;
      let group = entityReleases.get(key);
      if (!group) entityReleases.set(key, (group = []));
      group.push(release);
    }
  for (const terminal of detonations.sort(order)) {
    let group = terminalGroups.get(terminal.utility);
    if (!group) terminalGroups.set(terminal.utility, (group = []));
    group.push(terminal);
    if (terminal.entity) {
      const key = `${terminal.utility}:${terminal.entity}`;
      let exact = entityTerminals.get(key);
      if (!exact) entityTerminals.set(key, (exact = []));
      exact.push(terminal);
    }
  }
  const blockedReleases = new Set<string>(),
    blockedTerminals = new Set<Detonation>();
  const exactEndpoints = new Map<string, Detonation>();
  for (const [key, group] of entityReleases) {
    const terminals = entityTerminals.get(key) || [];
    for (const [position, release] of group.entries()) {
      const endTick = Math.min(
        release.roundEnd,
        release.tick + 12 * rate,
        (group[position + 1]?.tick ?? Infinity) - 1,
      );
      const begin = upperBound(terminals, release.tick - 1),
        end = upperBound(terminals, endTick);
      if (end - begin === 1) exactEndpoints.set(release.id, terminals[begin]);
      else if (end - begin > 1) {
        blockedReleases.add(release.id);
        for (let index = begin; index < end; index++) blockedTerminals.add(terminals[index]);
      }
    }
  }
  // A future exact entity endpoint outranks an earlier owner-only terminal.
  // Remaining ambiguous lifetimes cannot choose the first of several endpoints.
  const reserved = new Set(exactEndpoints.values());
  for (const [kind, group] of groups) {
    const unresolved = group.filter(
      (release) => !exactEndpoints.has(release.id) && !blockedReleases.has(release.id),
    );
    const terminals = terminalGroups.get(kind) || [];
    for (const [position, release] of unresolved.entries()) {
      const endTick = Math.min(
        release.roundEnd,
        release.tick + 12 * rate,
        (unresolved[position + 1]?.tick ?? Infinity) - 1,
      );
      const begin = upperBound(terminals, release.tick - 1),
        end = upperBound(terminals, endTick);
      const possible = terminals
        .slice(begin, end)
        .filter(
          (terminal) =>
            !reserved.has(terminal) &&
            !blockedTerminals.has(terminal) &&
            !(release.entity && terminal.entity && release.entity !== terminal.entity),
        );
      if (possible.length > 1) {
        blockedReleases.add(release.id);
        for (const terminal of possible) blockedTerminals.add(terminal);
      }
    }
  }
  const used = new Set<string>(),
    ambiguous = new Set<string>();
  for (const detonation of detonations.sort(order)) {
    if (blockedTerminals.has(detonation)) continue;
    const group = groups.get(detonation.utility) || [];
    const end = upperBound(group, detonation.tick);
    const begin = upperBound(group, detonation.tick - 12 * rate - 1);
    // Corrupt/dense event bursts must not create quadratic work or guessed associations.
    if (end - begin > 128) continue;
    const candidates = group
      .slice(begin, end)
      .filter(
        (release) =>
          !used.has(release.id) &&
          !blockedReleases.has(release.id) &&
          (!exactEndpoints.has(release.id) || exactEndpoints.get(release.id) === detonation) &&
          release.roundEnd >= detonation.tick &&
          !(release.entity && detonation.entity && release.entity !== detonation.entity),
      );
    const exact = candidates.filter(
      (release) => release.entity && release.entity === detonation.entity,
    );
    const release =
      exact.length === 1
        ? exact[0]
        : exact.length === 0 && candidates.length === 1 && !ambiguous.has(candidates[0].id)
          ? candidates[0]
          : undefined;
    if (!release) {
      for (const candidate of candidates) ambiguous.add(candidate.id);
      continue;
    }
    used.add(release.id);
    const startTick = Math.max(first, release.roundStart, Math.floor(release.tick - rate / 4));
    const endTick = Math.min(last, release.roundEnd, Math.ceil(detonation.tick + 2 * rate));
    if (endTick <= startTick) continue;
    result.landings.push({
      kind: 'landing',
      id: 'landing:' + release.id,
      tick: release.tick,
      startTick,
      endTick,
      weapon: release.weapon,
      throwerId: selected,
      target: detonation.point,
      origin: release.origin,
      impactTick: detonation.tick,
      source: 'recorded-detonation',
      association: exact.length ? 'entity-id' : 'unambiguous-owner',
    });
  }
  result.kills.sort(order);
  result.landings.sort(order);
  return result;
}

/** Stateless clock lookup: backward/forward seeks and player changes leave no stale prompt. */
export function reviewPromptsAt(
  index: ReviewPromptIndex,
  tick: number,
): { kill: KillPrompt | null; landing: LandingPrompt | null } {
  if (!Number.isFinite(tick) || tick < index.first || tick > index.last)
    return { kill: null, landing: null };
  const latest = <T extends { tick: number }>(items: T[]) => {
    const value = items[upperBound(items, tick) - 1];
    return value && tick < value.tick + index.windowTicks ? value : null;
  };
  return { kill: latest(index.kills), landing: latest(index.landings) };
}
