/** Bullet impacts on the world at the point a recorded shot meets the prepared map. */
export const impactLifetime = 0.7;
export const impactReach = 80;
export const maxImpacts = 16;
export const spritesPerImpact = 7;

export type ImpactSurface = 'metal' | 'wood' | 'soil' | 'glass' | 'mineral';
export const impactStyle = { dust: 0, spark: 1, chip: 2, flash: 3 } as const;

/** Surface families from the authored material name; the game's own surface
 * properties are not part of the exported pack. */
export function impactSurface(name: string | undefined): ImpactSurface {
  const value = (name ?? '').toLowerCase();
  if (/metal|steel|iron|grate|vent|pipe|chainlink|fence|rail|tin|copper|aluminum/.test(value))
    return 'metal';
  if (/glass|window/.test(value)) return 'glass';
  if (/wood|plank|crate|door|beam|timber|pallet/.test(value)) return 'wood';
  if (/sand|dirt|mud|soil|gravel|grass|ground/.test(value)) return 'soil';
  return 'mineral';
}

export type ImpactSprite = {
  position: [number, number, number];
  /** Unit direction of travel for sparks and chips; the outward normal for dust. */
  axis: [number, number, number];
  size: number;
  alpha: number;
  style: number;
  seed: number;
  color: [number, number, number];
};

const unit = (seed: number) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const dust: Record<ImpactSurface, [number, number, number]> = {
  mineral: [0.66, 0.61, 0.53],
  soil: [0.62, 0.51, 0.37],
  wood: [0.47, 0.36, 0.24],
  metal: [0.42, 0.41, 0.4],
  glass: [0.7, 0.73, 0.75],
};

/** Deterministic sprites for one impact at its age (seconds), facing back along
 * the recorded shot. Seeking to the same tick yields the same sprites. */
export function impactSprites(
  point: [number, number, number],
  direction: [number, number, number],
  surface: ImpactSurface,
  age: number,
  seed: number,
): ImpactSprite[] {
  if (age < 0 || age >= impactLifetime) return [];
  const back: [number, number, number] = [-direction[0], -direction[1], -direction[2]];
  const sprites: ImpactSprite[] = [];
  const t = age / impactLifetime;
  const at = (distance: number, axis: [number, number, number]) =>
    point.map((value, i) => value + axis[i] * distance) as [number, number, number];
  // A short bright flash on hard surfaces.
  if (age < 0.05 && surface !== 'soil')
    sprites.push({
      position: at(0.02, back),
      axis: back,
      size: surface === 'metal' ? 0.16 : 0.1,
      alpha: 1 - age / 0.05,
      style: impactStyle.flash,
      seed,
      color: surface === 'metal' ? [1.6, 1.2, 0.6] : [1.1, 1.0, 0.85],
    });
  // A puff that rises off the surface, grows and thins.
  for (let i = 0; i < 2; i++) {
    const spread = 0.05 + 0.5 * (1 - (1 - t) ** 2.5) * (0.6 + 0.4 * unit(seed + i));
    sprites.push({
      position: [
        point[0] + back[0] * spread,
        point[1] + back[1] * spread + 0.08 * t,
        point[2] + back[2] * spread,
      ],
      axis: back,
      size: (surface === 'soil' ? 0.36 : 0.3) * (0.35 + t) * (0.8 + 0.4 * unit(seed + 3 + i)),
      alpha: (surface === 'metal' ? 0.35 : 0.6) * (1 - t) ** 1.5,
      style: impactStyle.dust,
      seed: seed + i,
      color: dust[surface],
    });
  }
  // Sparks off metal, chips off wood and stone, flying out ballistically.
  const debris = surface === 'metal' ? 4 : surface === 'glass' ? 3 : surface === 'soil' ? 0 : 3;
  for (let i = 0; i < debris; i++) {
    const a = unit(seed + 10 + i) * Math.PI * 2,
      lift = 0.3 + 0.6 * unit(seed + 20 + i);
    const out: [number, number, number] = [
      back[0] + Math.cos(a) * 0.7,
      back[1] + lift,
      back[2] + Math.sin(a) * 0.7,
    ];
    const length = Math.hypot(...out);
    const axis = out.map((value) => value / length) as [number, number, number];
    const speed = surface === 'metal' ? 6 : 3;
    const flight = Math.min(age, surface === 'metal' ? 0.25 : 0.5);
    const position = at(speed * flight, axis);
    position[1] -= 4.9 * flight * flight;
    sprites.push({
      position,
      axis,
      size: surface === 'metal' ? 0.07 : 0.025,
      alpha: surface === 'metal' ? Math.max(0, 1 - age / 0.25) : (1 - t) * 0.9,
      style: surface === 'metal' ? impactStyle.spark : impactStyle.chip,
      seed: seed + 30 + i,
      color:
        surface === 'metal'
          ? [1.8, 1.1, 0.4]
          : surface === 'glass'
            ? [0.7, 0.75, 0.8]
            : (dust[surface].map((v) => v * 0.7) as [number, number, number]),
    });
  }
  return sprites.slice(0, spritesPerImpact);
}
