import type { DemoReader } from 'cs2parser';
import type { GameEvent } from '../../shared/playback.js';
import type { MapDoor, MapPropPose } from '../../shared/map-breakables.mjs';
import { doorKey, doorLimits } from './map-breakables-wire.js';
import { recordedEntityTransform } from './item-state.js';

const className = 'CPropDoorRotating';
const prefix = className + '.';
const skeleton = prefix + 'CBodyComponentBaseAnimGraph.m_skeletonInstance.';
const modelField = skeleton + 'm_modelState.m_hModel';
const rotationField = skeleton + 'm_angRotation';
const axes = ['X', 'Y', 'Z'] as const;
const cellFields = axes.map((a) => skeleton + 'm_vecOrigin.m_cell' + a);
const offsetFields = axes.map((a) => skeleton + 'm_vecOrigin.m_vec' + a);
const delta = (a: number, b: number) => ((((a - b + 180) % 360) + 360) % 360) - 180;
const vector = (v: unknown, bound: number): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n) && Math.abs(n) <= bound);
const modelId = (v: unknown): v is bigint =>
  typeof v === 'bigint' && v > 0n && v <= 0xffffffffffffffffn;

type Door = MapDoor & { owner?: Lifetime; missingSince?: number };
type Lifetime = {
  serial: number;
  door?: Door;
  checked?: Record<string, unknown>;
  yaw?: number;
  model?: bigint;
  movingSince?: number;
  state?: bigint;
};

/** Read the replicated rigid hinge at its authored closed pivot. Never use a
 * sound, nearby hit or missing entity to infer opening or damage. */
export function observeMapDoors(reader: DemoReader, lastTick: number, events: GameEvent[]) {
  const active = new Map<number, Lifetime>(),
    tracks = new Map<string, Door>(),
    ambiguous = new Set<Door>();
  const rounds = [
    ...new Set(
      events
        .filter(
          (e) =>
            e.type === 'round_start' &&
            Number.isSafeInteger(e.tick) &&
            e.tick >= 0 &&
            e.tick <= lastTick,
        )
        .map((e) => e.tick),
    ),
  ].sort((a, b) => a - b);
  let count = 0,
    nextRound = 0,
    broadcast = false,
    stopped = false;
  reader.on('serverinfo', (message) => {
    if (message.is_hltv === true) broadcast = true;
    else stopped = true;
  });
  const clock = (t: number) => Number.isSafeInteger(t) && t >= 0 && t <= lastTick;
  function append<T>(values: [number, T | null][], tick: number, value: T | null) {
    const prev = values.at(-1);
    if (prev?.[0] === tick) {
      values.pop();
      count--;
    }
    if ((values.at(-1)?.[1] ?? null) === value) return;
    if (++count > doorLimits.samples) {
      stopped = true;
      return;
    }
    values.push([tick, value]);
  }
  function release(life: Lifetime, tick: number) {
    const door = life.door;
    if (door?.owner === life) {
      append(door.samples, tick, null);
      if (door.models) append(door.models, tick, null);
      delete door.owner;
    }
    delete life.door;
    delete life.checked;
    delete life.movingSince;
  }
  function closeHidden(door: Door, tick: number) {
    const start = door.missingSince;
    delete door.missingSince;
    if (start === undefined || tick <= start) return;
    if (++count > doorLimits.samples) {
      stopped = true;
      return;
    }
    door.hidden.push([start, tick]);
  }
  function resetUntil(tick: number) {
    while (nextRound < rounds.length && rounds[nextRound] <= tick) {
      const reset = rounds[nextRound++];
      for (const life of active.values()) release(life, reset);
      active.clear();
      for (const door of tracks.values()) closeHidden(door, reset);
    }
  }
  reader.on('entitycreated', ([index, , , name, serial]) => {
    const tick = reader.currentTick;
    if (stopped || !clock(tick)) return;
    resetUntil(tick);
    const old = active.get(index);
    if (old && old.serial === serial && name === className) {
      // Full snapshots and reentries repopulate the property bag.
      delete old.checked;
      return;
    }
    if (old) release(old, tick);
    active.delete(index);
    if (
      name !== className ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index > 16382 ||
      serial === undefined ||
      !Number.isSafeInteger(serial) ||
      serial < 0 ||
      serial > 131071
    )
      return;
    if (active.size >= doorLimits.active) {
      stopped = true;
      return;
    }
    active.set(index, { serial });
  });
  reader.on('entitydeleted', (index) => {
    const life = active.get(index),
      tick = reader.currentTick;
    if (stopped || !life || !clock(tick)) return;
    resetUntil(tick);
    if (life.door?.owner === life && life.checked && rounds[nextRound - 1] !== tick)
      life.door.missingSince = tick;
    release(life, tick);
    active.delete(index);
  });
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (stopped || !broadcast || !clock(tick)) return;
    resetUntil(tick);
    for (const [index, life] of active) {
      const entity = reader.entities[index],
        p: Record<string, unknown> | undefined = entity?.properties;
      if (!p || entity?.className !== className) {
        release(life, tick);
        continue;
      }
      const currentModel = p[modelField],
        angle = p[rotationField],
        rest = p[prefix + 'm_closedAngles'],
        pivot = p[prefix + 'm_closedPosition'],
        state = p[prefix + 'm_eDoorState'];
      const door = life.door,
        parent = p[skeleton + 'm_hParent'];
      if (
        !modelId(currentModel) ||
        !vector(angle, 3600) ||
        !vector(rest, 3600) ||
        !vector(pivot, 1e7) ||
        (state !== 0n && state !== 1n && state !== 2n && state !== 3n) ||
        p[skeleton + 'm_flScale'] !== 1 ||
        typeof parent !== 'number' ||
        !Number.isSafeInteger(parent) ||
        parent < 0 ||
        parent > 0xffffffff ||
        (parent & 16383) !== 16383 ||
        Math.abs(delta(angle[0], rest[0])) > 0.01 ||
        Math.abs(delta(angle[2], rest[2])) > 0.01
      ) {
        release(life, tick);
        continue;
      }
      if (
        door &&
        (!pivot.every((n, i) => n === door.origin[i]) ||
          !rest.every((n, i) => n === door.angles[i]))
      ) {
        ambiguous.add(door);
        release(life, tick);
        continue;
      }
      // Cell/local coordinates are quantized to 1/32 Source inch. Identity is
      // the separate, full-precision closedPosition, never this distance check.
      if (
        !axes.every((_, i) => {
          const cell = p[cellFields[i]],
            offset = p[offsetFields[i]];
          return (
            typeof cell === 'number' &&
            Number.isSafeInteger(cell) &&
            cell >= 0 &&
            cell <= 65535 &&
            typeof offset === 'number' &&
            Math.abs(cell * 512 - 16384 + offset - pivot[i]) <= 1 / 32
          );
        })
      ) {
        release(life, tick);
        continue;
      }
      const yaw = delta(angle[1], rest[1]);
      if (
        door &&
        life.checked === p &&
        life.model === currentModel &&
        life.yaw === yaw &&
        life.state === state
      ) {
        // Never extrapolate a partially observed swing through a gap.
        if (life.movingSince !== undefined && tick > life.movingSince + 1) {
          append(door.samples, life.movingSince + 1, null);
          delete life.movingSince;
        }
        continue;
      }
      if (!life.door) {
        if (!recordedEntityTransform(p, className)) continue;
        const pose: MapPropPose = {
          modelId: String(currentModel),
          origin: [...pivot],
          angles: [...rest],
        };
        const key = doorKey(pose);
        if (!key) continue;
        let found = tracks.get(key);
        if (!found) {
          if (tracks.size >= doorLimits.tracks) {
            stopped = true;
            return;
          }
          found = { ...pose, samples: [], hidden: [] };
          tracks.set(key, found);
        }
        if (
          (found.owner && found.owner !== life) ||
          !found.angles.every((n, i) => Math.abs(delta(n, rest[i])) <= 0.01)
        )
          ambiguous.add(found);
        closeHidden(found, tick);
        found.owner = life;
        life.door = found;
      }
      const found = life.door;
      if (yaw !== 0 || found.samples.at(-1)?.[1] != null) append(found.samples, tick, yaw);
      const model = String(currentModel);
      if (model !== found.modelId || found.models)
        append((found.models ??= []), tick, model === found.modelId ? null : model);
      life.checked = p;
      life.yaw = yaw;
      life.model = currentModel;
      life.state = state;
      life.movingSince = state === 1n || state === 3n ? tick : undefined;
    }
  });
  return (complete: boolean): MapDoor[] | undefined => {
    if (!complete || !broadcast || stopped) return;
    resetUntil(lastTick);
    const result: MapDoor[] = [];
    for (const door of tracks.values()) {
      closeHidden(door, lastTick + 1);
      if (stopped) return;
      if (
        ambiguous.has(door) ||
        (!door.hidden.length &&
          !door.samples.some(([, yaw]) => yaw !== null && yaw !== 0) &&
          !door.models?.length)
      )
        continue;
      const { owner: _owner, missingSince: _start, ...track } = door;
      result.push(track);
    }
    return result.length ? result : undefined;
  };
}
