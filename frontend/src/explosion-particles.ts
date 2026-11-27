/** HE and flashbang detonations as the official particle systems draw them
 * (particles/explosions_fx/explosion_hegrenade and its children, explosion_flashbang), at the
 * "high" detail level. Each particle's randomness comes from a hash of the detonation and its
 * index, and its motion is the closed form of C_OP_BasicMovement (gravity with drag applied as
 * (1 - drag)^(30 dt)), so any demo time is reproducible without stepping. */
import type { SpriteLayer, SpriteParticle } from './components/EffectSprites';
import type { EffectLight } from './effect-lights';

const INCH = 0.0254;
type V3 = readonly [number, number, number];
type Range = readonly [number, number];

export type Detonation = {
  id: string;
  kind: 'he' | 'flash';
  /** Source inches, Z up. */
  origin: V3;
  /** Seconds since the recorded detonation. */
  age: number;
  seed: number;
  /** Source Z (inches) of the surface below the detonation, when the world was traced. */
  floor?: number;
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
const smooth = (t: number) => t * t * (3 - 2 * t);
const saturate = (t: number) => Math.min(1, Math.max(0, t));
// ParticleMath.Bias (Schlick).
const bias = (x: number, b: number) => x / ((1 - x) * (1 / b - 2) + 1);
const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const srgb = (c: V3) => [linear(c[0]), linear(c[1]), linear(c[2])] as const;

/** Offset and velocity after `t` seconds from `v0` under Z gravity and drag. */
function travel(v0: V3, t: number, gravity: number, drag: number) {
  const k = -30 * Math.log(1 - Math.min(drag, 0.999));
  if (k < 1e-6)
    return {
      offset: [v0[0] * t, v0[1] * t, v0[2] * t + 0.5 * gravity * t * t] as V3,
      velocity: [v0[0], v0[1], v0[2] + gravity * t] as V3,
    };
  const decay = Math.exp(-k * t),
    reach = (1 - decay) / k,
    terminal = gravity / k;
  return {
    offset: [v0[0] * reach, v0[1] * reach, (v0[2] - terminal) * reach + terminal * t] as V3,
    velocity: [v0[0] * decay, v0[1] * decay, (v0[2] - terminal) * decay + terminal] as V3,
  };
}

type Draw = (k: number) => number;
type Spawn = { offset: V3; velocity: V3 };

export type BurstLayer = SpriteLayer & {
  kind: 'he' | 'flash';
  /** Particles per detonation and their emission times. */
  count: number;
  births?: readonly number[];
  /** Renderers of one system share its particles. */
  system: string;
  life: Range;
  /** Inches. PF_TYPE_RANDOM_BIASED exponential draws raise the uniform draw to these powers. */
  radius: Range;
  radiusSkew?: number;
  lifeSkew?: number;
  /** C_OP_InterpolateRadius and the renderer's flRadiusScale. */
  scale?: { from: number; to: number; bias?: number; start?: number; end?: number };
  radiusScale?: number;
  alpha: Range;
  /** C_OP_FadeIn (proportional unless `seconds`) and C_OP_FadeOut / FadeOutSimple. */
  fadeIn?: { time: Range; seconds?: boolean };
  fadeOut?: Range;
  /** RandomColor between two sRGB colours, times the renderer's colour scale. */
  color: readonly [V3, V3];
  colorScale?: V3;
  spawn: (draw: Draw) => Spawn;
  gravity: number;
  drag: number;
  /** Rotation speed (degrees per second) and C_OP_RenderTrails length in seconds of travel. */
  spin?: Range;
  trail?: { time: Range; max: number };
  /** Rest on the traced floor (or the detonation height) instead of falling through it, or
   * project onto a floor within 30 inches (C_OP_RenderProjected's depth) and skip otherwise. */
  floor?: 'rest' | 'project';
  /** The smoke_wisp_breakup texture blend: by `until` seconds of system age the layer has
   * eroded by `amount`, along a standard bias curve. */
  erode?: { until: number; bias: number; amount: number };
};

const sphere = (draw: Draw, radius: Range): V3 => {
  const z = draw(20) * 2 - 1,
    a = draw(21) * Math.PI * 2,
    r = between(radius, Math.cbrt(draw(22))),
    across = Math.sqrt(1 - z * z) * r;
  return [Math.cos(a) * across, Math.sin(a) * across, z * r];
};
const box = (draw: Draw, min: V3, max: V3, k: number): V3 => [
  between([min[0], max[0]], draw(k)),
  between([min[1], max[1]], draw(k + 1)),
  between([min[2], max[2]], draw(k + 2)),
];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** C_INIT_RingWave with xy-only velocity: a horizontal ring moving radially at `speed`. */
const ring = (draw: Draw, radius: number, speed: Range): Spawn => {
  const a = draw(23) * Math.PI * 2,
    s = between(speed, draw(24));
  return {
    offset: [Math.cos(a) * radius, Math.sin(a) * radius, 0],
    velocity: [Math.cos(a) * s, Math.sin(a) * s, 0],
  };
};
/** CreateWithinSphere with speed along the outward direction, biased upward (vecDistanceBiasAbs z). */
const hemisphere = (draw: Draw, speed: Range): Spawn => {
  const z = draw(25),
    a = draw(26) * Math.PI * 2,
    r = Math.sqrt(1 - z * z),
    s = between(speed, draw(27));
  return { offset: [0, 0, 0], velocity: [Math.cos(a) * r * s, Math.sin(a) * r * s, z * s] };
};
const clampSpeed = (v: V3, max: number): V3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > max ? [(v[0] / length) * max, (v[1] / length) * max, (v[2] / length) * max] : v;
};

// The fireball's gradient lookups (SPRITECARD_TEXTURE_1D_COLOR_LOOKUP).
const heatRamp = [
  [0, 2, 2, 2],
  [1, 255, 77, 23],
] as const;
const flameRamp = [
  [0, 0, 0, 0],
  [0.95, 255, 73, 22],
  [1, 255, 115, 64],
] as const;
const emberRamp = [
  [0, 0, 0, 0],
  [0.6, 255, 101, 62],
  [0.8, 255, 135, 91],
  [1, 255, 177, 124],
] as const;
const trailRamp = [
  [0, 2, 2, 2],
  [1, 255, 105, 63],
] as const;
const grey = (v: number): V3 => [v, v, v];

const coreSmoke = {
  kind: 'he' as const,
  system: 'smoke-core',
  count: 3,
  births: [0, 0.05, 0.1],
  life: [1, 2] as Range,
  radius: [90, 180] as Range,
  scale: { from: 0.333, to: 1, bias: 0.8125 },
  alpha: [1, 1] as Range,
  fadeOut: [0.5, 0.75] as Range,
  color: [grey(255), grey(223)] as const,
  spawn: (draw: Draw) => ({
    offset: box(draw, [-30, -30, 22.5], [30, 30, 7.5], 30),
    velocity: box(draw, [-60, -60, 90], [60, 60, 180], 33),
  }),
  gravity: 50,
  drag: 0.1,
  spin: [2, 4] as Range,
  orientation: 'camera' as const,
  feather: 30,
  cap: 18,
};
const groundSmoke = {
  kind: 'he' as const,
  system: 'smoke-ground',
  count: 8,
  life: [1.5, 6] as Range,
  radius: [75, 125] as Range,
  scale: { from: 0.333, to: 1, bias: 0.8125 },
  alpha: [0.811765, 0.87451] as Range,
  fadeOut: [0.75, 1] as Range,
  color: [grey(255), grey(223)] as const,
  spawn: (draw: Draw) => {
    const wave = ring(draw, 20, [25, 200]);
    return {
      offset: add(wave.offset, box(draw, [-30, -30, -7.5], [30, 30, 22.5], 30)),
      velocity: wave.velocity,
    };
  },
  gravity: 0,
  drag: 0.1,
  spin: [2, 4] as Range,
  orientation: 'camera' as const,
  feather: 30,
  cap: 48,
};
// explosion_hegrenade_embers and _heattrails share one motion: a fast horizontal ring with a
// strong upward noise, drag 0.2, gravity -250 and a 2200 in/s cap.
const emberMotion = (draw: Draw) => {
  const wave = ring(draw, 5, [500, 2500]);
  return {
    offset: wave.offset,
    velocity: clampSpeed(
      add(wave.velocity, box(draw, [-150, -150, -100], [150, 150, 2000], 30)),
      2200,
    ),
  };
};

export const burstLayers: BurstLayer[] = [
  // explosion_hegrenade_decal: a projected scorch (the same fluid splat as the fire's).
  {
    kind: 'he',
    id: 'he-scorch',
    system: 'decal',
    texture: 'fire-scorch',
    blend: 'alpha',
    orientation: 'ground',
    gain: 1,
    cap: 16,
    count: 1,
    life: [20, 30],
    radius: [30, 40],
    alpha: [0.9, 1],
    fadeIn: { time: [0.125, 0.15], seconds: true },
    fadeOut: [0.5, 0.5],
    color: [grey(96), grey(32)],
    spawn: (draw) => {
      const [x, y] = sphere(draw, [10, 20]);
      return { offset: [x, y, 0.6], velocity: [0, 0, 0] };
    },
    gravity: 0,
    drag: 0,
    floor: 'project',
  },
  // explosion_hegrenade_smoke_ground: low rolling smoke, lit, with a brief heat glow.
  {
    ...groundSmoke,
    id: 'he-ground-smoke',
    texture: 'he-smoke',
    blend: 'alpha',
    gain: 1,
    colorScale: grey(64),
    rate: 1,
    erode: { until: 1.5, bias: 0.5, amount: 0.5 },
  },
  {
    ...groundSmoke,
    id: 'he-ground-heat',
    texture: 'he-heat',
    blend: 'add',
    gain: 5,
    gradient: heatRamp,
    rate: 1,
    erode: { until: 0.75, bias: 0.5, amount: 1 },
  },
  // explosion_hegrenade_smoke_blasts: three plumes thrown up and out, drawn as trails.
  ...(['smoke', 'heat'] as const).map((layer): BurstLayer => ({
    kind: 'he',
    id: 'he-blast-' + layer,
    system: 'smoke-blasts',
    texture: 'he-blast',
    blend: layer === 'smoke' ? 'alpha' : 'add',
    orientation: 'stretch',
    feather: 30,
    gain: layer === 'smoke' ? 1 : 10,
    gradient: layer === 'heat' ? heatRamp : undefined,
    colorScale: layer === 'smoke' ? grey(64) : undefined,
    rate: 1,
    erode: { until: 0.75, bias: -0.25, amount: layer === 'smoke' ? 0.5 : 1 },
    cap: 18,
    count: 3,
    life: [0.75, 1.5],
    radius: [30, 60],
    scale: { from: 0.75, to: 1, bias: 0.8125 },
    alpha: [1, 1],
    fadeOut: [0.75, 1],
    color: [grey(255), grey(223)],
    spawn: (draw) => hemisphere(draw, [200, 400]),
    gravity: 0,
    drag: 0.025,
    trail: { time: [1, 1], max: 600 },
  })),
  // explosion_hegrenade_smoke_core: the fireball's smoke, heat and flame renderers.
  {
    ...coreSmoke,
    id: 'he-core-smoke',
    texture: 'he-smoke',
    blend: 'alpha',
    gain: 1,
    colorScale: grey(64),
    rate: 1,
    erode: { until: 1, bias: -0.25, amount: 0.5 },
  },
  {
    ...coreSmoke,
    id: 'he-core-heat',
    texture: 'he-heat',
    blend: 'add',
    gain: 10,
    gradient: heatRamp,
    rate: 1,
    erode: { until: 0.75, bias: -0.25, amount: 1 },
  },
  {
    ...coreSmoke,
    id: 'he-core-flame',
    texture: 'he-fireball',
    blend: 'add',
    gain: 40,
    gradient: flameRamp,
    rate: 2,
    erode: { until: 0.75, bias: -0.25, amount: 1 },
  },
  // explosion_hegrenade_debris_small: flecks thrown out that fall and settle.
  {
    kind: 'he',
    id: 'he-debris',
    system: 'debris-small',
    texture: 'he-debris',
    blend: 'alpha',
    orientation: 'camera',
    gain: 1,
    cap: 120,
    count: 20,
    life: [3, 4],
    radius: [0.25, 2.5],
    radiusSkew: 2,
    scale: { from: 1, to: 0, start: 0.5, bias: 0.3 },
    alpha: [1, 1],
    color: [grey(160), grey(96)],
    colorScale: grey(191),
    spawn: (draw) => ({
      offset: add(sphere(draw, [0, 10]), [0, 0, 1]),
      velocity: add(
        box(draw, [-250, -250, 62.5], [250, 250, 500], 30),
        box(draw, [-300, -300, 100], [300, 300, 300], 33),
      ),
    }),
    gravity: -200,
    drag: 0.025,
    spin: [-30, 30],
    floor: 'rest',
  },
  // explosion_hegrenade_heattrails: burning streaks.
  {
    kind: 'he',
    id: 'he-heat-trails',
    system: 'heat-trails',
    texture: 'he-blast-flame',
    blend: 'add',
    orientation: 'stretch',
    feather: 20,
    gain: 160,
    gradient: trailRamp,
    rate: 1,
    cap: 96,
    count: 16,
    life: [1, 4],
    lifeSkew: 5,
    radius: [1, 2],
    radiusScale: 3,
    scale: { from: 1, to: 0, bias: 0.3 },
    alpha: [0.87451, 1],
    fadeOut: [0, 0.5],
    color: [grey(255), grey(223)],
    spawn: emberMotion,
    gravity: -250,
    drag: 0.2,
    trail: { time: [0.1, 0.15], max: 200 },
  },
  // explosion_hegrenade_embers: small bright sparks of the fireball.
  {
    kind: 'he',
    id: 'he-embers',
    system: 'embers',
    texture: 'he-fireball',
    blend: 'add',
    orientation: 'camera',
    feather: 8,
    gain: 40,
    gradient: emberRamp,
    rate: 0.5,
    cap: 96,
    count: 16,
    life: [1, 4],
    lifeSkew: 5,
    radius: [1, 2],
    scale: { from: 1, to: 0, bias: 0.3 },
    alpha: [0.87451, 1],
    fadeOut: [0, 0.5],
    color: [grey(255), grey(223)],
    spawn: emberMotion,
    gravity: -250,
    drag: 0.2,
  },
  // explosion_hegrenade (root): the bright core flare, 0.25 s.
  {
    kind: 'he',
    id: 'he-core',
    system: 'core',
    texture: 'he-core',
    blend: 'add',
    orientation: 'camera',
    feather: 40,
    gain: 4,
    cap: 6,
    count: 1,
    life: [0.25, 0.25],
    radius: [2, 3],
    radiusScale: 6,
    scale: { from: 10, to: 15, bias: 0.55 },
    alpha: [1, 1],
    fadeOut: [0.5, 0.5],
    color: [
      [254, 158, 94],
      [254, 158, 94],
    ],
    spawn: () => ({ offset: [0, 0, 0], velocity: [0, 0, 0] }),
    gravity: 0,
    drag: 0,
  },
  // explosion_flashbang: one 256-inch flare, drawn without depth test, gone in 0.25 s.
  {
    kind: 'flash',
    id: 'flash-flare',
    system: 'flash',
    texture: 'flash-flare',
    blend: 'add',
    orientation: 'camera',
    gain: 1,
    overlay: true,
    cap: 6,
    count: 1,
    life: [0.25, 0.25],
    radius: [256, 256],
    alpha: [1, 1],
    fadeOut: [1, 1],
    color: [
      [226, 244, 255],
      [226, 244, 255],
    ],
    spawn: () => ({ offset: [0, 0, 0], velocity: [0, 0, 0] }),
    gravity: 0,
    drag: 0,
  },
];

const systemSalt = (system: string) => {
  let h = 7;
  for (let i = 0; i < system.length; i++) h = Math.imul(h ^ system.charCodeAt(i), 0x01000193);
  return h;
};

/** Particles of one layer alive across the given detonations. */
export function burstParticles(layer: BurstLayer, detonations: readonly Detonation[]) {
  const out: SpriteParticle[] = [];
  const salt = systemSalt(layer.system);
  for (const burst of detonations) {
    if (burst.kind !== layer.kind) continue;
    for (let i = 0; i < layer.count && out.length < layer.cap; i++) {
      const draw: Draw = (k) => unit(burst.seed, salt + i * 131, k);
      const birth = layer.births?.[i] ?? 0;
      const age = burst.age - birth;
      const life = between(layer.life, draw(1) ** (layer.lifeSkew ?? 1));
      if (age < 0 || age >= life) continue;
      const t = age / life;
      const spawn = layer.spawn(draw);
      const moved = travel(spawn.velocity, age, layer.gravity, layer.drag);
      const sum = add(spawn.offset, moved.offset);
      const ground = (burst.floor ?? burst.origin[2]) - burst.origin[2];
      if (layer.floor === 'project' && (burst.floor === undefined || ground < -30)) continue;
      const local: V3 =
        layer.floor === 'project'
          ? [sum[0], sum[1], ground + sum[2]]
          : layer.floor === 'rest' && sum[2] < ground
            ? [sum[0], sum[1], ground]
            : sum;
      let alpha = between(layer.alpha, draw(2));
      if (layer.fadeIn) {
        const time = between(layer.fadeIn.time, draw(3));
        alpha *= smooth(saturate((layer.fadeIn.seconds ? age : t) / Math.max(1e-4, time)));
      }
      if (layer.fadeOut) {
        const time = Math.max(1e-4, between(layer.fadeOut, draw(4)));
        if (1 - t < time) alpha *= 1 - smooth(saturate(1 - (1 - t) / time));
      }
      if (layer.erode) {
        const { until, bias: parameter, amount } = layer.erode;
        alpha *= 1 - amount * bias(saturate(burst.age / until), (parameter + 1) / 2);
      }
      if (alpha <= 0.002) continue;
      let scale = 1;
      if (layer.scale) {
        const { from, to, start = 0, end = 1 } = layer.scale;
        let s = saturate((t - start) / (end - start));
        if (layer.scale.bias && layer.scale.bias !== 0.5) s = bias(s, layer.scale.bias);
        scale = lerp(from, to, s);
      }
      const radius =
        between(layer.radius, draw(5) ** (layer.radiusSkew ?? 1)) *
        scale *
        (layer.radiusScale ?? 1);
      const mix = draw(6);
      // Lit (alpha) layers show their authored grey as display colour, like the fire's smoke;
      // self-illuminated layers are linear light.
      const tone = layer.blend === 'alpha' ? (c: V3) => [c[0] / 255, c[1] / 255, c[2] / 255] : srgb;
      const a = tone(layer.color[0]),
        b = tone(layer.color[1]),
        tint = layer.colorScale ? tone(layer.colorScale) : ([1, 1, 1] as const);
      const position: V3 = [
        burst.origin[0] + local[0],
        burst.origin[1] + local[1],
        burst.origin[2] + local[2],
      ];
      const particle: SpriteParticle = {
        position: [position[0] * INCH, position[2] * INCH, -position[1] * INCH],
        size: radius * INCH,
        rotation:
          draw(7) * Math.PI * 2 + (between(layer.spin ?? [0, 0], draw(8)) * Math.PI * age) / 180,
        alpha,
        color: [
          lerp(a[0], b[0], mix) * tint[0],
          lerp(a[1], b[1], mix) * tint[1],
          lerp(a[2], b[2], mix) * tint[2],
        ],
        life: t,
        sequence: draw(9),
        age,
      };
      if (layer.trail) {
        const v = moved.velocity,
          speed = Math.hypot(v[0], v[1], v[2]);
        particle.axis = speed > 1e-3 ? [v[0] / speed, v[2] / speed, -v[1] / speed] : [0, 1, 0];
        particle.length =
          Math.min(layer.trail.max, speed * between(layer.trail.time, draw(10))) * INCH;
      }
      out.push(particle);
    }
  }
  return out;
}

/** explosion_hegrenade_sparktrails: three carriers thrown up and out that shed sparks for half
 * a second; each spark inherits half the carrier's velocity and lives 0.125-0.5 s. */
export const sparkLayer: SpriteLayer = {
  id: 'he-sparks',
  texture: 'he-sparks',
  blend: 'add',
  orientation: 'stretch',
  gain: 1,
  cap: 360,
};
export function sparkParticles(detonations: readonly Detonation[]) {
  const out: SpriteParticle[] = [];
  const salt = systemSalt('sparks');
  const color = srgb([252, 209, 187]);
  for (const burst of detonations) {
    if (burst.kind !== 'he' || burst.age > 1.1) continue;
    for (let c = 0; c < 3; c++) {
      const carry: Draw = (k) => unit(burst.seed, salt + c * 977, k);
      const v0 = box(carry, [-1000, -1000, 250], [1000, 1000, 1000], 1);
      // The emission rate falls off with the collection's age (from 200 per second).
      for (let i = 0; i < 60 && out.length < sparkLayer.cap; i++) {
        const birth = (i / 60) ** 1.6 * 0.5;
        const draw: Draw = (k) => unit(burst.seed, salt + c * 977 + (i + 1) * 31, k);
        const life = between([0.125, 0.5], draw(1));
        const age = burst.age - birth;
        if (age < 0 || age >= life) continue;
        const at = travel(v0, birth, -500, 0.025);
        const own = add(
          [at.velocity[0] * 0.5, at.velocity[1] * 0.5, at.velocity[2] * 0.5],
          box(draw, [-50, -50, -50], [50, 50, 50], 2),
        );
        const moved = travel(own, age, -500, 0.025);
        const p = add(at.offset, moved.offset);
        const t = age / life;
        const alpha = t > 0.5 ? 1 - smooth((t - 0.5) / 0.5) : 1;
        const v = moved.velocity,
          speed = Math.hypot(v[0], v[1], v[2]);
        const radius = between([0.01, 0.05], draw(5)) * 25 * (1 - bias(t, 0.25) * 0.9);
        out.push({
          position: [
            (burst.origin[0] + p[0]) * INCH,
            (burst.origin[2] + p[2]) * INCH,
            -(burst.origin[1] + p[1]) * INCH,
          ],
          size: Math.max(0.3, radius) * INCH,
          rotation: 0,
          alpha,
          color,
          life: t,
          sequence: draw(6),
          age,
          axis: speed > 1e-3 ? [v[0] / speed, v[2] / speed, -v[1] / speed] : [0, 1, 0],
          length: Math.min(32, speed * 0.04 * Math.min(1, age / 0.1)) * INCH,
        });
      }
    }
  }
  return out;
}

/** explosion_hegrenade_light: 160 inches of orange light at intensity 3 for 0.225 s, fading
 * over the last three quarters. */
export function detonationLights(detonations: readonly Detonation[]): EffectLight[] {
  const lights: EffectLight[] = [];
  const color = srgb([255, 108, 34]);
  for (const burst of detonations) {
    if (burst.kind !== 'he') continue;
    const t = burst.age / 0.225;
    if (t < 0 || t >= 1) continue;
    const alpha = between([0.705882, 0.784314], unit(burst.seed, 5, 5));
    const fade = t > 0.25 ? 1 - smooth((t - 0.25) / 0.75) : 1;
    const strength = 3 * alpha * fade;
    lights.push({
      position: [burst.origin[0] * INCH, (burst.origin[2] + 15) * INCH, -burst.origin[1] * INCH],
      radius: 160,
      color: [color[0] * strength, color[1] * strength, color[2] * strength],
    });
  }
  return lights;
}

/** The longest any layer of a detonation lives (the scorch). */
export const detonationSeconds = { he: 30, flash: 0.25 } as const;
