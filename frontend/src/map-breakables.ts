import type { Object3D } from 'three';
import { bindMapDoors } from './map-doors';
import {
  breakableKey,
  uniqueBreakableNodes,
  uniqueVisibilityNodes,
  type MapBreakable,
  type MapDoor,
  type MapVisibility,
} from '../../shared/map-breakables.mjs';

type Entry = {
  node: Object3D;
  initial: boolean;
  shownBetween: boolean;
  intervals: [number, number][];
};
type SceneVisibility = {
  revision: number;
  authored: Map<Object3D, boolean>;
  moving: Set<Object3D>;
};
const visibility = new WeakMap<Object3D, SceneVisibility>();
export const mapBreakableVisibility = (root: Object3D) => visibility.get(root);

/** Upper bound on an ordered list. Adjacent chunks and fractional ticks share
 * the same inclusive removal / exclusive reset semantics as a cold seek. */
function upperBound<T>(values: readonly T[], tick: number, at: (value: T) => number) {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(values[mid]) <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const identity = (n: number) => n;
const start = (span: [number, number]) => span[0];

/** Called on a prepared viewer-local clone, after the managed asset scope resolves. */
export function bindMapBreakables(
  root: Object3D,
  tracks: MapBreakable[] | undefined,
  doorTracks?: MapDoor[],
  visibilityTracks?: MapVisibility[],
) {
  if (!tracks?.length && !doorTracks?.length && !visibilityTracks?.length) return;
  const doors = bindMapDoors(root, doorTracks);
  const wanted = new Map((tracks ?? []).map((track) => [breakableKey(track), track]));
  const matches = uniqueBreakableNodes<Object3D>(tracks, (accept) =>
    root.traverse((node) => accept(node, node.userData.cswatchBreakable)),
  );
  const entries: Entry[] = [],
    boundaries = new Set<number>();
  const state: SceneVisibility = {
    revision: 0,
    authored: new Map(doors.map((d) => [d.node, d.initial])),
    moving: new Set(doors.map((d) => d.node)),
  };
  function add(node: Object3D, intervals: [number, number][], shownBetween: boolean) {
    for (const [a, b] of intervals) {
      boundaries.add(a);
      boundaries.add(b);
    }
    // Include switchable geometry in the follow-camera index even on an initially hidden tick.
    state.authored.set(node, shownBetween || node.visible);
    entries.push({ node, initial: node.visible, intervals, shownBetween });
  }
  for (const [key, node] of matches) {
    if (node) add(node, wanted.get(key)!.hidden, false);
  }
  const visible = new Map((visibilityTracks ?? []).map((track) => [breakableKey(track), track]));
  const conditional = uniqueVisibilityNodes<Object3D>(visibilityTracks, (accept) =>
    root.traverse((node) => accept(node, node.userData.cswatchInitiallyDisabled)),
  );
  for (const [key, node] of conditional) {
    if (node) add(node, visible.get(key)!.visible, true);
  }
  if (!entries.length && !doors.length) return;
  visibility.set(root, state);
  const edges = Array.from(boundaries).sort((a, b) => a - b);
  let from = Infinity,
    to = -Infinity;
  return {
    seek(tick: number) {
      if (!Number.isFinite(tick)) return;
      let changed = false;
      for (const door of doors) if (door.seek(tick)) changed = true;
      if (tick < from || tick >= to) {
        const next = upperBound(edges, tick, identity);
        from = edges[next - 1] ?? -Infinity;
        to = edges[next] ?? Infinity;
        for (const { node, initial, intervals, shownBetween } of entries) {
          const last = upperBound(intervals, tick, start) - 1;
          const show = last >= 0 && tick < intervals[last][1] ? shownBetween : initial;
          if (node.visible !== show) {
            node.visible = show;
            changed = true;
          }
        }
      }
      if (changed) state.revision++;
    },
    dispose() {
      for (const door of doors) door.dispose();
      for (const { node, initial } of entries) node.visible = initial;
      state.revision++;
      if (visibility.get(root) === state) visibility.delete(root);
    },
  };
}
