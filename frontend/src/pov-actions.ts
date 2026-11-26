import equipment from '../../shared/equipment-models.json';
import { canonicalEquipmentKey } from './equipment-key';
import type { Playback, Position } from './types';

/** First-person actions that the authored rig plays only from recorded evidence:
 * - inspect: the recorded inspect key (IN_LOOK_AT_WEAPON) pressed on the held weapon,
 *   cancelled by a recorded shot, reload or weapon change;
 * - heavy: a recorded knife attack while the secondary attack alone was held;
 * - pullpin: the recorded attack press on a held grenade, until its recorded throw;
 * - plant: the recorded C4 arming of the viewed player. */
export type PovEvidenceAction = { kind: 'inspect' | 'heavy' | 'pullpin' | 'plant'; age: number };

const LOOK_AT_WEAPON = 1n << 35n,
  ATTACK = 1n,
  ATTACK2 = 1n << 11n;
const MAX_SECONDS = 10;

type Kind = (typeof equipment.items)[keyof typeof equipment.items]['kind'];
const kindOf = (weapon: string) =>
  (equipment.items as Record<string, { kind: Kind } | undefined>)[weapon]?.kind;
const heldKey = (position: Pick<Position, 'weapon' | 'team'>) => {
  const key = canonicalEquipmentKey(position.weapon);
  return key === 'knife' && position.team === 2 ? 'knifet' : key;
};

function buttons(position: Position | undefined) {
  const value = position?.input?.buttons;
  if (!value || !/^\d{1,20}$/.test(value)) return 0n;
  return BigInt(value);
}

function latestIndex<T extends { tick: number }>(values: readonly T[], tick: number) {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function indexPovEvidence(data: Pick<Playback, 'events' | 'objectives'>) {
  const fires = new Map<string, { tick: number; weapon: string }[]>();
  for (const event of data.events) {
    if (event.type !== 'weapon_fire' || !event.user_steamid || !event.weapon) continue;
    const list = fires.get(event.user_steamid) ?? [];
    list.push({ tick: event.tick, weapon: canonicalEquipmentKey(event.weapon) });
    fires.set(event.user_steamid, list);
  }
  const plants = new Map<string, { tick: number; end: number }[]>();
  for (const sample of data.objectives?.samples ?? []) {
    if (sample.kind !== 'plant' || !sample.arming || !sample.actor) continue;
    const list = plants.get(sample.actor) ?? [];
    if (list.at(-1)?.end !== sample.endTick)
      list.push({ tick: sample.tick, end: sample.endTick ?? Number.POSITIVE_INFINITY });
    plants.set(sample.actor, list);
  }
  return { fires, plants };
}
export type PovEvidence = ReturnType<typeof indexPovEvidence>;

export function povEvidenceAt(
  evidence: PovEvidence,
  history: Pick<Playback, 'frames' | 'rounds' | 'tickRate'>,
  position: Position,
  tick: number,
): PovEvidenceAction | undefined {
  const rate = history.tickRate;
  if (!position.alive || !(rate > 0)) return;
  const weapon = heldKey(position);
  const kind = kindOf(weapon);
  const roundStart = history.rounds[latestIndex(history.rounds, tick)]?.tick ?? 0;
  const age = (from: number) => (tick - from) / rate;

  const plant = evidence.plants.get(position.id);
  const arming = plant?.[latestIndex(plant, tick)];
  if (weapon === 'c4' && arming && tick < arming.end && arming.tick >= roundStart)
    return { kind: 'plant', age: age(arming.tick) };

  const fires = evidence.fires.get(position.id) ?? [];
  const lastFire = fires[latestIndex(fires, tick)];
  const frames = history.frames;
  const current = latestIndex(frames, tick);
  if (current < 0) return;
  const sampleOf = (index: number) => frames[index]?.players.find(({ id }) => id === position.id);

  if (kind === 'knife' && lastFire && age(lastFire.tick) < 2 && lastFire.tick >= roundStart) {
    const at = latestIndex(frames, lastFire.tick);
    const held = buttons(sampleOf(at));
    if (frames[at] && lastFire.tick - frames[at].tick <= 8 && held & ATTACK2 && !(held & ATTACK))
      return { kind: 'heavy', age: age(lastFire.tick) };
  }

  // Walk back through the recorded samples for the latest rising edge of a key,
  // noting a recorded reload since then.
  const press = (mask: bigint, same: (sample: Position) => boolean) => {
    let reloaded = false;
    for (let i = current; i > 0; i--) {
      if (frames[i].tick < roundStart || age(frames[i].tick) > MAX_SECONDS) return;
      const now = sampleOf(i),
        before = sampleOf(i - 1);
      if (!now || !now.alive || !same(now)) return;
      reloaded ||= now.reloadStarted !== undefined;
      if (buttons(now) & mask && !(buttons(before) & mask))
        return { tick: frames[i].tick, reloaded };
    }
  };
  const sameWeapon = (sample: Position) => heldKey(sample) === weapon;

  if (kind === 'grenade') {
    const pulled = press(ATTACK | ATTACK2, sameWeapon);
    if (pulled && !(lastFire && lastFire.tick >= pulled.tick))
      return { kind: 'pullpin', age: age(pulled.tick) };
    return;
  }

  const inspected = press(LOOK_AT_WEAPON, sameWeapon);
  if (inspected && !inspected.reloaded && !(lastFire && lastFire.tick >= inspected.tick))
    return { kind: 'inspect', age: age(inspected.tick) };
}
