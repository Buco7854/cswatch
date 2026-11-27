/** Molotov and incendiary fire as the official inferno particle systems draw it
 * (particles/inferno_fx/molotov_groundfire_*, molotov_child_flame01a,
 * molotov_smoking_ground_child01), sampled at demo time from recorded fire
 * points. Every particle's spawn time comes from its index at the layer's
 * emission rate and its randomness from a hash, so any tick is reproducible. */
const INCH = 0.0254;

export type FireLayerId = 'ground' | 'flame' | 'glow' | 'ember' | 'smoke' | 'scorch';
export type FireOrientation = 'ground' | 'camera' | 'upright';

type Range = readonly [number, number];
export type FireLayer = {
  texture: string;
  orientation: FireOrientation;
  /** Particles per second per recorded fire point. */
  rate: number;
  /** Emission starts this long after the point ignites. */
  delay: number;
  life: Range;
  /** Radius in inches at birth, scaled over life from start to end. */
  radius: Range;
  scale: readonly [start: number, end: number];
  alpha: Range;
  colorA: readonly [number, number, number];
  colorB: readonly [number, number, number];
  fadeIn: number;
  fadeOut: number;
  /** Spawn disc radius (inches) around the point and height above the ground. */
  spread: number;
  lift: Range;
  /** Upward speed (inches per second) and horizontal drift. */
  rise: Range;
  drift: number;
  /** Sprite sheet playback: frames per second, or 0 to spread the sheet over the life. */
  fps: number;
  spin: number;
  /** Most particles drawn for this layer across all fires. */
  cap: number;
};

const rgb = (r: number, g: number, b: number) => [r / 255, g / 255, b / 255] as const;
export const fireLayers: Record<FireLayerId, FireLayer> = {
  // molotov_groundfire_child_base: ground-aligned fire_explosion_1 at 58 fps.
  ground: {
    texture: 'fire-ground',
    orientation: 'ground',
    rate: 7,
    delay: 0,
    life: [50 / 58, 50 / 58],
    radius: [20, 35],
    scale: [1.2, 0.5],
    alpha: [0.08, 0.51],
    colorA: rgb(249, 249, 243),
    colorB: rgb(245, 204, 10),
    fadeIn: 0.4,
    fadeOut: 0.6,
    spread: 20,
    lift: [1, 1],
    rise: [0, 0],
    drift: 0,
    fps: 58,
    spin: 0,
    cap: 640,
  },
  // molotov_child_flame01a: upright fire_small_sim_b licks.
  flame: {
    texture: 'fire-flame',
    orientation: 'upright',
    rate: 6,
    delay: 0.05,
    life: [0.9, 1.2],
    radius: [28, 45],
    scale: [0.85, 1.1],
    alpha: [0.47, 0.59],
    colorA: rgb(244, 237, 208),
    colorB: rgb(235, 172, 95),
    fadeIn: 0.12,
    fadeOut: 0.35,
    spread: 8,
    lift: [14, 22],
    rise: [6, 14],
    drift: 3,
    fps: 0,
    spin: 0,
    cap: 640,
  },
  // molotov_groundfire_child_glow: a large soft flare modulating the ground.
  glow: {
    texture: 'fire-glow',
    orientation: 'ground',
    rate: 1,
    delay: 0,
    life: [1, 2],
    radius: [64, 100],
    scale: [0.75, 1],
    alpha: [0.35, 0.5],
    colorA: rgb(254, 209, 193),
    colorB: rgb(242, 187, 100),
    fadeIn: 0.4,
    fadeOut: 0.5,
    spread: 25,
    lift: [0.5, 0.5],
    rise: [0, 0],
    drift: 0,
    fps: 0,
    spin: 0,
    cap: 192,
  },
  // molotov_groundfire_child_embers: small rising sparks.
  ember: {
    texture: 'fire-ember',
    orientation: 'camera',
    rate: 4,
    delay: 0.2,
    life: [1.5, 2],
    radius: [2, 5],
    scale: [1, 0.4],
    alpha: [0.25, 1],
    colorA: rgb(244, 155, 0),
    colorB: rgb(157, 58, 4),
    fadeIn: 0.1,
    fadeOut: 0.6,
    spread: 18,
    lift: [1, 10],
    rise: [40, 90],
    drift: 18,
    fps: 0,
    spin: 0,
    cap: 384,
  },
  // molotov_smoking_ground_child01: smoke rising off the burning ground.
  smoke: {
    texture: 'fire-smoke',
    orientation: 'camera',
    rate: 1.5,
    delay: 0.8,
    life: [3, 4],
    radius: [36, 56],
    scale: [0.8, 2.2],
    alpha: [0.35, 0.5],
    colorA: rgb(62, 56, 50),
    colorB: rgb(38, 35, 32),
    fadeIn: 0.7,
    fadeOut: 1.5,
    spread: 16,
    lift: [40, 60],
    rise: [30, 50],
    drift: 12,
    fps: 0,
    spin: 25,
    cap: 192,
  },
  // molotov_groundfire_projected / scortch: a dark splat that outlives the fire.
  scorch: {
    texture: 'fire-scorch',
    orientation: 'ground',
    rate: 0,
    delay: 0,
    life: [0, 0],
    radius: [38, 46],
    scale: [1, 1],
    alpha: [0.75, 0.85],
    colorA: rgb(48, 48, 48),
    colorB: rgb(48, 48, 48),
    fadeIn: 0.6,
    fadeOut: 1.6,
    spread: 0,
    lift: [0.6, 0.6],
    rise: [0, 0],
    drift: 0,
    fps: 0,
    spin: 0,
    cap: 256,
  },
};

export type FirePoint = {
  position: readonly [number, number, number];
  seed: number;
  /** Ignition and end of the recorded point (seconds). */
  from: number;
  until: number;
};

export type FireParticle = {
  position: [number, number, number];
  /** Metres. */
  size: number;
  rotation: number;
  alpha: number;
  color: [number, number, number];
  /** Normalised life (0-1) and a per-particle value for the sheet. */
  life: number;
  sequence: number;
  /** Seconds since birth, for frame playback. */
  age: number;
};

const unit = (a: number, b: number, c: number) => {
  let h =
    Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const between = (range: Range, t: number) => lerp(range[0], range[1], t);

/** Particles of one layer alive at `time` (seconds) for the given fire points. */
export function fireParticles(layerId: FireLayerId, points: readonly FirePoint[], time: number) {
  const layer = fireLayers[layerId];
  const out: FireParticle[] = [];
  const layerSalt = Object.keys(fireLayers).indexOf(layerId) + 1;
  for (const point of points) {
    if (out.length >= layer.cap) break;
    const salt = Math.round(point.seed * 9973);
    if (layerId === 'scorch') {
      const age = time - point.from;
      if (age < 0) continue;
      const fade = Math.min(1, age / layer.fadeIn);
      const r = unit(salt, layerSalt, 1);
      out.push({
        position: [point.position[0], point.position[1] + layer.lift[0] * INCH, point.position[2]],
        size: between(layer.radius, r) * INCH,
        rotation: unit(salt, layerSalt, 2) * Math.PI * 2,
        alpha: between(layer.alpha, r) * fade,
        color: [...layer.colorA],
        life: 0,
        sequence: 0,
        age,
      });
      continue;
    }
    const start = point.from + layer.delay;
    const maxLife = layer.life[1];
    // Particles born before the point ends keep living out their lifetimes.
    const first = Math.max(0, Math.ceil((time - maxLife - start) * layer.rate));
    const last = Math.min(
      Math.floor((time - start) * layer.rate),
      Math.floor((point.until - start) * layer.rate),
    );
    for (let i = first; i <= last && out.length < layer.cap; i++) {
      const birth = start + i / layer.rate;
      const age = time - birth;
      const r = (k: number) => unit(salt, layerSalt * 4096 + i, k);
      const life = between(layer.life, r(1));
      if (age < 0 || age >= life) continue;
      const t = age / life;
      const fade =
        Math.min(1, age / Math.max(0.001, layer.fadeIn)) *
        Math.min(1, (life - age) / Math.max(0.001, layer.fadeOut));
      const angle = r(2) * Math.PI * 2,
        distance = Math.sqrt(r(3)) * layer.spread;
      const driftAngle = r(4) * Math.PI * 2,
        drift = layer.drift * age;
      const height = between(layer.lift, r(5)) + between(layer.rise, r(6)) * age;
      const color = r(7);
      out.push({
        position: [
          point.position[0] + (Math.cos(angle) * distance + Math.cos(driftAngle) * drift) * INCH,
          point.position[1] + height * INCH,
          point.position[2] + (Math.sin(angle) * distance + Math.sin(driftAngle) * drift) * INCH,
        ],
        size: between(layer.radius, r(8)) * lerp(layer.scale[0], layer.scale[1], t) * INCH,
        rotation:
          (r(9) * 2 - 1) * (layerId === 'flame' ? (24 * Math.PI) / 180 : Math.PI) +
          (layer.spin * Math.PI * age) / 180,
        alpha: between(layer.alpha, r(10)) * fade,
        color: [
          lerp(layer.colorA[0], layer.colorB[0], color),
          lerp(layer.colorA[1], layer.colorB[1], color),
          lerp(layer.colorA[2], layer.colorB[2], color),
        ],
        life: t,
        sequence: r(11),
        age,
      });
    }
  }
  return out;
}

const fireLightColor = [242, 211, 147].map((c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** molotov_groundfire_lighting: one warm, flickering, unshadowed light per burning area. Its
 * radius is twice the snapshot point's; here the area's extent plus a margin stands in for it.
 * Points within 300 inches of an area's first point share its light. */
export function fireLights(points: readonly FirePoint[], time: number) {
  const areas: { first: FirePoint; members: FirePoint[] }[] = [];
  for (const point of points) {
    if (point.from > time || point.until <= time) continue;
    const area = areas.find(
      ({ first }) =>
        Math.hypot(
          first.position[0] - point.position[0],
          first.position[1] - point.position[1],
          first.position[2] - point.position[2],
        ) <
        300 * INCH,
    );
    if (area) area.members.push(point);
    else areas.push({ first: point, members: [point] });
  }
  return areas.slice(0, 4).map(({ first, members }) => {
    const center = [0, 1, 2].map(
      (axis) => members.reduce((sum, point) => sum + point.position[axis], 0) / members.length,
    );
    const extent = Math.max(
      ...members.map((point) =>
        Math.hypot(point.position[0] - center[0], point.position[2] - center[2]),
      ),
    );
    const ignition = Math.min(...members.map((point) => point.from));
    const seed = first.seed * 7.31;
    const flicker =
      0.8 + 0.1 * Math.sin(time * 25.1 + seed) + 0.1 * Math.sin(time * 14.4 + seed * 1.7);
    const strength =
      Math.min(1, (time - ignition) / 0.5) * Math.min(1, members.length / 3) * flicker;
    return {
      position: [center[0], center[1] + 24 * INCH, center[2]] as const,
      radius: Math.min(480, 2 * (extent / INCH + 60)),
      color: fireLightColor.map((c) => c * strength) as unknown as readonly [
        number,
        number,
        number,
      ],
    };
  });
}
