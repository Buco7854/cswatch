import { decodeSmokeVoxelFrame, decodeSmokeVoxelJournal, type DemoReader } from 'cs2parser';
import type { SmokeTrack } from '../../shared/smoke-state.mjs';
import { smokeLimits, validSmokeTracks } from './smoke-state-wire.js';

const prefix = 'CSmokeGrenadeProjectile.';
const integer = (value: unknown, lower: number, upper: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= lower && value <= upper;
const triple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
type Capture = {
  serial: number;
  updates: SmokeTrack['updates'];
  journal: Uint8Array;
  frames: number;
  invalid?: boolean;
  origin?: SmokeTrack['origin'];
  color?: SmokeTrack['color'];
};

/** Keep only the networked journal and its recorded arrival times. No simulation runs during parse. */
export function observeSmokeTracks(reader: DemoReader, lastTick: number, rate: number) {
  const active = new Map<number, Capture>();
  const finished: SmokeTrack[] = [];
  let updates = 0,
    bytes = 0,
    admitted = 0;
  function retire(entity: number, tick: number) {
    const capture = active.get(entity);
    active.delete(entity);
    if (!capture?.origin || !capture.color || capture.invalid || !capture.updates.length) return;
    const start = capture.updates[0][0];
    const last = capture.updates.at(-1)![0];
    if (tick <= last) return;
    finished.push({
      entity,
      serial: capture.serial,
      start,
      // Projectile entities can remain in late-start recordings long after their
      // smoke journal stops advancing. Expire stale volume state independently.
      end: Math.min(tick, last + Math.max(1, Math.floor(rate / 2)) + 1),
      origin: capture.origin,
      color: capture.color,
      journal: Buffer.from(capture.journal).toString('base64'),
      updates: capture.updates,
    });
  }
  reader.on('entitycreated', ([entity, , , name, serial]) => {
    if (name !== 'CSmokeGrenadeProjectile') return;
    retire(entity, reader.currentTick);
    if (
      admitted >= smokeLimits.tracks ||
      active.size >= smokeLimits.active ||
      !integer(entity, 0, 16382) ||
      !integer(serial, 0, 131071)
    )
      return;
    admitted++;
    active.set(entity, { serial, updates: [], journal: new Uint8Array(), frames: 0 });
  });
  reader.on('entitydeleted', (entity) => retire(entity, reader.currentTick));
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (!integer(tick, 0, lastTick) || (reader.header?.patch_version ?? 0) <= 13963) return;
    for (const [entity, capture] of active) {
      if (capture.invalid) continue;
      const props = reader.entities[entity]?.properties as Record<string, unknown> | undefined;
      const data = props?.[prefix + 'm_VoxelFrameData'];
      if (
        !(data instanceof Uint8Array) ||
        !data.length ||
        props?.[prefix + 'm_bDidSmokeEffect'] !== true
      )
        continue;
      const count = props?.[prefix + 'm_nVoxelFrameDataSize'] ?? data.length;
      if (count === 0) continue;
      const origin = props?.[prefix + 'm_vSmokeDetonationPos'];
      const color = props?.[prefix + 'm_vSmokeColor'];
      if (
        !integer(count, 1, Math.min(data.length, smokeLimits.journalBytes)) ||
        !triple(origin) ||
        !origin.every((axis) => Math.abs(axis) <= smokeLimits.coordinate) ||
        !triple(color) ||
        !color.every((channel) => integer(channel, 0, 255))
      )
        continue;
      if (
        count < capture.journal.length ||
        !capture.journal.every((byte, index) => byte === data[index]) ||
        (capture.origin && !capture.origin.every((axis, index) => axis === origin[index])) ||
        (capture.color && !capture.color.every((channel, index) => channel === color[index])) ||
        (capture.updates.at(-1)?.[0] ?? -1) > tick
      ) {
        capture.invalid = true;
        continue;
      }
      if (count === capture.journal.length) continue;
      const added = count - capture.journal.length;
      if (updates >= smokeLimits.updates || bytes + added > smokeLimits.recordingsBytes) {
        capture.invalid = true;
        continue;
      }
      try {
        const delta = decodeSmokeVoxelJournal(data.subarray(capture.journal.length, count));
        let index = capture.frames;
        for (const frame of delta) {
          if (
            frame.seq !== index++ ||
            index > smokeLimits.frames ||
            (!frame.isHeartbeat && decodeSmokeVoxelFrame(frame.payload).extraRecords.length)
          )
            throw new Error('Unsupported smoke journal');
        }
        capture.frames = index;
        capture.origin = [...origin];
        capture.color = [...color];
        capture.journal = data.slice(0, count);
        const previous = capture.updates.at(-1);
        if (previous?.[0] === tick) previous[1] = count;
        else capture.updates.push([tick, count]);
        updates++;
        bytes += added;
      } catch {
        capture.invalid = true;
      }
    }
  });
  return (complete: boolean) => {
    for (const entity of active.keys())
      retire(entity, complete ? lastTick + 1 : Math.min(lastTick + 1, reader.currentTick));
    finished.sort((a, b) => a.start - b.start);
    return finished.length && validSmokeTracks(finished, lastTick) ? finished : undefined;
  };
}
