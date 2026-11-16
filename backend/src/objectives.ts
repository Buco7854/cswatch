import type { DemoReader } from 'cs2parser';
import type { ObjectiveData, ObjectiveSample } from '../../shared/objectives.js';

export const objectiveSampleLimit = 10000;
const validTick = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 64 * 60 * 180;
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const duration = (value: unknown) => {
  const result = number(value);
  return result !== undefined && result > 0 && result <= 10800 ? result : undefined;
};

/** Demo/network handles have 14 index bits + 10 serial bits, unlike native CEntityHandle.
 * https://github.com/LaihoE/demoparser/blob/dd71c09b32fb7ada7597bd83390a2ec3d3cd3812/src/parser/src/entity_handle.rs
 */
export function networkHandle(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff ||
    value === 0xffffff ||
    value === 0xffffffff
  )
    return;
  return value >>> 0;
}
export function objectiveDeadline(
  absolute: unknown,
  tick: number,
  serverTick: number | undefined,
  interval: number | undefined,
  rate: number,
) {
  const end = number(absolute);
  if (
    end === undefined ||
    end <= 0 ||
    serverTick === undefined ||
    interval === undefined ||
    interval <= 0 ||
    interval > 1
  )
    return;
  const result = tick + (end - serverTick * interval) * rate;
  return Number.isFinite(result) && result >= 0 && result <= 64 * 60 * 360 ? result : undefined;
}

/** Watches only C4 state; the reader itself owns one streaming entity world, not per-tick copies. */
export function observeObjectives(reader: DemoReader, tickRate: number, lastTick: number) {
  const samples: ObjectiveSample[] = [];
  const tracked = new Map<
    number,
    { kind: 'plant' | 'bomb'; entity: string; serial?: number; previous?: string }
  >();
  const controllers = new Set<number>();
  let serverTick: number | undefined,
    serverDemoTick: number | undefined,
    interval: number | undefined,
    truncated = false;
  const append = (sample: ObjectiveSample) => {
    if (samples.length >= objectiveSampleLimit) {
      truncated = true;
      return;
    }
    samples.push(sample);
  };
  const actorFor = (value: unknown) => {
    const handle = networkHandle(value);
    if (handle === undefined) return;
    for (const id of controllers) {
      const properties = reader.entities[id]?.properties as Record<string, unknown> | undefined;
      if (!properties || networkHandle(properties['CCSPlayerController.m_hPlayerPawn']) !== handle)
        continue;
      const raw = properties['CCSPlayerController.m_steamID'];
      if (typeof raw === 'number' && !Number.isSafeInteger(raw)) return;
      const actor = String(raw ?? '');
      if (/^\d{1,20}$/.test(actor) && actor !== '0') return actor;
    }
  };
  reader.on('serverinfo', (message) => {
    const value = number(message.tick_interval);
    if (value !== undefined && value > 0 && value <= 1) interval = value;
  });
  reader.on('net_Tick', (message) => {
    if (
      typeof message.tick === 'number' &&
      Number.isSafeInteger(message.tick) &&
      message.tick >= 0 &&
      message.tick <= 0xffffffff &&
      validTick(reader.currentTick)
    ) {
      serverTick = message.tick;
      serverDemoTick = reader.currentTick;
    }
  });
  reader.on('entitycreated', ([id, _classId, _type, className, serial]) => {
    if (className === 'CCSPlayerController' && controllers.size < 128) controllers.add(id);
    if (className !== 'CC4' && className !== 'CPlantedC4') return;
    if (!validTick(reader.currentTick) || reader.currentTick > lastTick || tracked.size >= 64) {
      truncated = true;
      return;
    }
    const kind = className === 'CC4' ? 'plant' : 'bomb';
    const previous = tracked.get(id);
    if (previous && previous.serial === serial && previous.kind === kind) return;
    if (previous)
      append({
        kind: previous.kind,
        entity: previous.entity,
        tick: reader.currentTick,
        present: false,
      });
    tracked.set(id, { kind, serial, entity: `${kind}:${id}:${serial ?? 0}:${reader.currentTick}` });
  });
  reader.on('entitydeleted', (id) => {
    controllers.delete(id);
    const previous = tracked.get(id);
    if (!previous) return;
    if (validTick(reader.currentTick) && reader.currentTick <= lastTick)
      append({
        kind: previous.kind,
        entity: previous.entity,
        tick: reader.currentTick,
        present: false,
      });
    tracked.delete(id);
  });
  // Entity properties can be written directly by WASM without entityupdated callbacks.
  // Read the few current objective fields at tick end and retain only changed state.
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (!validTick(tick) || tick > lastTick || truncated) return;
    if (interval === undefined && tick > 0) {
      const value = reader.currentTime / tick;
      if (Number.isFinite(value) && value > 0 && value <= 1) interval = value;
    }
    for (const [id, entry] of tracked) {
      const properties = reader.entities[id]?.properties as Record<string, unknown> | undefined;
      if (!properties) continue;
      const prefix = entry.kind === 'plant' ? 'CC4.' : 'CPlantedC4.';
      const get = (key: string) => properties[prefix + key];
      let sample: ObjectiveSample;
      if (entry.kind === 'plant') {
        sample = { kind: 'plant', entity: entry.entity, tick, present: true };
        if (typeof get('m_bStartedArming') === 'boolean')
          sample.arming = get('m_bStartedArming') as boolean;
        const actor = actorFor(get('m_hOwnerEntity'));
        const endTick = objectiveDeadline(
          get('m_fArmedTime'),
          serverDemoTick ?? tick,
          serverTick,
          interval,
          tickRate,
        );
        if (actor) sample.actor = actor;
        if (endTick !== undefined) sample.endTick = endTick;
      } else {
        sample = { kind: 'bomb', entity: entry.entity, tick, present: true };
        for (const [field, property] of [
          ['m_bBombTicking', 'ticking'],
          ['m_bBeingDefused', 'beingDefused'],
          ['m_bBombDefused', 'defused'],
          ['m_bHasExploded', 'exploded'],
        ] as const)
          if (typeof get(field) === 'boolean') sample[property] = get(field) as boolean;
        const actor = actorFor(get('m_hBombDefuser'));
        if (actor) sample.actor = actor;
        const site = get('m_nBombSite');
        if (site === 0 || site === 1) sample.site = site;
        const endTick = objectiveDeadline(
          get('m_flC4Blow'),
          serverDemoTick ?? tick,
          serverTick,
          interval,
          tickRate,
        );
        if (endTick !== undefined) sample.endTick = endTick;
        const defuseEndTick = objectiveDeadline(
          get('m_flDefuseCountDown'),
          serverDemoTick ?? tick,
          serverTick,
          interval,
          tickRate,
        );
        if (defuseEndTick !== undefined) sample.defuseEndTick = defuseEndTick;
        const fuseDuration = duration(get('m_flTimerLength'));
        if (fuseDuration !== undefined) sample.duration = fuseDuration;
        const defuseDuration = duration(get('m_flDefuseLength'));
        if (defuseDuration !== undefined) sample.defuseDuration = defuseDuration;
      }
      const { tick: _tick, ...values } = sample;
      const serialized = JSON.stringify(values);
      if (serialized !== entry.previous) {
        append(sample);
        entry.previous = serialized;
      }
    }
  });
  return (complete: boolean): ObjectiveData => ({
    samples: samples.sort((a, b) => a.tick - b.tick),
    complete: complete && !truncated,
  });
}
