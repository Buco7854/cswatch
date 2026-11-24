import type { Object3D } from 'three';
import {
  breakableKey,
  uniqueBreakableNodes,
  type MapBreakable,
} from '../../shared/map-breakables.mjs';

type Entry = { node: Object3D; initial: boolean; hidden: MapBreakable['hidden'] };
type MapVisibility = {
  revision: number;
  authored: Map<Object3D, boolean>;
};
const visibility = new WeakMap<Object3D, MapVisibility>();
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
export function bindMapBreakables(root: Object3D, tracks: MapBreakable[] | undefined) {
  if (!tracks?.length) return;
  const wanted = new Map(tracks.map((track) => [breakableKey(track), track]));
  const matches = uniqueBreakableNodes<Object3D>(wanted, (accept) =>
    root.traverse((node) => accept(node, node.userData.cswatchBreakable)),
  );
  const entries: Entry[] = [],
    boundaries = new Set<number>();
  const state: MapVisibility = { revision: 0, authored: new Map() };
  for (const [key, node] of matches) {
    if (!node) continue;
    const track = wanted.get(key)!;
    for (const [a, b] of track.hidden) {
      boundaries.add(a);
      boundaries.add(b);
    }
    state.authored.set(node, node.visible);
    entries.push({ node, initial: node.visible, hidden: track.hidden });
  }
  if (!entries.length) return;
  visibility.set(root, state);
  const edges = Array.from(boundaries).sort((a, b) => a - b);
  let from = Infinity,
    to = -Infinity;
  return {
    seek(tick: number) {
      if (!Number.isFinite(tick) || (tick >= from && tick < to)) return;
      const next = upperBound(edges, tick, identity);
      from = edges[next - 1] ?? -Infinity;
      to = edges[next] ?? Infinity;
      let changed = false;
      for (const { node, initial, hidden } of entries) {
        const last = upperBound(hidden, tick, start) - 1;
        const show = initial && (last < 0 || tick >= hidden[last][1]);
        if (node.visible !== show) {
          node.visible = show;
          changed = true;
        }
      }
      if (changed) state.revision++;
    },
    dispose() {
      for (const { node, initial } of entries) node.visible = initial;
      state.revision++;
      if (visibility.get(root) === state) visibility.delete(root);
    },
  };
}
