import type { UtilityZone } from './utility-state';
import type { EffectSprite } from './utility-effects';

export const maxBursts = 6;
export const maxImpactSprites = maxBursts * 52;
export const burstKind = { fire: 0, dust: 1, spark: 2, flash: 3, halo: 4, wisp: 5 } as const;

type Point = EffectSprite['position'];
type Burst = {
  id: string;
  origin: Point;
  sprites: EffectSprite[];
  light: number;
  flash: boolean;
};

function ease(from: number, until: number, age: number) {
  const t = Math.min(1, Math.max(0, (age - from) / (until - from)));
  return t * t * (3 - 2 * t);
}

const variation = (seed: number) => {
  const x = Math.sin(seed * 19.19 + 0.25) * 23171.713;
  return x - Math.floor(x);
};

/** Sample all envelopes, offsets and ballistic streaks at the requested demo time. */
export function sampleGrenadeBursts(
  zones: UtilityZone[],
  tick: number,
  rate: number,
  reduced: boolean,
): Burst[] {
  const bursts: Burst[] = [];
  for (let i = zones.length - 1; i >= 0 && bursts.length < maxBursts; i--) {
    const zone = zones[i];
    if (zone.kind === 'smoke' || zone.kind === 'fire' || tick < zone.start || tick >= zone.end)
      continue;

    const age = (tick - zone.start) / rate;
    const seed = (zone.start % 829) + ((zone.entity ?? 0) % 137) / 137;
    const origin: Point = [zone.x * 0.0254, zone.z * 0.0254, -zone.y * 0.0254];
    const sprites: EffectSprite[] = [];
    const add = (
      kind: number,
      offset: Point,
      radius: number,
      alpha: number,
      heat: number,
      index: number,
    ) => {
      if (alpha <= 0.001) return;
      sprites.push({
        position: [origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]],
        seed: bursts.length + variation(seed + index) * 0.99,
        // The burst shader uses the shared first scalar channel for metres.
        age: radius,
        strength: alpha,
        secondary: heat,
        variant: kind,
      });
    };
    const flash = zone.kind === 'flash';
    let light = 0;
    if (zone.kind === 'he') {
      const cool = 1 - ease(0.5, 1.55, age);
      const grow = reduced ? 0.75 : ease(0.02, 0.64, age);
      const dust = ease(0.02, 0.24, age) * cool * (reduced ? 0.24 : 0.65);
      for (let n = 0; n < 28; n++) {
        const theta = n * 2.39996 + seed;
        const spread = (0.39 + 0.99 * variation(seed + n + 2)) * grow;
        const height = 0.24 + variation(seed + n + 93) * (0.5 + grow * 0.65);
        add(
          burstKind.dust,
          [Math.cos(theta) * spread, height, Math.sin(theta) * spread],
          (0.29 + 0.49 * grow) * (0.74 + 0.36 * variation(seed + n + 10)),
          dust * (0.42 + 0.54 * variation(seed + n)),
          reduced ? 0 : age,
          n,
        );
      }
      if (!reduced) {
        const expansion = ease(0, 0.235, age);
        const hot = 1 - ease(0.04, 0.25, age);
        const glow = 1 - ease(0.155, 0.35, age);
        for (let n = 0; n < 9; n++) {
          const theta = n * 2.39996 + seed;
          const spread = n ? 0.25 + expansion * 0.49 : 0;
          add(
            burstKind.fire,
            [
              Math.cos(theta) * spread,
              0.16 + 0.48 * expansion * variation(seed + 27 + n),
              Math.sin(theta) * spread,
            ],
            (0.46 + 0.28 * expansion) * (n ? 0.63 + 0.26 * variation(seed + n) : 1.15),
            glow * (n ? 0.85 : 1),
            hot * (n ? 0.73 + 0.26 * variation(seed + n) : 1),
            50 + n,
          );
        }
        const core = 1 - ease(0.054, 0.089, age);
        add(burstKind.flash, [0, 0.19, 0], 0.61, core, 1, 91);
        add(burstKind.halo, [0, 0.21, 0], 1.21, core * 0.71, 1, 92);
        for (let n = 0; n < 13; n++) {
          const angle = n * 2.39996 + seed;
          const speed = 4 + variation(seed + n + 71) * 8;
          const flight = age - 0.025 * variation(seed + n * 2.3 + 81);
          if (flight < 0) continue;
          const height = 0.27 + (3 + 3 * variation(seed + n + 22)) * flight - 6 * flight * flight;
          const alpha = 1 - ease(0.07, 0.25 + variation(seed + n) * 0.15, age);
          add(
            burstKind.spark,
            [Math.cos(angle) * speed * flight, height, Math.sin(angle) * speed * flight],
            (0.12 + variation(seed + n + 12) * 0.19) * ease(0, 0.075, flight),
            alpha * (0.5 + 0.5 * variation(seed + n + 132)),
            angle,
            n + 110,
          );
        }
        light = core * 70 + glow * 16;
      }
    } else {
      const drift = reduced ? 0.13 : age;
      const pop = reduced ? 0 : 1 - ease(0.034, flash ? 0.091 : 0.071, age);
      const smoke = (reduced ? 0.23 : 0.52) * ease(0, 0.1, age) * (1 - ease(0.18, 0.52, age));
      for (let n = 0; n < 5; n++)
        add(
          burstKind.wisp,
          [
            (n - 2) * (0.14 + drift * 0.25),
            0.16 + n * (0.07 + drift * 0.09) + drift * 0.24,
            Math.sin(n * 2.4 + seed) * (0.09 + drift * 0.22),
          ],
          (0.23 + drift * 0.55) * (n % 2 ? 0.75 : 1),
          smoke * (flash ? 1 : 0.35),
          drift,
          n,
        );
      add(burstKind.flash, [0, 0.13, 0], flash ? 0.43 : 0.23, pop, 0, 11);
      add(burstKind.halo, [0, 0.16, 0], flash ? 0.93 : 0.48, pop * 0.89, 0, 12);
      light = flash ? pop * 82 : 0;
    }
    if (sprites.length) bursts.push({ id: zone.id, origin, sprites, light, flash });
  }
  return bursts;
}
