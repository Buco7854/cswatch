import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { MapAssets, MapEnvironment, MapOverview } from '../../shared/map-assets';
import { validateMapCubeFog } from './map-fog';

export type AssetStatus = 'pending' | 'ready' | 'missing' | 'error';
export type MapAssetState = { status: AssetStatus; assets: MapAssets; overviewStatus: AssetStatus };
const emptyAssets: MapAssets = Object.freeze({
  model: null,
  mobile: null,
  overview: null,
  environment: null,
});
const missing: MapAssetState = Object.freeze({
  status: 'missing',
  assets: emptyAssets,
  overviewStatus: 'missing',
});
const pending: MapAssetState = Object.freeze({
  status: 'pending',
  assets: emptyAssets,
  overviewStatus: 'missing',
});
type Entry = {
  key: string;
  map: string;
  value: MapAssetState;
  listeners: Set<() => void>;
  members: Set<symbol>;
  controller?: AbortController;
  started: boolean;
};
const entries = new Map<string, Entry>();
const coordinate = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;

/** Accept only the fixed local discovery contract, never arbitrary URLs from a response. */
export function validateMapAssets(value: unknown, map: string): MapAssets {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(map) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new Error('Invalid map assets');
  const input = value as Record<string, unknown>;
  const model = input.model ?? null,
    mobile = input.mobile ?? null;
  if (
    model !== null &&
    model !== `/map-assets/${map}/desktop/scene.glb` &&
    model !== `/map-assets/${map}.glb`
  )
    throw new Error('Invalid map model');
  if (mobile !== null && mobile !== `/map-assets/${map}/mobile/scene.glb`)
    throw new Error('Invalid mobile map model');
  let overview: MapOverview | null = null;
  if (input.overview !== undefined && input.overview !== null) {
    const item = input.overview as Partial<MapOverview>;
    if (
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item.image !== `/api/maps/${map}/overview.png` ||
      !item.origin ||
      !coordinate(item.origin.x) ||
      !coordinate(item.origin.y) ||
      typeof item.scale !== 'number' ||
      !Number.isFinite(item.scale) ||
      item.scale < 0.001 ||
      item.scale > 10000 ||
      item.referenceSize !== 1024 ||
      typeof item.assetVersion !== 'string' ||
      !item.assetVersion.trim() ||
      item.assetVersion.length > 100
    )
      throw new Error('Invalid map overview');
    overview = {
      image: item.image,
      origin: { x: item.origin.x, y: item.origin.y },
      scale: item.scale,
      referenceSize: 1024,
      assetVersion: item.assetVersion,
    };
  }
  let environment: MapEnvironment | null = null;
  if (input.environment !== undefined && input.environment !== null) {
    const item = input.environment as Partial<MapEnvironment>;
    const expected = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
      (face) => `/api/maps/${map}/environment/${face}.png`,
    ) as MapEnvironment['sky']['faces'];
    if (
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.assetVersion !== 'string' ||
      !item.assetVersion.trim() ||
      item.assetVersion.length > 100 ||
      typeof item.landscape !== 'boolean' ||
      !item.sky ||
      !Array.isArray(item.sky.faces) ||
      item.sky.faces.length !== 6 ||
      item.sky.faces.some((face, index) => face !== expected[index]) ||
      typeof item.sky.brightness !== 'number' ||
      !Number.isFinite(item.sky.brightness) ||
      item.sky.brightness < 0 ||
      item.sky.brightness > 16
    )
      throw new Error('Invalid map environment');
    environment = {
      assetVersion: item.assetVersion,
      landscape: item.landscape,
      sky: { faces: expected, brightness: item.sky.brightness },
      ...(item.fog !== undefined ? { fog: validateMapCubeFog(item.fog) } : {}),
    };
  }
  return { model: model as string | null, mobile: mobile as string | null, overview, environment };
}
function publish(entry: Entry, value: MapAssetState) {
  if (entries.get(entry.key) !== entry) return;
  entry.value = value;
  for (const listener of entry.listeners) listener();
}
async function discover(entry: Entry) {
  if (entry.started) return;
  entry.started = true;
  const controller = new AbortController();
  entry.controller = controller;
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/maps/${entry.map}`, {
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Map discovery failed');
    const text = await response.text();
    if (text.length > 16384) throw new Error('Map discovery exceeded its bound');
    const assets = validateMapAssets(JSON.parse(text), entry.map);
    if (controller.signal.aborted || entry.controller !== controller) return;
    publish(entry, {
      status: assets.model || assets.mobile || assets.overview ? 'ready' : 'missing',
      assets,
      overviewStatus: assets.overview ? 'pending' : 'missing',
    });
  } catch {
    if (entries.get(entry.key) === entry && entry.controller === controller && entry.listeners.size)
      publish(entry, { status: 'error', assets: emptyAssets, overviewStatus: 'error' });
  } finally {
    window.clearTimeout(timeout);
    if (entry.controller === controller) entry.controller = undefined;
  }
}
function entryFor(map: string, scope: string) {
  const key = `${scope}:${map}`;
  let entry = entries.get(key);
  if (!entry) {
    // Only idle descriptors are cached. There is never an unbounded map catalogue.
    for (const [key, candidate] of entries) {
      if (entries.size < 32) break;
      if (!candidate.listeners.size) {
        candidate.controller?.abort();
        entries.delete(key);
      }
    }
    entry = { key, map, value: pending, listeners: new Set(), members: new Set(), started: false };
    entries.set(key, entry);
  }
  return entry;
}

/** One synchronous map identity and one discovery request feed every viewer surface. */
export function useMapAssets(map: string | undefined, scope: string) {
  const member = useRef(Symbol('map consumer'));
  const entry = useMemo(
    () => (map && /^[a-zA-Z0-9_-]{1,80}$/.test(map) ? entryFor(map, scope) : undefined),
    [map, scope],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!entry) return () => {};
      if (entries.get(entry.key) !== entry) {
        entries.set(entry.key, entry);
        entry.started = false;
        entry.value = pending;
      }
      entry.listeners.add(listener);
      void discover(entry);
      return () => {
        entry.listeners.delete(listener);
        if (!entry.listeners.size && !entry.members.size) {
          entry.controller?.abort();
          if (entries.get(entry.key) === entry) entries.delete(entry.key);
        }
      };
    },
    [entry],
  );
  useLayoutEffect(() => {
    if (!entry) return;
    if (entries.get(entry.key) !== entry) {
      entry.controller?.abort();
      entry.controller = undefined;
      entry.started = false;
      entry.value = pending;
      entries.set(entry.key, entry);
    }
    const token = member.current;
    entry.members.add(token);
    return () => {
      entry.members.delete(token);
      if (!entry.members.size) {
        entry.controller?.abort();
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
      }
    };
  }, [entry]);
  const snapshot = useCallback(() => entry?.value || missing, [entry]);
  const state = useSyncExternalStore(subscribe, snapshot, () => missing);
  const reportOverview = useCallback(
    (image: string, version: string, status: 'ready' | 'error') => {
      if (
        !entry?.listeners.size ||
        entries.get(entry.key) !== entry ||
        entry.value.assets.overview?.image !== image ||
        entry.value.assets.overview.assetVersion !== version ||
        entry.value.overviewStatus === status
      )
        return;
      publish(entry, { ...entry.value, overviewStatus: status });
    },
    [entry],
  );
  return { ...state, reportOverview };
}
