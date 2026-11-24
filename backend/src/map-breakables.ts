import type { DemoReader } from 'cs2parser';
import type { GameEvent } from '../../shared/playback.js';
import type { MapBreakable } from '../../shared/map-breakables.mjs';
import { breakableKey, breakableLimits, breakablePoseCodec } from './map-breakables-wire.js';
import { recordedEntityTransform } from './item-state.js';

const bodies = {
  CDynamicProp: 'CBodyComponentBaseAnimGraph',
  CBreakable: 'CBodyComponentBaseModelEntity',
  CFuncBrush: 'CBodyComponentBaseModelEntity',
} as const;
type RecordedClass = keyof typeof bodies;
const skeletonRoot = (name: RecordedClass) => `${name}.${bodies[name]}.m_skeletonInstance.`;
function poseFieldsFor(skeleton: string) {
  return new Map([
    [skeleton + 'm_angRotation', 'angle'],
    ...['X', 'Y', 'Z'].flatMap((axis): [string, string][] => [
      [skeleton + 'm_vecOrigin.m_cell' + axis, 'cell'],
      [skeleton + 'm_vecOrigin.m_vec' + axis, 'offset'],
    ]),
  ]);
}
const poseFields = {
  CDynamicProp: poseFieldsFor(skeletonRoot('CDynamicProp')),
  CBreakable: poseFieldsFor(skeletonRoot('CBreakable')),
  CFuncBrush: poseFieldsFor(skeletonRoot('CFuncBrush')),
};

/** Read the decoder table carried by THIS recording. The cs2parser 2.8 decoder
 * IDs 10 and 20 select unsigned varint and qangle_precise respectively. */
export function hasWirePoseCodec(reader: DemoReader, className: RecordedClass) {
  const fields = poseFields[className];
  const names = reader.propIdToName,
    decoders = reader.propIdToDecoder;
  if (!names || !decoders) return false;
  const seen = new Set<string>();
  let inspected = 0;
  for (const id in names) {
    if (++inspected > 131072) return false;
    const name = names[id]!,
      kind = fields.get(name);
    if (!kind) continue;
    const decoder = decoders[id];
    if ((kind === 'cell' && decoder !== 10) || (kind === 'angle' && decoder !== 20)) return false;
    if (kind === 'offset') {
      if (!decoder || typeof decoder !== 'object' || decoder.type !== 0) return false;
      const q = decoder.decoder;
      if (
        q.no_scale ||
        q.bit_count !== 15 ||
        q.low !== 0 ||
        q.high !== 1023.96875 ||
        q.high_low_mul !== 32 ||
        q.dec_mul !== 1 / 32767 ||
        q.flags !== 0 ||
        q.offset !== 1 / 32
      )
        return false;
    }
    seen.add(name);
  }
  return seen.size === fields.size;
}

export function mapEntityPose(
  props: Record<string, unknown>,
  className: RecordedClass,
): Omit<MapBreakable, 'hidden'> | undefined {
  const skeleton = skeletonRoot(className);
  const model = props[skeleton + 'm_modelState.m_hModel'];
  if (
    typeof model !== 'bigint' ||
    model <= 0n ||
    model > 0xffffffffffffffffn ||
    props[skeleton + 'm_flScale'] !== 1
  )
    return;
  const pose = recordedEntityTransform(props, className, bodies[className]);
  if (!pose || pose.pitch === undefined || pose.yaw === undefined || pose.roll === undefined)
    return;
  return {
    modelId: String(model),
    ...(className === 'CBreakable' ? { className: 'func_breakable' as const } : {}),
    origin: [pose.x, pose.y, pose.z],
    angles: [pose.pitch, pose.yaw, pose.roll],
  };
}

type Lifetime = {
  className: RecordedClass;
  born: number;
  serial: number;
  key?: string;
  props?: Record<string, unknown>;
};
type Track = MapBreakable & { owner?: Lifetime; brushReset?: number; missingSince?: number };

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
  let decoderTable: DemoReader['propIdToDecoder'] | undefined;
  const supportedCodecs = new Set<RecordedClass>(['CDynamicProp', 'CBreakable']);
  const roundStarts = new Set(resets);
  let tables = 0;
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
    if (previous && name === previous.className && serial === previous.serial) {
      pending.add(index);
      return;
    }
    if (previous) forget(previous);
    active.delete(index);
    pending.delete(index);
    if (
      (name !== 'CDynamicProp' && name !== 'CBreakable') ||
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
    active.set(index, { serial, className: name, born: reader.currentTick });
    pending.add(index);
  });
  reader.on('tickend', () => {
    if (stopped) return;
    if (supportedCodecs.size && active.size && reader.propIdToDecoder !== decoderTable) {
      decoderTable = reader.propIdToDecoder;
      tables++;
      for (const className of supportedCodecs)
        if (tables > 8 || !hasWirePoseCodec(reader, className)) supportedCodecs.delete(className);
    }
    if (!pending.size) return;
    const tick = reader.currentTick;
    for (const index of pending) {
      const life = active.get(index),
        e = reader.entities[index];
      if (
        !life ||
        !e ||
        e.className !== life.className ||
        !Number.isSafeInteger(tick) ||
        tick < 0 ||
        tick > lastTick
      )
        continue;
      const pose = mapEntityPose(e.properties, life.className),
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
      if (life.className === 'CBreakable') {
        // Round reset creates a new glass instance while the old network entity can
        // survive until a later snapshot or deletion. Only the new round can own it.
        if (track.brushReset !== undefined && life.born < track.brushReset) continue;
        if (roundStarts.has(life.born)) {
          track.brushReset = life.born;
          if (track.owner && track.owner.born < life.born) delete track.owner;
        }
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
    if (breakableKey(mapEntityPose(life.props, life.className)) === life.key)
      track.missingSince = tick;
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
          ...(track.className ? { className: track.className } : {}),
          ...(tables && supportedCodecs.has(track.className ? 'CBreakable' : 'CDynamicProp')
            ? { poseCodec: breakablePoseCodec }
            : {}),
        });
    }
    return result.length ? result : undefined;
  };
}
