import { Box3, Matrix4, Vector3 } from 'three';
/** Unit direction toward the sun and linear RGB color, in viewer coordinates. */
export type SourceSun = Readonly<{ directionToSun: Triplet; color: Triplet }>;

type Triplet = [number, number, number];
export type MapSun = {
  color: Triplet;
  position: Triplet;
  target: Triplet;
  up: Triplet;
  shadow: { left: number; right: number; bottom: number; top: number; near: number; far: number };
};

function finiteTriplet(value: unknown): value is Triplet {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    [0, 1, 2].every((index) => Number.isFinite(value[index]))
  );
}

/** Imported energy uses engine units. Only direction and linear color are
 * authored evidence. Fit one static shadow volume to the rendered main map. */
export function mapSun(source: SourceSun | null, bounds?: Box3): MapSun | null {
  if (!source) return null;
  if (
    !finiteTriplet(source.directionToSun) ||
    !finiteTriplet(source.color) ||
    !source.color.every((value) => value >= 0 && value <= 1) ||
    !source.color.some((value) => value > 0)
  )
    return null;
  // SourceSun promises a unit direction. Bound it before constructing matrices:
  // lengthSq can overflow on finite but malformed values and normalize to zero.
  const length = Math.hypot(...source.directionToSun);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-3) return null;
  const direction = new Vector3(...source.directionToSun);
  direction.normalize();
  const up: Triplet = Math.abs(direction.y) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const usable =
    bounds &&
    !bounds.isEmpty() &&
    [...bounds.min, ...bounds.max].every((x) => Number.isFinite(x) && Math.abs(x) <= 100_000);
  if (!usable)
    return {
      color: [...source.color],
      position: direction.multiplyScalar(50).toArray() as Triplet,
      target: [0, 0, 0],
      up,
      shadow: { left: -45, right: 45, bottom: -45, top: 45, near: 0.5, far: 500 },
    };
  const center = bounds.getCenter(new Vector3()),
    radius = Math.max(1, bounds.getSize(new Vector3()).length() / 2),
    margin = Math.max(2, radius * 0.02),
    position = center.clone().addScaledVector(direction, radius + margin + 1),
    view = new Matrix4()
      .lookAt(position, center, new Vector3(...up))
      .setPosition(position)
      .invert(),
    lightBounds = new Box3();
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z])
        lightBounds.expandByPoint(new Vector3(x, y, z).applyMatrix4(view));
  const near = Math.max(0.1, -lightBounds.max.z - margin);
  return {
    color: [...source.color],
    position: position.toArray() as Triplet,
    target: center.toArray() as Triplet,
    up,
    shadow: {
      left: lightBounds.min.x - margin,
      right: lightBounds.max.x + margin,
      bottom: lightBounds.min.y - margin,
      top: lightBounds.max.y + margin,
      near,
      far: Math.max(near + 1, -lightBounds.min.z + margin),
    },
  };
}
