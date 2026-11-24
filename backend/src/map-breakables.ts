import type { DemoReader } from 'cs2parser';
import type { GameEvent } from '../../shared/playback.js';
import type { MapBreakable, MapPropPose } from '../../shared/map-breakables.mjs';
import { breakableKey, breakableLimits } from './map-breakables-wire.js';
import { recordedEntityTransform } from './item-state.js';

const className = 'CDynamicProp';
const skeleton = className + '.CBodyComponentBaseAnimGraph.m_skeletonInstance.';
function identity(props: Record<string, unknown>): MapPropPose | undefined {
  const model = props[skeleton + 'm_modelState.m_hModel'];
  if (
    typeof model !== 'bigint' ||
    model <= 0n ||
    model > 0xffffffffffffffffn ||
    props[skeleton + 'm_flScale'] !== 1
  )
    return;
  const pose = recordedEntityTransform(props, className);
  if (!pose || pose.pitch === undefined || pose.yaw === undefined || pose.roll === undefined)
    return;
  return {
    modelId: String(model),
    origin: [pose.x, pose.y, pose.z],
    angles: [pose.pitch, pose.yaw, pose.roll],
  };
}

type Lifetime = { serial: number; key?: string; props?: Record<string, unknown> };
type Track = MapBreakable & { owner?: Lifetime; missingSince?: number };

/** An explicit network deletion removes a map instance. The reader ignores a mere
 * PVS leave. Resolve with the last live entity's model and unparented transform;
 * an index or even an index+serial alone has no map-authoring identity. */
export function observeMapBreakables(reader: DemoReader, lastTick: number, events: GameEvent[]) {
  const active = new Map<number, Lifetime>(),
    pending = new Set<number>();
  const tracks = new Map<string, Track>(),
    ambiguous = new Set<string>();
  const resets = [
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
  let intervals = 0,
    stopped = false;
  function finishInterval(track: Track, tick: number) {
    const start = track.missingSince;
    delete track.missingSince;
    if (start === undefined) return;
    let left = 0,
      right = resets.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (resets[mid] < start) left = mid + 1;
      else right = mid;
    }
    const end = Math.min(resets[left] ?? lastTick + 1, tick);
    if (end <= start) return;
    if (++intervals > breakableLimits.intervals) {
      stopped = true;
      return;
    }
    track.hidden.push([start, end]);
  }
  function forget(life: Lifetime) {
    const track = life.key && tracks.get(life.key);
    if (track && track.owner === life) delete track.owner;
  }
  reader.on('entitycreated', ([index, , , name, serial]) => {
    if (stopped) return;
    const previous = active.get(index);
    if (name === className && previous && serial === previous.serial) {
      pending.add(index);
      return;
    }
    if (previous) forget(previous);
    active.delete(index);
    pending.delete(index);
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
    if (active.size >= breakableLimits.active) {
      stopped = true;
      return;
    }
    active.set(index, { serial });
    pending.add(index);
  });
  reader.on('tickend', () => {
    if (stopped || !pending.size) return;
    const tick = reader.currentTick;
    for (const index of pending) {
      const life = active.get(index),
        e = reader.entities[index];
      if (
        !life ||
        !e ||
        e.className !== className ||
        !Number.isSafeInteger(tick) ||
        tick < 0 ||
        tick > lastTick
      )
        continue;
      const pose = identity(e.properties),
        key = pose && breakableKey(pose);
      if (!key || !pose || (life.key && life.key !== key)) {
        if (life.key) {
          ambiguous.add(life.key);
          forget(life);
        }
        if (key) ambiguous.add(key);
        if (ambiguous.size > breakableLimits.tracks) {
          stopped = true;
          break;
        }
        life.props = undefined;
        continue;
      }
      let track = tracks.get(key);
      if (!track) {
        if (tracks.size >= breakableLimits.tracks) {
          stopped = true;
          break;
        }
        track = { ...pose, hidden: [] };
        tracks.set(key, track);
      }
      if (track.owner && track.owner !== life) ambiguous.add(key);
      finishInterval(track, tick);
      track.owner = life;
      life.key = key;
      life.props = e.properties;
    }
    pending.clear();
  });
  reader.on('entitydeleted', (index) => {
    if (stopped) return;
    const life = active.get(index),
      tick = reader.currentTick;
    const unconfirmed = pending.delete(index);
    if (!life) return;
    active.delete(index);
    const track = life.key && tracks.get(life.key);
    if (!track || track.owner !== life) return;
    delete track.owner;
    if (!life.props || !Number.isSafeInteger(tick) || tick < 0 || tick > lastTick || unconfirmed)
      return;
    if (breakableKey(identity(life.props)) === life.key) track.missingSince = tick;
  });
  return (complete: boolean): MapBreakable[] | undefined => {
    if (!complete || stopped) return;
    const result: MapBreakable[] = [];
    for (const [key, track] of tracks) {
      if (ambiguous.has(key)) continue;
      finishInterval(track, lastTick + 1);
      if (stopped) return;
      if (track.hidden.length)
        result.push({
          modelId: track.modelId,
          origin: track.origin,
          angles: track.angles,
          hidden: track.hidden,
        });
    }
    return result.length ? result : undefined;
  };
}
