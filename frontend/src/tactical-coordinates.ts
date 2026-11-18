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
