export type ScreenRect = { left: number; top: number; right: number; bottom: number };

export type ActorOverlayLayout = {
  rectangles: ScreenRect[];
  dockTop?: number;
  titleBottom?: number;
  invalidate?: () => void;
};

export function overlapsOverlay(box: ScreenRect, occupied: readonly ScreenRect[], gap = 0) {
  return occupied.some(
    (other) =>
      box.left < other.right + gap &&
      box.right > other.left - gap &&
      box.top < other.bottom + gap &&
      box.bottom > other.top - gap,
  );
}

const labelGap = 2;
/** The chevron under a label name; matches `.actor-label-marker` at scale 1. */
export const actorMarkerSize = { width: 10, height: 6 };
const nearDistance = 10;
const farDistance = 45;

/** Nearby players keep a full-size label; distant ones shrink and fade a little. */
export function actorLabelStyle(meters: number, occluded: boolean) {
  const far = Math.min(1, Math.max(0, (meters - nearDistance) / (farDistance - nearDistance)));
  return {
    scale: Math.round((1 - 0.1 * far) * 50) / 50,
    opacity: Math.round((occluded ? 0.75 - 0.15 * far : 1 - 0.15 * far) * 20) / 20,
  };
}

/**
 * The label's bottom centre stays on the projected head; it is never moved
 * away from its player. A label that would collide shrinks to its chevron,
 * and a chevron that would collide is hidden.
 */
export function placeActorLabel(
  x: number,
  bottom: number,
  size: { width: number; height: number },
  scale: number,
  viewport: { width: number; height: number },
  occupied: readonly ScreenRect[],
): { box: ScreenRect; compact: boolean } | undefined {
  const fit = (width: number, height: number) => {
    const left = Math.round(x - width / 2);
    const box = { left, top: Math.round(bottom - height), right: left + width, bottom };
    if (box.left < 0 || box.top < 0 || box.right > viewport.width || box.bottom > viewport.height)
      return;
    return overlapsOverlay(box, occupied, labelGap) ? undefined : box;
  };
  const full = fit(size.width * scale, size.height * scale);
  if (full) return { box: full, compact: false };
  const marker = fit(actorMarkerSize.width * scale, actorMarkerSize.height * scale);
  if (marker) return { box: marker, compact: true };
}
