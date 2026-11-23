import type { MapOverview } from '../../shared/map-assets';

/** Valve overview coordinates use Source inches and a top-left Source origin.
 * Positive Source Y points upward on the image. Reference pixels stay1024 even
 * when an operator supplies a differently sized square raster. */
export function overviewPoint(overview: MapOverview, point: { x: number; y: number }) {
  const span = overview.scale * overview.referenceSize;
  return { x: (point.x - overview.origin.x) / span, y: (overview.origin.y - point.y) / span };
}
export function overviewRadius(overview: MapOverview, sourceUnits: number) {
  return sourceUnits / (overview.scale * overview.referenceSize);
}

/** A square window into the calibrated image. Rotation and image coordinates
 * stay the same for the raster, players, paths and utility radii. */
export function radarWindow(
  overview: MapOverview,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
) {
  const topLeft = overviewPoint(overview, { x: bounds.minX, y: bounds.maxY });
  const bottomRight = overviewPoint(overview, { x: bounds.maxX, y: bounds.minY });
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  if (
    !Number.isFinite(width + height) ||
    width <= 0 ||
    height <= 0 ||
    topLeft.x < 0 ||
    topLeft.y < 0 ||
    bottomRight.x > 1 ||
    bottomRight.y > 1
  )
    return;
  const size = Math.min(1, Math.max(0.5, Math.max(width, height) / 0.9));
  const start = (a: number, b: number) => Math.max(0, Math.min(1 - size, (a + b - size) / 2));
  return {
    x: 10 + start(topLeft.x, bottomRight.x) * 100,
    y: 10 + start(topLeft.y, bottomRight.y) * 100,
    size: size * 100,
  };
}
