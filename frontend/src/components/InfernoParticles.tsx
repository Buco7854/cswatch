import { useMemo } from 'react';
import { fireLayers, fireParticles, type FireLayerId, type FirePoint } from '../inferno-particles';
import type { EffectTextures } from '../effect-textures';
import EffectSprites, { type SpriteLayer } from './EffectSprites';

const blend: Record<FireLayerId, SpriteLayer['blend']> = {
  scorch: 'alpha',
  glow: 'mod2x',
  ground: 'add',
  smoke: 'alpha',
  flame: 'add',
  ember: 'add',
};
const overbright: Record<FireLayerId, number> = {
  scorch: 1,
  glow: 2,
  ground: 2.5,
  smoke: 1,
  flame: 2.5,
  ember: 2,
};
const layers: SpriteLayer[] = (
  ['scorch', 'glow', 'ground', 'smoke', 'flame', 'ember'] as FireLayerId[]
).map((id) => ({
  id,
  texture: fireLayers[id].texture,
  blend: blend[id],
  orientation: fireLayers[id].orientation,
  gain: overbright[id],
  cap: fireLayers[id].cap,
  fps: fireLayers[id].fps || undefined,
  // molotov_child_flame01a and molotov_smoking_ground_child01 feather against the world.
  feather: id === 'flame' ? 20 : id === 'smoke' ? 30 : undefined,
}));

/** The official inferno layers over recorded fire points, from prepared atlases. */
export default function InfernoParticles({
  points,
  time,
  textures,
  displayScale,
}: {
  points: readonly FirePoint[];
  time: number;
  textures: EffectTextures;
  displayScale: number;
}) {
  const particles = useMemo(
    () =>
      Object.fromEntries(
        layers
          .filter((layer) => textures[layer.texture])
          .map((layer) => [layer.id, fireParticles(layer.id as FireLayerId, points, time)]),
      ),
    [points, time, textures],
  );
  return (
    <EffectSprites
      name="inferno-particles"
      layers={layers}
      particles={particles}
      textures={textures}
      displayScale={displayScale}
    />
  );
}
