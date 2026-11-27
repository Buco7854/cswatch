import { useContext, useEffect, useMemo } from 'react';
import type { WorldQueries } from '../world/queries';
import type { GameEvent } from '../types';
import type { EffectTextures } from '../effect-textures';
import { buildUtilityZones } from '../utility-state';
import {
  burstLayers,
  burstParticles,
  detonationLights,
  detonationSeconds,
  sparkLayer,
  sparkParticles,
  type Detonation,
} from '../explosion-particles';
import { NativePasses } from '../world/frame-context';
import EffectSprites from './EffectSprites';

export const detonationTextures = [
  ...new Set([...burstLayers.map((layer) => layer.texture), sparkLayer.texture]),
];
const layers = [...burstLayers, sparkLayer];
// The most detonations drawn at once; scorches stay for the newest sixteen.
const maxActive = 6;
const maxScorches = 16;

/** Official HE and flashbang particle systems at recorded detonations. */
export default function DetonationEffects({
  events,
  tick,
  rate,
  textures,
  displayScale,
  reducedMotion,
  queries,
}: {
  queries?: WorldQueries | null;
  events: GameEvent[];
  tick: number;
  rate: number;
  textures: EffectTextures;
  displayScale: number;
  reducedMotion: boolean;
}) {
  const recorded = useMemo(
    () =>
      [...buildUtilityZones(events, rate, 'he'), ...buildUtilityZones(events, rate, 'flash')].sort(
        (a, b) => a.start - b.start,
      ),
    [events, rate],
  );
  // The surface below each detonation, traced once (200 inches down at most).
  // A miss is retried once more of the world has streamed in.
  const floors = useMemo(() => new Map<string, { floor?: number; revision: number }>(), [queries]);
  const revision = queries?.revision ?? 0;
  const floorOf = (id: string, origin: readonly [number, number, number]) => {
    if (!queries) return undefined;
    const known = floors.get(id);
    if (!known || (known.floor === undefined && known.revision !== revision)) {
      if (floors.size > 256) floors.clear();
      const found = queries.hit({
        target: [origin[0] * 0.0254, (origin[2] + 1) * 0.0254, -origin[1] * 0.0254],
        position: [origin[0] * 0.0254, (origin[2] - 200) * 0.0254, -origin[1] * 0.0254],
      });
      floors.set(id, { floor: found ? found.point.y / 0.0254 : undefined, revision });
    }
    return floors.get(id)?.floor;
  };
  const detonations = useMemo(() => {
    const found: Detonation[] = [];
    let scorches = 0;
    for (let i = recorded.length - 1; i >= 0; i--) {
      const zone = recorded[i];
      if (zone.start > tick) continue;
      const kind = zone.kind as Detonation['kind'];
      const exact = (tick - zone.start) / rate;
      if (exact >= detonationSeconds.he) break;
      if (exact >= detonationSeconds[kind]) continue;
      if (kind === 'flash' && reducedMotion) continue;
      // Only the scorch outlives eight seconds.
      if (exact > 8 && ++scorches > maxScorches) continue;
      if (exact <= 8 && found.filter((d) => d.age <= 8).length >= maxActive) continue;
      found.push({
        id: zone.id,
        kind,
        origin: [zone.x, zone.y, zone.z],
        floor: floorOf(zone.id, [zone.x, zone.y, zone.z]),
        // Reduced motion holds each detonation on one sampled moment per second.
        age: reducedMotion ? Math.floor(exact) : exact,
        seed: Math.imul(zone.start | 0, 2654435761) ^ (zone.entity ?? 0) ^ (i * 40503),
      });
    }
    return found;
  }, [recorded, tick, rate, reducedMotion, floors, revision]);
  const particles = useMemo(
    () =>
      Object.fromEntries([
        ...burstLayers
          .filter((layer) => textures[layer.texture])
          .map((layer) => [layer.id, burstParticles(layer, detonations)]),
        [sparkLayer.id, textures[sparkLayer.texture] ? sparkParticles(detonations) : []],
      ]),
    [detonations, textures],
  );
  const native = useContext(NativePasses);
  const lights = useMemo(() => detonationLights(detonations), [detonations]);
  useEffect(() => {
    if (!native) return;
    native.lights ??= new Map();
    native.lights.set('detonations', lights);
  }, [native, lights]);
  useEffect(() => () => void native?.lights?.delete('detonations'), [native]);
  return (
    <EffectSprites
      name="detonation-particles"
      layers={layers}
      particles={particles}
      textures={textures}
      displayScale={displayScale}
    />
  );
}
