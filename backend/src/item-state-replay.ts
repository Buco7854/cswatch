import { z } from 'zod';
import type { ItemSample, PresentItemSample } from '../../shared/item-state.js';
import { itemStateLimits, recordedEquipmentKeys } from './item-state.js';

const tick = z
  .number()
  .int()
  .min(0)
  .max(64 * 60 * 180);
const id = z
  .string()
  .regex(/^item:\d{1,5}:\d{1,6}:\d{1,7}$/)
  .refine((value) => {
    const [, index, serial, created] = value.split(':').map(Number);
    return index < 16383 && serial <= 131071 && created <= 64 * 60 * 180;
  });
const coordinate = z
  .number()
  .finite()
  .min(-itemStateLimits.coordinate)
  .max(itemStateLimits.coordinate);
const equipment = z.enum(recordedEquipmentKeys as [string, ...string[]]);
export const itemSampleSchema = z.discriminatedUnion('present', [
  z.object({ id, tick, present: z.literal(false) }).strict(),
  z
    .object({
      id,
      tick,
      present: z.literal(true),
      equipment,
      kind: z.enum(['dropped', 'planted', 'projectile']),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      pitch: coordinate.optional(),
      yaw: coordinate.optional(),
      roll: coordinate.optional(),
    })
    .strict()
    .refine(
      (value) =>
        [value.pitch, value.yaw, value.roll].filter((angle) => angle !== undefined).length % 3 ===
          0 &&
        (value.kind === 'planted'
          ? value.equipment === 'plantedc4'
          : value.equipment !== 'plantedc4') &&
        (value.kind !== 'projectile' ||
          ['flashbang', 'hegrenade', 'smokegrenade', 'decoy', 'molotov', 'incgrenade'].includes(
            value.equipment,
          )),
    ),
]);
export const itemChunkSampleLimit = 50000;
const signature = (sample: PresentItemSample) => `${sample.kind}:${sample.equipment}`;
const same = (a: ItemSample, b: ItemSample) => JSON.stringify(a) === JSON.stringify(b);

function upperBound(samples: readonly ItemSample[], tick: number) {
  let low = 0,
    high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Advance only once per chunk; adaptive byte sizing reuses the prepared carry. */
export class ItemSliceIndex {
  private cursor = 0;
  private live = new Map<string, PresentItemSample>();
  constructor(private readonly samples: readonly ItemSample[]) {
    if (samples.length > itemStateLimits.samples) throw new Error('Recorded item sample limit');
  }
  from(start: number) {
    while (this.cursor < this.samples.length && this.samples[this.cursor].tick <= start) {
      const sample = this.samples[this.cursor++];
      if (sample.present) this.live.set(sample.id, sample);
      else this.live.delete(sample.id);
    }
    const carry = [...this.live.values()].sort(
      (a, b) => a.tick - b.tick || a.id.localeCompare(b.id),
    );
    const offset = this.cursor;
    return (end: number): ItemSample[] => [
      ...carry,
      ...this.samples.slice(offset, upperBound(this.samples, end)),
    ];
  }
}

/** Validates immutable identities, ordering, carry and real tombstones across overlapping chunks. */
export class ItemArtifactValidator {
  private histories = new Map<string, { identity: string; samples: ItemSample[] }>();
  private count = 0;
  private previousEnd: number | undefined;
  validate(samples: readonly ItemSample[], first: number, end: number, last: number) {
    if (samples.length > itemChunkSampleLimit) throw new Error('Recorded item chunk limit');
    const expected = new Map<string, ItemSample>();
    for (const [id, history] of this.histories) {
      const index = upperBound(history.samples, first) - 1;
      const sample = history.samples[index];
      if (sample?.present) expected.set(id, sample);
    }
    const carried = new Set<string>();
    const perEntityTick = new Map<string, number>();
    let previousTick = -1;
    for (const sample of samples) {
      if (
        sample.tick < previousTick ||
        sample.tick > end ||
        sample.tick > last ||
        sample.tick < Number(sample.id.split(':')[3]) ||
        (perEntityTick.get(sample.id) ?? -1) >= sample.tick
      )
        throw new Error('Invalid recorded item time');
      previousTick = sample.tick;
      perEntityTick.set(sample.id, sample.tick);
      if (sample.tick <= first) {
        if (!sample.present || carried.has(sample.id))
          throw new Error('Invalid recorded item carry');
        carried.add(sample.id);
        const previous = expected.get(sample.id);
        if (this.previousEnd !== undefined && (!previous || !same(sample, previous)))
          throw new Error('Recorded item carry mismatch');
      }
      let history = this.histories.get(sample.id);
      if (!history) {
        if (!sample.present || (this.previousEnd !== undefined && sample.tick <= this.previousEnd))
          throw new Error('Unknown recorded item identity');
        history = { identity: signature(sample), samples: [] };
        this.histories.set(sample.id, history);
      }
      if (sample.present && history.identity !== signature(sample))
        throw new Error('Changed recorded item identity');
      const index = upperBound(history.samples, sample.tick) - 1;
      const previous = history.samples[index];
      if (previous?.tick === sample.tick) {
        if (!same(previous, sample)) throw new Error('Recorded item overlap mismatch');
        continue;
      }
      if (this.previousEnd !== undefined && sample.tick <= this.previousEnd)
        throw new Error('Unproven recorded item overlap');
      if (!sample.present && !previous?.present) throw new Error('Invalid recorded item tombstone');
      if (++this.count > itemStateLimits.samples) throw new Error('Recorded item sample limit');
      history.samples.push(sample);
    }
    for (const id of expected.keys())
      if (!carried.has(id)) throw new Error('Missing recorded item carry');
    // Live limits are independent of chunk context/history length.
    const changes = samples.filter((sample) => sample.tick > first);
    const live = new Set(carried);
    if (live.size > itemStateLimits.active) throw new Error('Recorded live item limit');
    for (const sample of changes) {
      if (sample.present) live.add(sample.id);
      else live.delete(sample.id);
      if (live.size > itemStateLimits.active) throw new Error('Recorded live item limit');
    }
    this.previousEnd = end;
  }
}
