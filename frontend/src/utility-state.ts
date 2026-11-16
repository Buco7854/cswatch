import type { GameEvent, Grenade } from './types';

export type UtilityPoint = { tick: number; x: number; y: number; z: number };
export type ProjectileState = {
  id: string;
  kind: string;
  point: UtilityPoint;
  trail: UtilityPoint[];
};
export type UtilityZone = {
  id: string;
  kind: 'smoke' | 'fire' | 'flash' | 'he' | 'decoy';
  start: number;
  end: number;
  x: number;
  y: number;
  z: number;
};
const effects = {
  smokegrenade_detonate: { kind: 'smoke', seconds: 18 },
  inferno_startburn: { kind: 'fire', seconds: 7 },
  flashbang_detonate: { kind: 'flash', seconds: 0.35 },
  hegrenade_detonate: { kind: 'he', seconds: 0.4 },
  decoy_started: { kind: 'decoy', seconds: 0.5 },
} as const;

/** Analytical effects at recorded event positions; durations are approximations. */
export function buildUtilityZones(events: GameEvent[], rate: number): UtilityZone[] {
  return events.flatMap((event, index) => {
    const effect = effects[event.type as keyof typeof effects];
    if (
      !effect ||
      ![event.tick, event.x, event.y, event.z].every(
        (value) =>
          typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000,
      )
    )
      return [];
    return [
      {
        id: `${event.type}:${event.tick}:${index}`,
        kind: effect.kind,
        start: event.tick,
        end: event.tick + Math.max(1, rate * effect.seconds),
        x: event.x!,
        y: event.y!,
        z: event.z!,
      },
    ];
  });
}

function upperPoint(points: UtilityPoint[], tick: number) {
  let low = 0,
    high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Interpolate only between recorded samples. Never extend flight beyond them. */
export function projectilesAt(paths: Grenade[], tick: number, rate: number): ProjectileState[] {
  return paths.flatMap((path) => {
    if (!path.points.length || tick < path.points[0].tick || tick > path.points.at(-1)!.tick)
      return [];
    const after = upperPoint(path.points, tick);
    const from = path.points[Math.max(0, after - 1)],
      to = path.points[after] || from;
    const alpha = to.tick > from.tick ? (tick - from.tick) / (to.tick - from.tick) : 0;
    const point = {
      tick,
      x: from.x + (to.x - from.x) * alpha,
      y: from.y + (to.y - from.y) * alpha,
      z: from.z + (to.z - from.z) * alpha,
    };
    const trail = path.points.slice(upperPoint(path.points, tick - rate * 2), after);
    if (!trail.length || trail.at(-1)!.tick !== tick) trail.push(point);
    return [{ id: path.id, kind: path.kind, point, trail }];
  });
}
