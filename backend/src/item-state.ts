import type { DemoReader } from 'cs2parser';
import { readFileSync } from 'node:fs';
import type { ItemSample, PresentItemSample } from '../../shared/item-state.js';

export const itemStateLimits = { samples: 250000, active: 128, coordinate: 1e7 } as const;
/** Item definition indices are recorded economy identities, not names inferred from events. */
const definitions: Readonly<Record<number, string>> = JSON.parse(
  readFileSync(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../../shared/recorded-equipment.json'
        : './recorded-equipment.json',
      import.meta.url,
    ),
    'utf8',
  ),
).definitions;
export const recordedEquipmentKeys = Object.freeze([
  ...new Set(Object.values(definitions)),
  'plantedc4',
]);
export function equipmentForDefinition(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? definitions[value] : undefined;
}
const projectileClasses: Readonly<Record<string, string>> = {
  CFlashbangProjectile: 'flashbang',
  CHEGrenadeProjectile: 'hegrenade',
  CSmokeGrenadeProjectile: 'smokegrenade',
  CDecoyProjectile: 'decoy',
  CMolotovProjectile: 'molotov',
};
const isProjectile = (name: string) => Object.hasOwn(projectileClasses, name);
const itemClasses = new Set([
  'CAK47',
  'CDEagle',
  'CC4',
  'CKnife',
  'CHEGrenade',
  'CFlashbang',
  'CSmokeGrenade',
  'CMolotovGrenade',
  'CIncendiaryGrenade',
  'CDecoyGrenade',
  'CWeaponAug',
  'CWeaponAWP',
  'CWeaponBizon',
  'CWeaponCZ75a',
  'CWeaponElite',
  'CWeaponFamas',
  'CWeaponFiveSeven',
  'CWeaponG3SG1',
  'CWeaponGalilAR',
  'CWeaponGlock',
  'CWeaponHKP2000',
  'CWeaponM249',
  'CWeaponM4A1',
  'CWeaponM4A1Silencer',
  'CWeaponMAC10',
  'CWeaponMag7',
  'CWeaponMP5SD',
  'CWeaponMP7',
  'CWeaponMP9',
  'CWeaponNegev',
  'CWeaponNOVA',
  'CWeaponP250',
  'CWeaponP90',
  'CWeaponRevolver',
  'CWeaponSawedoff',
  'CWeaponSCAR20',
  'CWeaponSG556',
  'CWeaponSSG08',
  'CWeaponTaser',
  'CWeaponTec9',
  'CWeaponUMP45',
  'CWeaponUSPSilencer',
  'CWeaponXM1014',
]);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const validTick = (tick: number, last: number) =>
  Number.isSafeInteger(tick) && tick >= 0 && tick <= last && tick <= 64 * 60 * 180;
const round = (value: number) => Math.round(value * 100) / 100;

/** Requires every recorded cell/offset component. Missing origins never become map origin. */
export function recordedEntityTransform(
  properties: Record<string, unknown>,
  className: string,
  body = 'CBodyComponentBaseAnimGraph',
) {
  const root = `${className}.${body}.m_skeletonInstance.`;
  const parent = properties[`${root}m_hParent`];
  // Local transforms under an actual parent need that parent's matrix. Never treat them as world coordinates.
  if (
    typeof parent !== 'number' ||
    !Number.isSafeInteger(parent) ||
    parent < 0 ||
    parent > 0xffffffff ||
    (parent & 16383) !== 16383
  )
    return;
  const axes = ['X', 'Y', 'Z'].map((axis) => {
    const cell = properties[`${root}m_vecOrigin.m_cell${axis}`];
    const offset = properties[`${root}m_vecOrigin.m_vec${axis}`];
    if (
      !finite(cell) ||
      !Number.isSafeInteger(cell) ||
      cell < 0 ||
      cell > 0xffff ||
      !finite(offset)
    )
      return;
    const value = cell * 512 - 16384 + offset;
    return Math.abs(value) <= itemStateLimits.coordinate ? value : undefined;
  });
  if (!axes.every((value) => value !== undefined)) return;
  const angles = properties[`${root}m_angRotation`];
  const rotation =
    Array.isArray(angles) &&
    angles.length === 3 &&
    angles.every((angle) => finite(angle) && Math.abs(angle) <= 1e7)
      ? { pitch: angles[0], yaw: angles[1], roll: angles[2] }
      : {};
  return { x: axes[0]!, y: axes[1]!, z: axes[2]!, ...rotation };
}

export function itemTransform(properties: Record<string, unknown>, className: string) {
  const pose = recordedEntityTransform(properties, className);
  if (!pose) return;
  return {
    x: round(pose.x),
    y: round(pose.y),
    z: round(pose.z),
    ...(pose.pitch !== undefined
      ? { pitch: round(pose.pitch), yaw: round(pose.yaw!), roll: round(pose.roll!) }
      : {}),
  };
}

/** One existing streaming entity world supplies real ownership and lifecycle evidence. */
export function observeItemState(reader: DemoReader, lastTick: number) {
  const samples: ItemSample[] = [];
  const tracked = new Map<
    number,
    {
      id: string;
      className: string;
      previous?: PresentItemSample;
      identity?: string;
      ended: boolean;
    }
  >();
  const coverage = { dropped: true, planted: true, projectile: true };
  const markPartial = (kind?: PresentItemSample['kind']) => {
    if (kind) coverage[kind] = false;
    else coverage.dropped = coverage.planted = coverage.projectile = false;
  };
  let stopped = false;
  let pendingTick: number | undefined;
  const pending = new Map<string, ItemSample>();
  const committedLive = new Set<string>();
  const flush = () => {
    for (const sample of pending.values()) {
      if (!sample.present && !committedLive.has(sample.id)) continue;
      if (samples.length >= itemStateLimits.samples) {
        markPartial();
        stopped = true;
        break;
      }
      samples.push(sample);
      if (sample.present) committedLive.add(sample.id);
      else committedLive.delete(sample.id);
    }
    pending.clear();
  };
  const append = (sample: ItemSample) => {
    if (pendingTick !== undefined && pendingTick !== sample.tick) flush();
    pendingTick = sample.tick;
    if (!sample.present && !committedLive.has(sample.id)) {
      pending.delete(sample.id);
      return;
    }
    pending.set(sample.id, sample);
  };
  const hide = (entry: { id: string; previous?: PresentItemSample }, tick: number) => {
    if (entry.previous) append({ id: entry.id, tick, present: false });
    entry.previous = undefined;
  };
  const stop = (tick: number) => {
    markPartial();
    stopped = true;
    for (const entry of tracked.values()) hide(entry, tick);
  };
  reader.on('entitycreated', ([index, _classId, _type, className, serial]) => {
    if (!itemClasses.has(className) && !isProjectile(className) && className !== 'CPlantedC4')
      return;
    const tick = reader.currentTick;
    if (stopped || !validTick(tick, lastTick)) return;
    const previous = tracked.get(index);
    if (previous?.id === `item:${index}:${serial}:${tick}` && previous.className === className)
      return;
    if (previous) hide(previous, tick);
    tracked.delete(index);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= 16383 ||
      !Number.isSafeInteger(serial) ||
      serial! < 0 ||
      serial! > 131071 ||
      tracked.size >= itemStateLimits.active
    ) {
      markPartial(
        tracked.size >= itemStateLimits.active
          ? undefined
          : isProjectile(className)
            ? 'projectile'
            : className === 'CPlantedC4'
              ? 'planted'
              : 'dropped',
      );
      return;
    }
    tracked.set(index, { id: `item:${index}:${serial}:${tick}`, className, ended: false });
  });
  reader.on('entitydeleted', (index) => {
    const previous = tracked.get(index);
    if (previous && validTick(reader.currentTick, lastTick)) hide(previous, reader.currentTick);
    tracked.delete(index);
  });
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (stopped || !validTick(tick, lastTick)) return;
    if (samples.length + pending.size >= itemStateLimits.samples - 2 * itemStateLimits.active) {
      stop(tick);
      return;
    }
    for (const [index, entry] of tracked) {
      const properties = reader.entities[index]?.properties as Record<string, unknown> | undefined;
      const get = (field: string) => properties?.[`${entry.className}.${field}`];
      let equipment: string | undefined, kind: PresentItemSample['kind'];
      if (isProjectile(entry.className)) {
        kind = 'projectile';
        if (
          (finite(get('m_nExplodeEffectTickBegin')) &&
            (get('m_nExplodeEffectTickBegin') as number) > 0) ||
          (finite(get('m_nSmokeEffectTickBegin')) && (get('m_nSmokeEffectTickBegin') as number) > 0)
        )
          entry.ended = true;
        equipment = projectileClasses[entry.className];
        if (entry.className === 'CMolotovProjectile') {
          const incendiary = get('m_bIsIncGrenade');
          equipment =
            typeof incendiary === 'boolean' ? (incendiary ? 'incgrenade' : 'molotov') : undefined;
        }
      } else if (entry.className === 'CPlantedC4') {
        kind = 'planted';
        equipment = 'plantedc4';
        if (get('m_bHasExploded') === true) entry.ended = true;
      } else {
        kind = 'dropped';
        const owner = get('m_hOwnerEntity');
        // A known invalid network handle is positive ownerless evidence. Unknown is not dropped.
        if (
          typeof owner !== 'number' ||
          !Number.isSafeInteger(owner) ||
          owner < 0 ||
          owner > 0xffffffff ||
          (owner & 16383) !== 16383
        ) {
          if (
            typeof owner !== 'number' ||
            !Number.isSafeInteger(owner) ||
            owner < 0 ||
            owner > 0xffffffff
          )
            markPartial('dropped');
          hide(entry, tick);
          continue;
        }
        equipment = equipmentForDefinition(get('m_AttributeManager.m_Item.m_iItemDefinitionIndex'));
      }
      if (entry.ended) {
        hide(entry, tick);
        continue;
      }
      const transform = properties && itemTransform(properties, entry.className);
      if (!equipment || !transform) {
        markPartial(kind);
        hide(entry, tick);
        continue;
      }
      const identity = `${kind}:${equipment}`;
      if (entry.identity && entry.identity !== identity) {
        markPartial(kind);
        entry.ended = true;
        hide(entry, tick);
        continue;
      }
      entry.identity = identity;
      if (transform.pitch === undefined) markPartial(kind);
      const next: PresentItemSample = {
        id: entry.id,
        tick,
        present: true,
        equipment,
        kind,
        ...transform,
      };
      // Capture appearances immediately, then at the same 16 Hz cadence as players.
      if (entry.previous && tick % 4 !== 0) continue;
      const { tick: _next, ...nextState } = next;
      const { tick: _previous, ...previousState } = entry.previous || {};
      if (JSON.stringify(nextState) !== JSON.stringify(previousState)) {
        append(next);
        entry.previous = next;
      }
    }
  });
  return (complete: boolean) => {
    if (!complete) stop(Math.min(lastTick, Math.max(0, reader.currentTick)));
    return {
      samples: [
        ...samples,
        ...[...pending.values()].filter((sample) => sample.present || committedLive.has(sample.id)),
      ].sort((a, b) => a.tick - b.tick),
      complete: complete && Object.values(coverage).every(Boolean),
      coverage: { ...coverage },
    };
  };
}
