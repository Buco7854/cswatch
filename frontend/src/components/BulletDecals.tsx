import { useMemo } from 'react';
import type { Playback } from '../types';
import { useEffectTextures } from '../effect-textures';
import type { WorldQueries } from '../world/queries';
import { recordedShotRay, type ShotRay } from '../shot-ray';
import { createShotRayCache } from '../shot-tracer';
import { impactSurfaceProperty } from '../shot-impacts';
import { roundAt } from '../review-events';
import { useTracerEvidence } from './EquipmentFire';
import EffectSprites, { type SpriteLayer, type SpriteParticle } from './EffectSprites';

/** One representative official decal per impact decal group (scripts/decalgroups.vdata):
 * each group's first material's g_tColor. */
export const decalTextures: Record<string, string> = {
  'Impact.Concrete': 'decal-concrete',
  'Impact.Metal': 'decal-metal',
  'Impact.Wood': 'decal-wood',
  'Impact.Glass': 'decal-glass',
  'Impact.Tile': 'decal-tile',
  'Impact.Dirt': 'decal-dirt',
  'Impact.Plaster': 'decal-plaster',
  'Impact.Rock': 'decal-rock',
  'Impact.Vent': 'decal-vent',
};
const decalTextureIds = [...new Set(Object.values(decalTextures))];
// The newest bullet holes of the round; the official decals stay until the round restarts.
const maxDecals = 96;
// No official file gives a bullet hole's world size; three inches across the hole and its marks.
const decalRadius = 3 * 0.0254;
const layers: SpriteLayer[] = [...new Set(Object.values(decalTextures))].map((texture) => ({
  id: texture,
  texture,
  blend: 'alpha',
  orientation: 'surface',
  gain: 1,
  cap: maxDecals,
}));

/** Official bullet-hole decals where recorded shots of the current round meet the map. */
export default function BulletDecals({
  data,
  tick,
  queries,
  materials,
  displayScale,
}: {
  data: Playback;
  tick: number;
  queries: Pick<WorldQueries, 'hit' | 'revision'>;
  materials: readonly { name: string }[];
  displayScale: number;
}) {
  const textures = useEffectTextures(true, decalTextureIds);
  const evidence = useTracerEvidence();
  const rays = useMemo(() => createShotRayCache<ShotRay | null>(512), [queries, evidence?.index]);
  const last = data.frames.at(-1)?.tick ?? tick;
  const particles = useMemo(() => {
    const result: Record<string, SpriteParticle[]> = {};
    if (!evidence?.index || evidence.reducedMotion) return result;
    const start = roundAt(data, tick, last).start;
    const shots: { id: string; tick: number }[] = [];
    for (const [id, list] of evidence.index)
      for (let i = list.length - 1; i >= 0 && list[i].tick >= start; i--)
        if (list[i].tick <= tick) shots.push({ id, tick: list[i].tick });
    shots.sort((a, b) => b.tick - a.tick);
    let count = 0;
    for (const shot of shots) {
      if (count >= maxDecals) break;
      const ray = rays.resolve(shot.id, shot.tick, () =>
        recordedShotRay(data, shot.id, shot.tick, queries),
      );
      if (!ray || ray.material === undefined || !ray.normal) continue;
      const group = impactSurfaceProperty(materials[ray.material]?.name).decal;
      const texture = decalTextures[group];
      if (!texture || !textures[texture]) continue;
      const seed = (Math.imul(shot.tick, 2654435761) ^ shot.id.length) >>> 0;
      (result[texture] ??= []).push({
        position: ray.to,
        size: decalRadius,
        rotation: (seed / 4294967296) * Math.PI * 2,
        alpha: 1,
        color: [1, 1, 1],
        life: 0,
        sequence: 0,
        age: 0,
        axis: ray.normal,
      });
      count++;
    }
    return result;
  }, [
    data,
    tick,
    last,
    evidence?.index,
    evidence?.reducedMotion,
    rays,
    queries,
    materials,
    textures,
  ]);
  return (
    <EffectSprites
      name="bullet-decals"
      layers={layers}
      particles={particles}
      textures={textures}
      displayScale={displayScale}
    />
  );
}
