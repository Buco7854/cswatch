import type { Playback } from './types';
import { itemPose, itemsAt, type ItemIndex } from './item-state';

const duration = 0.85;
const hasCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;

/** Use a recorded detonation and either its origin or the one live planted C4. */
export function indexBombShockwaves(events: Playback['events'], rate: number) {
  const detonations = events
    .filter((event) => event.type === 'bomb_exploded' && Number.isSafeInteger(event.tick))
    .sort((a, b) => a.tick - b.tick);
  return (tick: number, items: ItemIndex) => {
    let low = 0;
    let high = detonations.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (detonations[middle].tick <= tick) low = middle + 1;
      else high = middle;
    }
    const event = detonations[low - 1];
    if (!event || !Number.isFinite(tick) || !Number.isFinite(rate) || rate <= 0) return;
    const progress = (tick - event.tick) / (rate * duration);
    if (progress >= 1) return;
    let origin;
    if (hasCoordinate(event.x) && hasCoordinate(event.y) && hasCoordinate(event.z)) {
      origin = { x: event.x, y: event.y, z: event.z };
    } else {
      // Planted C4 may be removed on the detonation tick. Read its immediately
      // preceding recorded state from the overlapping item history.
      const planted = itemsAt(items, event.tick - 1).filter((item) => item.kind === 'planted');
      if (planted.length !== 1) return;
      origin = planted[0];
    }
    const [x, y, z] = itemPose(origin).position;
    return {
      position: [x, y + 0.12, z] as [number, number, number],
      radius: 0.5 + 23 * (1 - (1 - progress) ** 1.65),
      opacity: 0.74 * (1 - progress) ** 2,
    };
  };
}

export type BombShockwaveSample = NonNullable<ReturnType<ReturnType<typeof indexBombShockwaves>>>;
