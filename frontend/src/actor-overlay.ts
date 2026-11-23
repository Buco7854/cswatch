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

const labelGap = 3;
const maximumLabelOffset = 56;

export function placeActorLabel(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: { width: number; height: number },
  occupied: readonly ScreenRect[],
) {
  const left = Math.round(x - width / 2);
  const right = left + width;
  if (left < 0 || right > viewport.width) return;
  const preferredTop = Math.round(y - height / 2);
  const minTop = Math.max(0, preferredTop - maximumLabelOffset);
  const maxTop = Math.min(Math.floor(viewport.height - height), preferredTop + maximumLabelOffset);
  if (minTop > maxTop) return;

  const boxAt = (top: number) => ({ left, top, right, bottom: top + height });
  const preferred = boxAt(Math.max(minTop, Math.min(maxTop, preferredTop)));
  if (!overlapsOverlay(preferred, occupied, labelGap)) return preferred;

  // A free vertical slot starts or ends at a blocker edge. Checking the
  // rounded edges finds slots a sequence of fixed offsets can skip.
  const edges = [];
  for (const box of occupied) {
    if (left >= box.right + labelGap || right <= box.left - labelGap) continue;
    edges.push(Math.floor(box.top - height - labelGap), Math.ceil(box.bottom + labelGap));
  }
  edges.sort((a, b) => Math.abs(a - preferredTop) - Math.abs(b - preferredTop) || a - b);
  for (const top of edges) {
    if (top < minTop || top > maxTop) continue;
    const box = boxAt(top);
    if (!overlapsOverlay(box, occupied, labelGap)) return box;
  }
}
