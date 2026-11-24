import type { DemoReader } from 'cs2parser';
import type { MapVisibility } from '../../shared/map-breakables.mjs';
import { breakableKey, breakableLimits, breakablePoseCodec } from './map-breakables-wire.js';
import { hasWirePoseCodec, mapEntityPose } from './map-breakables.js';

const classes = {
  CDynamicProp: 'prop_dynamic',
  CFuncBrush: 'func_brush',
} as const;
type Class = keyof typeof classes;
function fields(name: Class, body: string) {
  const root = name + '.' + body + '.m_skeletonInstance.';
  return [
    root + 'm_modelState.m_hModel',
    root + 'm_hParent',
    root + 'm_flScale',
    ...['X', 'Y', 'Z'].flatMap((axis) => [
      root + 'm_vecOrigin.m_cell' + axis,
      root + 'm_vecOrigin.m_vec' + axis,
    ]),
    root + 'm_angRotation',
  ];
}
const poseFields = {
  CDynamicProp: fields('CDynamicProp', 'CBodyComponentBaseAnimGraph'),
  CFuncBrush: fields('CFuncBrush', 'CBodyComponentBaseModelEntity'),
};
type Life = {
  serial: number;
  name: Class;
  fields: unknown[];
  key?: string;
  track?: MapVisibility;
  visibleSince?: number;
  moved?: boolean;
};

/** Initially-disabled world geometry needs affirmative broadcast evidence to
 * appear. Keep only stationary, unparented, uniquely identified renderables. */
export function observeMapVisibility(reader: DemoReader, last: number) {
  const active = new Map<number, Life>(),
    tracks = new Map<string, MapVisibility>(),
    owners = new Map<string, Life>(),
    ambiguous = new Set<string>();
  const wire = new Set<Class>(['CDynamicProp', 'CFuncBrush']);
  let table: DemoReader['propIdToDecoder'],
    tableChanges = 0;
  let broadcast = false,
    stopped = false,
    intervals = 0;
  const validTick = (t: number) => Number.isSafeInteger(t) && t >= 0 && t <= last;
  function close(life: Life, end: number) {
    const start = life.visibleSince;
    if (life.track && start !== undefined && start < end) {
      const spans = life.track.visible,
        prev = spans.at(-1);
      if (prev?.[1] === start) prev[1] = end;
      else if (++intervals <= breakableLimits.intervals) spans.push([start, end]);
      else stopped = true;
    }
    life.visibleSince = undefined;
  }
  function retire(index: number, tick: number) {
    const life = active.get(index);
    if (!life) return;
    close(life, tick);
    if (life.key && owners.get(life.key) === life) owners.delete(life.key);
    active.delete(index);
  }
  reader.on('serverinfo', (msg) => {
    if (msg.is_hltv === true) broadcast = true;
    else stopped = true;
  });
  reader.on('entitydeleted', (index) => {
    if (!stopped && validTick(reader.currentTick)) retire(index, reader.currentTick);
  });
  reader.on('entitycreated', ([index, , , name, serial]) => {
    if (stopped || !validTick(reader.currentTick)) return;
    const existing = active.get(index);
    if (existing && existing.serial === serial && existing.name === name) return;
    retire(index, reader.currentTick);
    if (name !== 'CDynamicProp' && name !== 'CFuncBrush') return;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 16382 ||
      serial === undefined ||
      !Number.isInteger(serial) ||
      serial < 0 ||
      serial > 131071
    )
      return;
    if (active.size >= breakableLimits.active) {
      stopped = true;
      return;
    }
    active.set(index, { name, serial, fields: [] });
  });
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (stopped || !broadcast || !validTick(tick) || !active.size) return;
    if (reader.propIdToDecoder !== table) {
      table = reader.propIdToDecoder;
      tableChanges++;
      for (const name of wire)
        if (tableChanges > 8 || !hasWirePoseCodec(reader, name)) wire.delete(name);
    }
    for (const [index, life] of active) {
      const { name } = life,
        entity = reader.entities[index];
      const p: Record<string, unknown> | undefined = entity?.properties;
      if (life.moved || !p || entity?.className !== name) {
        close(life, tick);
        continue;
      }
      const effects = p[name + '.m_fEffects'],
        mode = p[name + '.m_nRenderMode'];
      if (
        typeof effects !== 'number' ||
        !Number.isSafeInteger(effects) ||
        effects < 0 ||
        effects > 0xffffffff ||
        (effects & 32) !== 0 ||
        mode !== 0n
      ) {
        close(life, tick);
        continue;
      }
      // Direct decoder updates mutate the same property bag. Compare its small
      // fixed transform instead of reconstructing a pose or key on every tick.
      const keys = poseFields[name],
        rotation = p[keys[keys.length - 1]];
      let changed = life.fields.length === 0;
      for (let i = 0; i < keys.length - 1 && !changed; i++) changed = life.fields[i] !== p[keys[i]];
      const a = keys.length - 1;
      if (!Array.isArray(rotation)) {
        close(life, tick);
        life.fields.length = 0;
        continue;
      }
      if (
        changed ||
        life.fields[a] !== rotation[0] ||
        life.fields[a + 1] !== rotation[1] ||
        life.fields[a + 2] !== rotation[2]
      ) {
        life.fields = keys
          .slice(0, -1)
          .map((k) => p[k])
          .concat(rotation.slice(0, 3));
        const pose = mapEntityPose(p, name);
        const row = pose && {
          ...pose,
          className: classes[name],
          visible: [] as [number, number][],
        };
        const key = row && breakableKey(row);
        if (life.key && life.key !== key) {
          ambiguous.add(life.key);
          life.moved = true;
          close(life, tick);
          continue;
        }
        if (!row || !key) continue;
        let track = tracks.get(key);
        if (!track) {
          if (tracks.size >= breakableLimits.tracks) {
            stopped = true;
            return;
          }
          track = row;
          tracks.set(key, track);
        }
        if (owners.has(key) && owners.get(key) !== life) ambiguous.add(key);
        life.key = key;
        life.track = track;
        owners.set(key, life);
      }
      if (life.track && life.visibleSince === undefined) life.visibleSince = tick;
    }
  });
  return (complete: boolean): MapVisibility[] | undefined => {
    if (!complete || !broadcast || stopped) return;
    for (const life of active.values()) close(life, last + 1);
    if (stopped) return;
    const result: MapVisibility[] = [];
    for (const [key, row] of tracks) {
      if (!row.visible.length || ambiguous.has(key)) continue;
      if (tableChanges && wire.has(row.className === 'func_brush' ? 'CFuncBrush' : 'CDynamicProp'))
        row.poseCodec = breakablePoseCodec;
      result.push(row);
    }
    return result.length ? result : undefined;
  };
}
