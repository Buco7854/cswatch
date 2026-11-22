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
