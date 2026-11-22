import type { DemoReader } from 'cs2parser';
import type {
  InfernoBank,
  InfernoDelta,
  InfernoPoint,
  InfernoTrack,
  InfernoUpdate,
} from '../../shared/inferno-state.mjs';
import { infernoLimits, infernoUpdateBytes, validInfernoBank } from './inferno-state-wire.js';

const prefix = 'CInferno.';
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function point(value: unknown): value is InfernoPoint {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    [value[0], value[1], value[2]].every(
      (axis) => Number.isFinite(axis) && Math.abs(axis) <= infernoLimits.coordinate,
    )
  );
}

function slotChanges(props: Record<string, unknown>, previous: (InfernoPoint | undefined)[]) {
  const count = props[prefix + 'm_fireCount'];
  const positions = props[prefix + 'm_firePositions'];
  const flags = props[prefix + 'm_bFireIsBurning'];
  if (
    !integer(count, 0, infernoLimits.slots) ||
    !Array.isArray(positions) ||
    positions.length !== infernoLimits.slots ||
    !Array.isArray(flags) ||
    flags.length !== infernoLimits.slots
  )
    return;
  const changes: InfernoDelta[] = [];
  for (let slot = 0; slot < infernoLimits.slots; slot++) {
    const flag = flags[slot];
    if (typeof flag !== 'boolean' || (flag && slot >= count)) return;
    const before = previous[slot];
    if (!flag) {
      if (before) changes.push([slot]);
      continue;
    }
    const position = positions[slot];
    if (!point(position)) return;
    const x = Math.round(position[0] * infernoLimits.scale);
    const y = Math.round(position[1] * infernoLimits.scale);
    const z = Math.round(position[2] * infernoLimits.scale);
    if (!before || x !== before[0] || y !== before[1] || z !== before[2])
      changes.push([slot, x, y, z]);
  }
  return changes;
}

type Capture = {
  serial: number;
  slots: (InfernoPoint | undefined)[];
  updates: InfernoUpdate[];
  bytes: number;
};

/** Read only exact CInferno network fields during the confined media pass. */
export function observeInfernos(reader: DemoReader, lastTick: number) {
  const active = new Map<number, Capture>();
  const tracks: InfernoTrack[] = [];
  let bytes = 0;
  let updates = 0;
  let started = 0;

  function retire(entity: number, tick: number) {
    const capture = active.get(entity);
    active.delete(entity);
    if (!capture?.updates.length || tick <= capture.updates.at(-1)![0]) return;
    tracks.push({
      entity,
      serial: capture.serial,
      end: Math.min(tick, lastTick + 1),
      updates: capture.updates,
    });
  }

  reader.on('entitycreated', ([entity, , , name, serial]) => {
    if (!integer(entity, 0, 16382)) return;
    // Full snapshots can re-announce the same live entity and serial.
    if (name === 'CInferno' && serial !== undefined && active.get(entity)?.serial === serial)
      return;
    retire(entity, reader.currentTick);
    if (
      name === 'CInferno' &&
      integer(serial, 0, 131071) &&
      active.size < infernoLimits.active &&
      started < infernoLimits.tracks
    )
      active.set(entity, { serial, slots: [], updates: [], bytes: infernoLimits.trackOverhead });
  });
  reader.on('entitydeleted', (entity) => retire(entity, reader.currentTick));
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (!integer(tick, 0, lastTick)) return;
    for (const [entity, capture] of active) {
      const props = reader.entities[entity]?.properties;
      const changes = props && slotChanges(props, capture.slots);
      if (!changes) {
        if (capture.updates.length || !props) retire(entity, tick);
        continue;
      }
      if (!changes.length) continue;
      const first = capture.updates.length === 0;
      const update: InfernoUpdate = [tick, changes];
      const added = infernoUpdateBytes(update);
      const cost = added + (first ? infernoLimits.trackOverhead : 0);
      if (
        (first && started >= infernoLimits.tracks) ||
        (capture.updates.at(-1)?.[0] ?? -1) >= tick ||
        capture.updates.length >= infernoLimits.trackUpdates ||
        updates >= infernoLimits.updates ||
        capture.bytes + added > infernoLimits.trackBytes ||
        bytes + cost > infernoLimits.recordingBytes
      ) {
        retire(entity, tick);
        continue;
      }
      for (const change of changes) {
        capture.slots[change[0]] =
          change.length === 4 ? [change[1], change[2], change[3]] : undefined;
      }
      if (first) started++;
      capture.updates.push(update);
      capture.bytes += added;
      bytes += cost;
      updates++;
    }
  });
  return (complete: boolean): InfernoBank | undefined => {
    const end = complete ? lastTick + 1 : Math.min(lastTick + 1, reader.currentTick);
    for (const entity of active.keys()) retire(entity, end);
    tracks.sort((a, b) => a.updates[0][0] - b.updates[0][0]);
    const bank = { version: 1, tracks };
    return validInfernoBank(bank, lastTick) ? bank : undefined;
  };
}
