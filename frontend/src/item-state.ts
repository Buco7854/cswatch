import type { ItemSample, ItemStateInfo } from '../../shared/item-state';
import registry from '../../shared/recorded-equipment.json' with { type: 'json' };

export type PresentItem = Extract<ItemSample, { present: true }>;
export type ItemIndex = ReadonlyMap<string, readonly ItemSample[]>;

/** Category evidence stays independent of unrelated missing native entity properties. */
export function hasRecordedProjectiles(data: {
  itemState?: { complete: boolean; coverage: { projectile: boolean } };
}) {
  return data.itemState?.coverage.projectile === true;
}
export function validateItemState(value: unknown): ItemStateInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Replay item metadata is invalid.');
  const info = value as Record<string, unknown>;
  if (
    typeof info.complete !== 'boolean' ||
    Object.keys(info).some((key) => key !== 'complete' && key !== 'coverage')
  )
    throw new Error('Replay item metadata is invalid.');
  if (
    !info.coverage ||
    typeof info.coverage !== 'object' ||
    Array.isArray(info.coverage) ||
    Object.keys(info.coverage).some((key) => !['dropped', 'planted', 'projectile'].includes(key)) ||
    !['dropped', 'planted', 'projectile'].every(
      (key) => typeof (info.coverage as Record<string, unknown>)[key] === 'boolean',
    )
  )
    throw new Error('Replay item metadata is invalid.');
  const coverage = info.coverage as Record<string, boolean>;
  if (info.complete !== (coverage.dropped && coverage.planted && coverage.projectile))
    throw new Error('Replay item metadata is invalid.');
  return value as ItemStateInfo;
}

const knownEquipment = new Set<string>([...Object.values(registry.definitions), 'plantedc4']);
const utilities = new Set([
  'flashbang',
  'hegrenade',
  'smokegrenade',
  'molotov',
  'incgrenade',
  'decoy',
]);
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;

/** Validate optional streamed world-item evidence before indexing it. */
export function validateItemSamples(value: unknown, lastTick: number): ItemSample[] {
  if (!Array.isArray(value) || value.length > 50000) throw new Error('Replay items are invalid.');
  const identities = new Map<string, { equipment: string; kind: string; tick: number }>();
  const live = new Set<string>();
  let previousTick = -1;
  return value.map((entry): ItemSample => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Replay items are invalid.');
    const sample = entry as Record<string, unknown>;
    if (
      typeof sample.id !== 'string' ||
      !/^item:\d{1,5}:\d{1,6}:\d{1,7}$/.test(sample.id) ||
      !Number.isSafeInteger(sample.tick) ||
      (sample.tick as number) < 0 ||
      (sample.tick as number) > lastTick ||
      (sample.tick as number) > 691200 ||
      (sample.tick as number) < previousTick ||
      typeof sample.present !== 'boolean'
    )
      throw new Error('Replay items are invalid.');
    const [index, serial, created] = sample.id.slice(5).split(':').map(Number);
    if (index >= 16383 || serial > 131071 || created > 691200 || created > (sample.tick as number))
      throw new Error('Replay items are invalid.');
    previousTick = sample.tick as number;
    const identity = identities.get(sample.id);
    if (identity?.tick === sample.tick) throw new Error('Replay items are invalid.');
    if (!sample.present) {
      if (
        !identity ||
        !live.has(sample.id) ||
        Object.keys(sample).some((key) => !['id', 'tick', 'present'].includes(key))
      )
        throw new Error('Replay items are invalid.');
      identity.tick = sample.tick as number;
      live.delete(sample.id);
      return { id: sample.id, tick: sample.tick as number, present: false };
    }
    if (
      typeof sample.equipment !== 'string' ||
      !knownEquipment.has(sample.equipment) ||
      !['dropped', 'planted', 'projectile'].includes(sample.kind as string) ||
      (sample.kind === 'planted') !== (sample.equipment === 'plantedc4') ||
      (sample.kind === 'projectile' && !utilities.has(sample.equipment)) ||
      !coordinate(sample.x) ||
      !coordinate(sample.y) ||
      !coordinate(sample.z) ||
      (identity && (identity.equipment !== sample.equipment || identity.kind !== sample.kind)) ||
      Object.keys(sample).some(
        (key) =>
          ![
            'id',
            'tick',
            'present',
            'equipment',
            'kind',
            'x',
            'y',
            'z',
            'pitch',
            'yaw',
            'roll',
          ].includes(key),
      )
    )
      throw new Error('Replay items are invalid.');
    const angles = ['pitch', 'yaw', 'roll'] as const;
    const recordedAngles = angles.some((key) => sample[key] !== undefined);
    if (recordedAngles && !angles.every((key) => coordinate(sample[key])))
      throw new Error('Replay items are invalid.');
    identities.set(sample.id, {
      equipment: sample.equipment,
      kind: sample.kind as string,
      tick: sample.tick as number,
    });
    live.add(sample.id);
    if (live.size > 128) throw new Error('Replay items are invalid.');
    return {
      id: sample.id,
      tick: sample.tick as number,
      present: true,
      equipment: sample.equipment,
      kind: sample.kind as PresentItem['kind'],
      x: sample.x,
      y: sample.y,
      z: sample.z,
      ...(recordedAngles
        ? { pitch: sample.pitch as number, yaw: sample.yaw as number, roll: sample.roll as number }
        : {}),
    };
  });
}

/** Build once per streamed slice. Serial-aware entity IDs keep pickup/drop lifetimes separate. */
export function indexItems(samples: readonly ItemSample[] = []): ItemIndex {
  const items = new Map<string, ItemSample[]>();
  for (const sample of samples) {
    const timeline = items.get(sample.id);
    if (timeline) timeline.push(sample);
    else items.set(sample.id, [sample]);
  }
  return items;
}
const angleAt = (from: number, to: number, alpha: number) =>
  from + (((((to - from) % 360) + 540) % 360) - 180) * alpha;

/** The parser omits unchanged four-tick samples. Hold those poses up to the last
 * sampling interval before the next change, including when a chunk starts with a carry. */
export function itemsAt(index: ItemIndex, tick: number): PresentItem[] {
  if (!Number.isFinite(tick)) return [];
  const live: PresentItem[] = [];
  for (const samples of index.values()) {
    let low = 0,
      high = samples.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (samples[middle].tick <= tick) low = middle + 1;
      else high = middle;
    }
    const from = samples[low - 1];
    if (!from?.present) continue;
    const next = samples[low];
    if (!next?.present || next.equipment !== from.equipment || next.kind !== from.kind) {
      live.push(from);
      continue;
    }
    const start = Math.max(from.tick, next.tick - 4);
    if (tick <= start) {
      live.push(from);
      continue;
    }
    const alpha = (tick - start) / (next.tick - start);
    live.push({
      ...from,
      x: from.x + (next.x - from.x) * alpha,
      y: from.y + (next.y - from.y) * alpha,
      z: from.z + (next.z - from.z) * alpha,
      ...(from.pitch !== undefined && next.pitch !== undefined
        ? {
            pitch: angleAt(from.pitch, next.pitch, alpha),
            yaw: angleAt(from.yaw!, next.yaw!, alpha),
            roll: angleAt(from.roll!, next.roll!, alpha),
          }
        : {}),
    });
  }
  return live;
}

/** Source inches/Z-up to the viewer's meters/Y-up. Item rotations are recorded Euler angles. */
export function itemPose(item: Pick<PresentItem, 'x' | 'y' | 'z' | 'pitch' | 'yaw' | 'roll'>) {
  const radians = Math.PI / 180;
  return {
    position: [item.x * 0.0254, item.z * 0.0254, -item.y * 0.0254] as [number, number, number],
    // Source Rz(yaw) Ry(pitch) Rx(roll) becomes viewer Ry(yaw) Rz(-pitch) Rx(roll).
    // Apply this tuple with Euler order YZX, not the default XYZ order.
    rotation:
      item.pitch === undefined
        ? null
        : ([item.roll! * radians, item.yaw! * radians, -item.pitch * radians] as [
            number,
            number,
            number,
          ]),
  };
}
