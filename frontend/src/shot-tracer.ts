import { povProjection, type CameraView } from './pov-camera';

export const tracerLifetime = 0.082;
export const tracerReach = 28;

/** Window along a presentation ray in metres. The clip distance comes from the map. */
export function shotTracerSpan(age: number, clip: number) {
  if (age < 0 || age >= tracerLifetime || !Number.isFinite(age) || !Number.isFinite(clip)) return;
  const travel = 0.48 + age * 390;
  const head = Math.min(tracerReach, clip, travel);
  const tail = Math.max(0, travel - 4.2);
  if (head > tail + 0.03) return { head, tail };
}

/** Keep recent shot rays (including blocked muzzle origins) for one map and replay. */
export function createShotRayCache<T>(capacity = 128) {
  const rays = new Map<string, T>();
  return {
    resolve(id: string, tick: number, compute: () => T): T {
      const key = id + ':' + tick;
      const existing = rays.get(key);
      if (existing !== undefined) return existing;
      const ray = compute();
      rays.set(key, ray);
      if (rays.size > capacity) rays.delete(rays.keys().next().value!);
      return ray;
    },
  };
}

/** Reproject the independent viewmodel lens into the world camera's eye space. */
export function povMuzzleScale(aspect: number, worldFov: number) {
  return (
    Math.tan((worldFov * Math.PI) / 360) / Math.tan((povProjection(aspect).fov * Math.PI) / 360)
  );
}

/** Blend the live muzzle into the shot ray near its start. Its map-clipped end stays fixed. */
export function shotMuzzleWeight(distance: number, clip: number) {
  return Math.max(0, 1 - distance / Math.min(1.25, clip));
}

type Point = CameraView['position'];
type ShotTrace = (ray: CameraView) => Point;

/** The map ray uses a fixed muzzle proxy in the shot's recorded eye basis. */
export function traceRecordedShot(view: CameraView, trace: ShotTrace) {
  const [dx, dy, dz] = view.target.map((value, axis) => value - view.position[axis]);
  const length = Math.hypot(dx, dy, dz);
  if (!length || !Number.isFinite(length)) return null;
  const direction: Point = [dx / length, dy / length, dz / length];
  const horizontal = Math.hypot(dx, dz) || 1;
  const right: Point = [-dz / horizontal, 0, dx / horizontal];
  const up: Point = [
    -right[2] * direction[1],
    right[2] * direction[0] - right[0] * direction[2],
    right[0] * direction[1],
  ];
  const origin = view.position.map(
    (value, axis) => value + direction[axis] * 0.68 + right[axis] * 0.17 - up[axis] * 0.18,
  ) as Point;
  if (trace({ target: view.position, position: origin }) !== origin) return null;
  const destination = origin.map((value, axis) => value + direction[axis] * tracerReach) as Point;
  const clipped = trace({ target: origin, position: destination });
  const stop = Math.hypot(clipped[0] - origin[0], clipped[1] - origin[1], clipped[2] - origin[2]);
  return { origin, direction, stop };
}
