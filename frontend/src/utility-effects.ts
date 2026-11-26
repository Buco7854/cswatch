import { infernoLimits, type InfernoBank } from '../../shared/inferno-state.mjs';
import type { GameEvent } from './types';
import { buildUtilityZones } from './utility-state';

const metres = 0.0254;
export const maxFireSprites = 256;
const flameTail = 0.28;
const scorchTail = 1.65;

export type EffectSprite = {
  position: [number, number, number];
  seed: number;
  age: number;
  strength: number;
  secondary: number;
  variant: number;
};

function world(x: number, y: number, z: number): EffectSprite['position'] {
  return [x * metres, z * metres, -y * metres];
}

const ramp = (edge: number, time: number) => {
  const t = Math.min(1, Math.max(0, time / edge));
  return t * t * (3 - 2 * t);
};

type FireSpan = {
  position: EffectSprite['position'];
  seed: number;
  from: number;
  until: number;
  approximate?: boolean;
};

function after<T>(values: T[], tick: number, time: (value: T) => number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (time(values[middle]) <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function indexFireEffects(bank: InfernoBank | undefined, events: GameEvent[], rate: number) {
  const recorded = new Set<string>();
  const spans: FireSpan[] = [];
  for (const { entity, serial, end, updates } of bank?.tracks ?? []) {
    const start = updates[0][0];
    recorded.add(entity + ':' + start);
    const slots: (FireSpan | undefined)[] = [];
    for (const [tick, changes] of updates) {
      for (const change of changes) {
        const slot = change[0];
        const previous = slots[slot];
        if (previous) previous.until = tick;
        if (change.length === 4) {
          const [, x, y, z] = change;
          const { scale } = infernoLimits;
          const span = {
            position: world(x / scale, y / scale, z / scale),
            seed: ((slot * 37 + serial * 17 + start) % 251) / 11,
            from: tick,
            until: end,
          };
          slots[slot] = span;
          spans.push(span);
        } else slots[slot] = undefined;
      }
    }
  }
  const expirations = new Map<number, number[]>();
  for (const event of events) {
    if (event.type !== 'inferno_expire' || !Number.isSafeInteger(event.entityid)) continue;
    const entity = event.entityid as number;
    const ticks = expirations.get(entity) ?? [];
    ticks.push(event.tick);
    expirations.set(entity, ticks);
  }
  for (const ticks of expirations.values()) ticks.sort((a, b) => a - b);
  for (const zone of buildUtilityZones(events, rate, 'fire')) {
    const { entity, start, end, x, y, z } = zone;
    if (recorded.has(entity + ':' + start)) continue;
    const expiries = entity === undefined ? undefined : expirations.get(entity);
    const endTick = expiries?.[after(expiries, start, (expiry) => expiry)];
    const until = endTick === undefined || endTick > end + rate ? end : endTick;
    spans.push({ position: world(x, y, z), seed: start, from: start, until, approximate: true });
  }
  spans.sort((a, b) => a.from - b.from);
  const lastEnd: number[] = [];
  for (const span of spans) lastEnd.push(Math.max(lastEnd.at(-1) ?? 0, span.until));

  const sample = (tick: number, reducedMotion: boolean): EffectSprite[] => {
    const end = after(spans, tick, (span) => span.from);
    const sprites: EffectSprite[] = [];
    const cutoff = tick - rate * scorchTail;
    for (
      let index = end - 1;
      index >= 0 && lastEnd[index] > cutoff && sprites.length < maxFireSprites;
      index--
    ) {
      const { position, seed, from, until, approximate } = spans[index];
      if (until <= cutoff) continue;
      const past = Math.max(0, (tick - until) / rate);
      const fade = 1 - ramp(flameTail, past);
      const cooling = 1 - ramp(scorchTail, past);
      const count = approximate ? 7 : 1;
      for (let i = 0; i < count && sprites.length < maxFireSprites; i++) {
        const ignition = from + (i * rate) / 24;
        if (ignition >= until) break;
        const age = (tick - ignition) / rate;
        const strength = ramp(0.17, age) * fade;
        const secondary = ramp(0.26, age) * cooling;
        if (strength + secondary === 0) break;
        const angle = 2.4 * i + seed * 0.19;
        const spread = 20 * Math.sqrt(i) * metres;
        sprites.push({
          position: approximate
            ? [
                position[0] + Math.cos(angle) * spread,
                position[1],
                position[2] - Math.sin(angle) * spread,
              ]
            : position,
          seed: approximate ? ((seed + i * 23) % 137) / 7 : seed,
          age: reducedMotion ? 0 : age % 120,
          strength: strength * (reducedMotion ? 0.61 : 1),
          secondary,
          variant: approximate ? 1 : 0,
        });
      }
    }
    return sprites;
  };
  /** Recorded (or event-placed) fire points that have ignited and end after `cutoff`. */
  const points = (tick: number, cutoff: number) => {
    const end = after(spans, tick, (span) => span.from);
    const found: FireSpan[] = [];
    for (let index = end - 1; index >= 0 && lastEnd[index] > cutoff; index--)
      if (spans[index].until > cutoff) found.push(spans[index]);
    return found;
  };
  return Object.assign(sample, { points });
}
