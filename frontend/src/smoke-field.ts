import type { GameEvent } from './types';

export type XYZ = [number, number, number];
export type SmokeBounds = { min: XYZ; max: XYZ };
export type SmokeField = { texels: Uint8Array; bounds: SmokeBounds | null };
export type SmokeHole = { position: XYZ; radius: number; strength: number };
export type SmokeSample = {
  origin: XYZ;
  scale: number;
  previous: SmokeField;
  current: SmokeField;
  mix: number;
  bounds: SmokeBounds;
  amount: number;
  holes: SmokeHole[];
};

// The recorded journal's 32-cell Source-space grid uses 20-inch voxels.
export const GRID = 32;
export const INCH = 0.0254;
export const CELL = 20 * INCH;
export const BILLOW_SPAN = 1.12;
export const HALF_GRID = (GRID * CELL) / 2;
export const HIGH_SUN: XYZ = [0.36, 0.86, -0.36];
export const MAX_HOLES = 4;
// The simulator uses 50 as its local saturation reference. Its scalar has no
// documented SI unit. Use it linearly as relative aerosol concentration, with
// a 2 m path at 65% of saturation yielding less than 2% transmittance.
export const EXTINCTION = 3.05;
const index = (x: number, y: number, z: number) => x + GRID * (y + GRID * z);
const inGrid = (i: number) => i >= 0 && i < GRID;

export function scenePoint([x, y, z]: readonly number[]): XYZ {
  return [x * INCH, z * INCH, -y * INCH];
}

export function occupiedBounds(density: Uint8Array): SmokeBounds | null {
  const min: XYZ = [GRID, GRID, GRID];
  const max: XYZ = [-1, -1, -1];
  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        if (!density[index(x, y, z)]) continue;
        min[0] = Math.min(min[0], x);
        min[1] = Math.min(min[1], y);
        min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x);
        max[1] = Math.max(max[1], y);
        max[2] = Math.max(max[2], z);
      }
  if (max[0] < 0) return null;
  // The linear sampler's support extends one cell from the occupied centre.
  for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.max(0, min[axis] - 0.5) * CELL - HALF_GRID;
    max[axis] = Math.min(GRID, max[axis] + 1.5) * CELL - HALF_GRID;
  }
  return { min, max };
}

export function unionSmokeBounds(a: SmokeBounds | null, b: SmokeBounds | null) {
  if (!a || !b) return a ?? b;
  return {
    min: a.min.map((value, axis) => Math.min(value, b.min[axis])) as XYZ,
    max: a.max.map((value, axis) => Math.max(value, b.max[axis])) as XYZ,
  };
}

/** Sweep optical depth plane by plane from the light. Each voxel reads the
 * bilinear upstream intersection from the previous plane of the dominant axis. */
export function lightField(density: Uint8Array, sun: XYZ) {
  const bounds = occupiedBounds(density);
  const texels = new Uint8Array(2 * density.length);
  const opticalDepth = new Float32Array(density.length);
  const length = Math.hypot(...sun);
  const direction = length > 0 ? (sun.map((v) => v / length) as XYZ) : HIGH_SUN;
  const axis = direction.reduce(
    (best, v, i) => (Math.abs(v) > Math.abs(direction[best]) ? i : best),
    0,
  );
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const sign = Math.sign(direction[axis]);
  const plane = Math.abs(direction[axis]);
  const step = (CELL * EXTINCTION) / plane;
  const strides = [1, GRID, GRID ** 2];
  const upstream = (p: number, a: number, b: number) =>
    inGrid(p) && inGrid(a) && inGrid(b)
      ? opticalDepth[p * strides[axis] + a * strides[u] + b * strides[v]]
      : 0;
  const du = direction[u] / plane;
  const dv = direction[v] / plane;
  const iu = Math.floor(du),
    iv = Math.floor(dv);
  const fu = du - iu,
    fv = dv - iv;
  for (let layer = 0; layer < GRID; layer++) {
    const p = sign > 0 ? GRID - 1 - layer : layer;
    for (let b = 0; b < GRID; b++)
      for (let a = 0; a < GRID; a++) {
        const j = p * strides[axis] + a * strides[u] + b * strides[v];
        const q = p + sign;
        const x = a + iu,
          y = b + iv;
        const near = upstream(q, x, y) * (1 - fu) + upstream(q, x + 1, y) * fu;
        const far = upstream(q, x, y + 1) * (1 - fu) + upstream(q, x + 1, y + 1) * fu;
        const before = near * (1 - fv) + far * fv;
        const depth = (density[j] / 255) * step;
        opticalDepth[j] = before + depth;
        texels[j * 2] = density[j];
        texels[j * 2 + 1] = Math.round(255 * Math.exp(-before - depth * 0.5));
      }
  }
  return { texels, bounds };
}

export function analyticSmokeField(sun: XYZ) {
  const density = new Uint8Array(GRID ** 3);
  const metres = (i: number) => (i + 0.5) * CELL - HALF_GRID;
  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        const r = Math.hypot(metres(x) / 3.8, (metres(y) - 1.3) / 2.45, metres(z) / 3.8);
        density[index(x, y, z)] = Math.round(255 * smooth(1 - r, 0.35));
      }
  return lightField(density, sun);
}

export function smooth(value: number, duration: number) {
  const t = Math.min(1, Math.max(0, value / duration));
  return t * t * (3 - 2 * t);
}

export function smokeEnvelope(age: number, remaining: number, fade: number) {
  return smooth(age, 0.24) * smooth(remaining, fade);
}

function sampleDensity(field: SmokeField, x: number, y: number, z: number) {
  const a = Math.min(GRID - 1, Math.max(0, (x + HALF_GRID) / CELL - 0.5));
  const b = Math.min(GRID - 1, Math.max(0, (y + HALF_GRID) / CELL - 0.5));
  const c = Math.min(GRID - 1, Math.max(0, (z + HALF_GRID) / CELL - 0.5));
  const i = Math.floor(a),
    j = Math.floor(b),
    k = Math.floor(c);
  const ni = Math.min(GRID - 1, i + 1),
    nj = Math.min(GRID - 1, j + 1),
    nk = Math.min(GRID - 1, k + 1);
  const at = (x: number, y: number, z: number) => field.texels[index(x, y, z) * 2];
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  const low = lerp(
    lerp(at(i, j, k), at(ni, j, k), a - i),
    lerp(at(i, nj, k), at(ni, nj, k), a - i),
    b - j,
  );
  const high = lerp(
    lerp(at(i, j, nk), at(ni, j, nk), a - i),
    lerp(at(i, nj, nk), at(ni, nj, nk), a - i),
    b - j,
  );
  return lerp(low, high, c - k) / 255;
}

export function smokeDensityAt(smoke: SmokeSample, x: number, y: number, z: number) {
  const [ox, oy, oz] = smoke.origin;
  const { scale, previous, current, mix } = smoke;
  const a = sampleDensity(previous, (x - ox) / scale, (y - oy) / scale, (z - oz) / scale);
  const b = sampleDensity(current, (x - ox) / scale, (y - oy) / scale, (z - oz) / scale);
  return a + (b - a) * mix;
}

/** Integrate the recorded field along the clipped segment for label occlusion.
 * Edge noise is cosmetic and omitted. Returns 1 for a miss or an empty field. */
export function smokeTransmittance(smoke: SmokeSample, from: XYZ, to: XYZ) {
  const delta = to.map((v, i) => v - from[i]);
  let entry = 0,
    exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    const min = smoke.origin[axis] + smoke.bounds.min[axis] * smoke.scale;
    const max = smoke.origin[axis] + smoke.bounds.max[axis] * smoke.scale;
    if (Math.abs(delta[axis]) < 1e-9) {
      if (from[axis] < min || from[axis] > max) return 1;
      continue;
    }
    const near = (min - from[axis]) / delta[axis];
    const far = (max - from[axis]) / delta[axis];
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
  }
  const length = Math.hypot(...delta) * (exit - entry);
  if (!(length > 0) || smoke.amount <= 0) return 1;
  const steps = Math.min(96, Math.ceil(length / (CELL * smoke.scale * 0.5)));
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = entry + ((exit - entry) * (i + 0.5)) / steps;
    const x = from[0] + t * delta[0],
      y = from[1] + t * delta[1],
      z = from[2] + t * delta[2];
    let density = smokeDensityAt(smoke, x, y, z);
    for (const {
      position: [hx, hy, hz],
      radius,
      strength,
    } of smoke.holes)
      density *=
        1 -
        strength * (1 - smooth(Math.hypot(x - hx, y - hy, z - hz) - radius * 0.55, radius * 0.45));
    sum += density;
  }
  return Math.exp((-sum * EXTINCTION * smoke.amount * length) / steps);
}

const HOLE_SECONDS = 1.1;
export function indexSmokeBlasts(events: GameEvent[]) {
  return events
    .flatMap(({ type, tick, x, y, z }) =>
      type === 'hegrenade_detonate' &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      typeof z === 'number' &&
      [tick, x, y, z].every(Number.isFinite)
        ? [{ tick, position: scenePoint([x, y, z]) }]
        : [],
    )
    .sort((a, b) => a.tick - b.tick);
}

export function activeSmokeHoles(
  blasts: ReturnType<typeof indexSmokeBlasts>,
  smoke: SmokeSample,
  start: number,
  tick: number,
  rate: number,
) {
  let low = 0,
    high = blasts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (blasts[mid].tick <= tick) low = mid + 1;
    else high = mid;
  }
  const holes = [];
  for (let i = low - 1; i >= 0 && holes.length < MAX_HOLES; i--) {
    const { position, tick: at } = blasts[i];
    const age = (tick - at) / rate;
    if (at < start || age >= HOLE_SECONDS) break;
    if (
      position.some(
        (value, axis) =>
          value < smoke.origin[axis] + smoke.bounds.min[axis] * smoke.scale ||
          value > smoke.origin[axis] + smoke.bounds.max[axis] * smoke.scale,
      )
    )
      continue;
    if (smokeDensityAt(smoke, ...position) < 0.06) continue;
    holes.push({
      position,
      radius: 2.4 * smooth(age + 0.05, 0.17) * (1 - 0.65 * smooth(age - 0.16, 0.94)),
      strength: 1 - smooth(age - 0.2, HOLE_SECONDS - 0.2),
    });
  }
  return holes;
}
