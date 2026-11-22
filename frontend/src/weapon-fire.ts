import registry from '../../shared/equipment-models.json' with { type: 'json' };
import { canonicalEquipmentKey } from './equipment-key';
import type { Playback, Position } from './types';

type RecordedShot = { tick: number; weapon: string };
export type WeaponFireIndex = ReadonlyMap<string, readonly RecordedShot[]>;
type WeaponFireState = {
  tick: number;
  /** Demo seconds since the recorded shot, never wall-clock time. */
  age: number;
  flash: number;
  /** A deliberately analytical attachment kick, not a recorded native pose. */
  kick: number;
};
export type WeaponPoseSample = { age: number; weight: number };
const firearms = new Set(
  Object.entries(registry.items)
    .filter(([id, item]) => item.kind === 'weapon' && id !== 'taser')
    .map(([id]) => id),
);

/** The manifest's recorded event list is global, so shots survive chunk changes.
 * Real recordings require immutable IDs. Names are only usable by the labeled
 * original practice scene, matching the rest of the review domain. */
export function indexWeaponFire(
  data: Pick<Playback, 'events' | 'players' | 'sample'>,
): WeaponFireIndex {
  const result = new Map<string, RecordedShot[]>(),
    players = new Set(data.players.map((player) => player.id));
  for (const event of data.events) {
    if (event.type !== 'weapon_fire' || !Number.isSafeInteger(event.tick) || event.tick < 0)
      continue;
    const weapon = typeof event.weapon === 'string' ? canonicalEquipmentKey(event.weapon) : '';
    if (!firearms.has(weapon)) continue;
    let id = event.user_steamid;
    if ((typeof id !== 'string' || !players.has(id) || id === '0') && data.sample) {
      const matches = data.players.filter((player) => player.name === event.user_name);
      if (matches.length === 1) id = matches[0].id;
    }
    if (typeof id !== 'string' || id === '0' || !players.has(id)) continue;
    const shots = result.get(id) || [];
    shots.push({ tick: event.tick, weapon });
    result.set(id, shots);
  }
  for (const shots of result.values()) shots.sort((a, b) => a.tick - b.tick);
  return result;
}

/** Stateless sampling makes pause, backward seeking, speed changes and identity
 * retirement deterministic. Input attack/reload flags never create shots. */
export function recentWeaponShot(
  index: WeaponFireIndex,
  player: Pick<Position, 'id' | 'alive' | 'weapon'>,
  tick: number,
  tickRate: number,
  duration: number,
) {
  if (!player.alive || !Number.isFinite(tick) || !Number.isFinite(tickRate) || tickRate <= 0)
    return;
  const shots = index.get(player.id);
  if (!shots?.length) return;
  const shot = shots[shotIndex(shots, tick)];
  if (!shot || shot.weapon !== canonicalEquipmentKey(player.weapon)) return;
  const age = (tick - shot.tick) / tickRate;
  if (age < 0 || age >= duration) return;
  return { ...shot, age };
}

function shotIndex(shots: readonly RecordedShot[], tick: number) {
  let low = 0,
    high = shots.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (shots[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function ease(value: number) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/** Short authored-pose blends at recorded action boundaries. The previous
 * shot is sampled at the same replay tick, including after a backward seek. */
export function nativeWeaponPose(
  index: WeaponFireIndex,
  player: Pick<Position, 'id' | 'alive' | 'weapon' | 'reloadStarted'>,
  tick: number,
  rate: number,
  fireDuration: number,
  reloadDuration: number,
  shotsEnabled: boolean,
): { fire?: WeaponPoseSample; priorFire?: WeaponPoseSample; reload?: WeaponPoseSample } {
  if (!player.alive || !Number.isFinite(tick) || !Number.isFinite(rate) || rate <= 0) return {};
  const reload = player.reloadStarted;
  const shot = shotsEnabled && recentWeaponShot(index, player, tick, rate, fireDuration);
  if (shot && (reload === undefined || shot.tick >= reload)) {
    const entry = Math.min(0.032, fireDuration / 4);
    const tail = Math.min(0.09, fireDuration / 4);
    const incoming = ease(shot.age / entry);
    const fire = { age: shot.age, weight: incoming * ease((fireDuration - shot.age) / tail) };
    const list = index.get(player.id)!;
    const prior = incoming < 1 ? list[shotIndex(list, tick) - 1] : undefined;
    if (
      prior?.weapon === shot.weapon &&
      prior.tick < shot.tick &&
      (reload === undefined || prior.tick >= reload)
    ) {
      const age = (tick - prior.tick) / rate;
      if (age < fireDuration)
        return {
          fire,
          priorFire: {
            age,
            weight: (1 - incoming) * ease(age / entry) * ease((fireDuration - age) / tail),
          },
        };
    }
    return { fire };
  }
  if (reload === undefined) return {};
  const age = (tick - reload) / rate;
  return age >= 0 && age < reloadDuration
    ? { reload: { age, weight: ease(age / 0.065) * ease((reloadDuration - age) / 0.11) } }
    : {};
}

export function weaponFireAt(
  index: WeaponFireIndex,
  player: Pick<Position, 'id' | 'alive' | 'weapon'>,
  tick: number,
  tickRate: number,
  reducedMotion = false,
): WeaponFireState | undefined {
  const shot = recentWeaponShot(index, player, tick, tickRate, 0.14);
  if (!shot) return;
  const { age } = shot;
  // Suppressed weapons retain a small, restrained flash. This does not infer
  // a suppressor switch that the recording did not expose.
  const suppressed = ['m4a1silencer', 'uspsilencer', 'mp5sd'].includes(shot.weapon);
  return {
    tick: shot.tick,
    age,
    flash: age < 0.055 ? (1 - age / 0.055) * (suppressed ? 0.23 : 1) : 0,
    kick: reducedMotion
      ? 0
      : Math.exp(-age * 28) * Math.sin((Math.min(1, age / 0.025) * Math.PI) / 2),
  };
}
