import type { GameEvent } from './types';
import { WORLEY_CELLS, worleyAt } from './smoke-noise';

export type XYZ = [number, number, number];
type SmokeBounds = { min: XYZ; max: XYZ };
export type SmokeField = { texels: Uint8Array; bounds: SmokeBounds | null };
/** A recorded HE detonation near a cloud and the seconds since it. */
type SmokeHole = { position: XYZ; since: number };
/** A recorded shot segment through the cloud and its age as a fraction of the tunnel's life. */
export type SmokeTunnel = { from: XYZ; to: XYZ; age: number };
export type SmokeSample = {
  origin: XYZ;
  scale: number;
  previous: SmokeField;
  current: SmokeField;
  mix: number;
  bounds: SmokeBounds;
  /** Lifetime envelope of the recorded detonation and expiry. */
  amount: number;
  /** Seconds since detonation; drives the noise drift and the reveal. */
  age: number;
  holes: SmokeHole[];
  /** Recorded bullet paths through the cloud; none when absent. */
  tunnels?: SmokeTunnel[];
};

// The recorded journal's 32-cell Source-space grid uses 20-inch voxels.
export const GRID = 32;
export const INCH = 0.0254;
export const CELL = 20 * INCH;
export const HALF_GRID = (GRID * CELL) / 2;
export const HIGH_SUN: XYZ = [0.36, 0.86, -0.36];
export const MAX_HOLES = 4;
// The shader clears smoke within 20 inches of recent bullet paths (its
// recorded-shot segments) and lets it close as the segment ages. The game
// sets that age's duration outside the shaders; 1.5 s is an approximation.
export const MAX_TUNNELS = 8;
export const TUNNEL_SECONDS = 1.5;
// The CS2 smoke shader (smoke_volume.vfx) samples every four inches and
// treats each sample's opacity as a per-step alpha.
export const SMOKE_STEP = 4 * INCH;
export const MAX_SMOKE_STEPS = 96;
// An HE blast clears smoke within 200-240 inches and lets it refill over five seconds.
export const BLAST_REACH = 250 * INCH;
export const BLAST_SECONDS = 5;
// The smoke shader's reveal grows a sphere from the cloud centre; the
// recorded journal already carries the spread, so it lasts under a second.
export const REVEAL_SECONDS = 0.9;
// The shader's density texture is uploaded by game code at a scale the shaders
// do not reveal. The shader turns density into opacity and interior darkening;
// a mature CS2 smoke is opaque through its body yet grey inside, so its
// densities sit mid-range. The journal reconstruction (saturating at 1) maps
// concavely: a quarter-percentile cell of a grown cloud (0.12) transmits under
// 2% over 2 m and the densest cores stay near 0.6.
export const SMOKE_DENSITY_GAIN = 0.65;
export const smokeShaderDensity = (journal: number) =>
  SMOKE_DENSITY_GAIN * Math.sqrt(Math.max(0, journal));
const index = (x: number, y: number, z: number) => x + GRID * (y + GRID * z);

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

/** The recorded density as a single-channel 3D field in scene axes. */
export function densityField(density: Uint8Array): SmokeField {
  return { texels: density, bounds: occupiedBounds(density) };
}

export function analyticSmokeField() {
  const density = new Uint8Array(GRID ** 3);
  const metres = (i: number) => (i + 0.5) * CELL - HALF_GRID;
  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        const r = Math.hypot(metres(x) / 3.8, (metres(y) - 1.3) / 2.45, metres(z) / 3.8);
        density[index(x, y, z)] = Math.round(255 * smooth(1 - r, 0.35));
      }
  return densityField(density);
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
  const at = (x: number, y: number, z: number) => field.texels[index(x, y, z)];
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

function smokeDensityAt(smoke: SmokeSample, x: number, y: number, z: number) {
  const [ox, oy, oz] = smoke.origin;
  const { scale, previous, current, mix } = smoke;
  const a = sampleDensity(previous, (x - ox) / scale, (y - oy) / scale, (z - oz) / scale);
  const b = sampleDensity(current, (x - ox) / scale, (y - oy) / scale, (z - oz) / scale);
  return a + (b - a) * mix;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const smoothstep = (low: number, high: number, value: number) => {
  const t = clamp01((value - low) / (high - low));
  return t * t * (3 - 2 * t);
};

/** Two octaves of cellular noise in world inches, rising with the cloud's age
 * (smoke_volume.vfx). Returns the shader's brightness/erosion factor. */
export function smokeNoiseAt(x: number, y: number, z: number, age: number) {
  // Scene metres to Source inches (x, -z, y), scaled by the shader's 0.01.
  const sx = x / INCH / 100,
    sy = -z / INCH / 100;
  let sz = y / INCH / 100 - age * 0.05;
  const coarse = worleyAt(
    (sx * 2.3) / WORLEY_CELLS,
    (sy * 2.3) / WORLEY_CELLS,
    (sz * 2.3) / WORLEY_CELLS,
  );
  sz -= age * 0.03;
  const fine = worleyAt((sx * 6) / WORLEY_CELLS, (sy * 6) / WORLEY_CELLS, (sz * 6) / WORLEY_CELLS);
  return clamp01((1 - coarse) * 0.6 + (1 - fine) * 0.28 + 0.12);
}

/** The density remaining after recorded HE blasts, and its effect on colour. */
export function smokeBlastKeep(
  holes: readonly SmokeHole[],
  x: number,
  y: number,
  z: number,
  toSurface: number,
) {
  let keep = 1;
  for (const { position, since } of holes) {
    const distance = Math.hypot(x - position[0], y - position[1], z - position[2]) / INCH;
    if (distance >= BLAST_REACH / INCH) continue;
    const flash = Math.pow(1 - smoothstep(0, 2, since), 128);
    const wall = (toSurface / INCH <= 16 ? 1 : 0) * (1 - smoothstep(0, 7, since));
    keep = Math.min(
      keep,
      Math.max(
        smoothstep(200, 240, distance + flash * 250) + Math.pow(smoothstep(0.5, 5, since), 1.8),
        wall,
      ),
    );
  }
  return keep;
}

/** How strongly recorded bullet paths push smoke aside at a point (0-1). */
export function smokeTunnelPush(tunnels: readonly SmokeTunnel[], x: number, y: number, z: number) {
  let push = 0;
  for (const { from, to, age } of tunnels) {
    const ab = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const ap = [x - from[0], y - from[1], z - from[2]];
    const along = clamp01(
      (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1),
    );
    const off = Math.hypot(ap[0] - ab[0] * along, ap[1] - ab[1] * along, ap[2] - ab[2] * along);
    const reach = clamp01((off / INCH) * 0.05);
    if (reach >= 1) continue;
    const end = 1 - clamp01((Math.hypot(x - to[0], y - to[1], z - to[2]) / INCH) * 0.01);
    push = Math.max(push, smoothstep(0, 1, 1 - clamp01(age + clamp01(reach + end))));
  }
  return push;
}

/** Density after the shader's reveal, ripple, lifetime and blast terms. */
export function smokeSampleDensity(
  smoke: SmokeSample,
  x: number,
  y: number,
  z: number,
  fromEye: number,
  toSurface: number,
) {
  const push = smoke.tunnels?.length ? smokeTunnelPush(smoke.tunnels, x, y, z) : 0;
  const density = clamp01(
    smokeShaderDensity(smokeDensityAt(smoke, x, y, z)) * (1 - push) - 0.05 * push,
  );
  if (density <= 0.01) return 0;
  const span = GRID * CELL * smoke.scale;
  // Grid coordinates in Source axes.
  const u = (x - smoke.origin[0]) / span + 0.5,
    v = 0.5 - (z - smoke.origin[2]) / span,
    w = (y - smoke.origin[1]) / span + 0.5;
  const ripple = Math.max(
    0.5,
    clamp01(
      (Math.abs(Math.sin(u * 18.84 + smoke.age * 0.7)) +
        Math.abs(Math.cos(v * 31.4 + smoke.age * 0.5))) *
        0.5,
    ),
  );
  let value = clamp01((density - 0.01) * 1.0101) * ripple * smoke.amount;
  value = clamp01(value + (1 - clamp01((fromEye / INCH) * 0.1)) * value);
  const keep = smokeBlastKeep(smoke.holes, x, y, z, toSurface);
  value = value * 0.02 + (value - value * 0.02) * keep;
  const growth = smoke.age / REVEAL_SECONDS;
  if (growth < 1) {
    const g = Math.min(0.9999, Math.max(0.0001, growth));
    const low = smoothstep(0, 0.8, g),
      high = smoothstep(0.2, 1, g);
    const radius = clamp01(Math.hypot(u - 0.5, v - 0.5, (w - 0.5) * 1.2));
    value *= low === high ? g : clamp01(smoothstep(low, high, radius));
  }
  return value;
}

/** Opacity of one four-inch sample: noise erodes thin smoke and fills dense smoke. */
export function smokeSampleAlpha(density: number, noise: number) {
  const eroded = density - (1 - noise);
  return smoothstep(0, 0.2, clamp01(eroded + (density + noise - eroded) * density));
}

/** March the cloud the way the volume shader does, for label occlusion.
 * Returns the fraction of light passing between the two points. */
export function smokeTransmittance(smoke: SmokeSample, from: XYZ, to: XYZ) {
  const delta = to.map((v, i) => v - from[i]);
  const total = Math.hypot(...delta);
  if (!(total > 0) || smoke.amount <= 0) return 1;
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
  const begin = entry * total,
    end = exit * total;
  if (!(end > begin)) return 1;
  const stride = Math.max(SMOKE_STEP, (end - begin) / MAX_SMOKE_STEPS);
  const power = stride / SMOKE_STEP;
  let transmission = 1;
  for (let t = begin + stride * 0.5; t < end; t += stride) {
    const f = t / total;
    const x = from[0] + f * delta[0],
      y = from[1] + f * delta[1],
      z = from[2] + f * delta[2];
    // Labels end at a character, where the shader skips its keep-near-surface term.
    const density = smokeSampleDensity(smoke, x, y, z, t, Infinity);
    if (density <= 0) continue;
    const alpha = smokeSampleAlpha(density, smokeNoiseAt(x, y, z, smoke.age));
    transmission *= Math.pow(1 - alpha, power);
    if (transmission < 0.009) return 0;
  }
  return transmission;
}

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
  smoke: Pick<SmokeSample, 'origin' | 'bounds' | 'scale'>,
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
  const holes: SmokeHole[] = [];
  for (let i = low - 1; i >= 0 && holes.length < MAX_HOLES; i--) {
    const { position, tick: at } = blasts[i];
    const since = (tick - at) / rate;
    if (at < start || since >= BLAST_SECONDS) break;
    // Blasts reach 250 inches past the occupied bounds.
    if (
      position.some(
        (value, axis) =>
          value < smoke.origin[axis] + smoke.bounds.min[axis] * smoke.scale - BLAST_REACH ||
          value > smoke.origin[axis] + smoke.bounds.max[axis] * smoke.scale + BLAST_REACH,
      )
    )
      continue;
    holes.push({ position, since });
  }
  return holes;
}
