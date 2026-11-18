import { decodeCrosshairShareCode } from 'csgo-sharecode';
import type { Playback } from '../../shared/playback';
import type { CrosshairSample } from '../../shared/crosshairs';

export type RecordedCrosshairTimeline = {
  actors: ReadonlyMap<string, readonly CrosshairSample[]>;
  complete: boolean;
  lastTick: number;
};

/** Global metadata survives time-slice replacement. Each lookup is independent
 * of previous playback/selection, so seeking backwards cannot retain a code. */
export function buildRecordedCrosshairTimeline(
  data: Pick<Playback, 'players' | 'crosshairs'> | null,
): RecordedCrosshairTimeline {
  const empty = (): RecordedCrosshairTimeline => ({
    actors: new Map(),
    complete: false,
    lastTick: -1,
  });
  const source = data?.crosshairs;
  if (!data || !source || !Array.isArray(source.samples) || source.samples.length > 10000)
    return empty();
  const declared = new Set(data.players.map((player) => player.id));
  const actors = new Map<string, CrosshairSample[]>();
  let lastTick = -1;
  for (const sample of source.samples) {
    if (
      !sample ||
      typeof sample !== 'object' ||
      !Number.isSafeInteger(sample.tick) ||
      sample.tick < 0 ||
      sample.tick > 64 * 60 * 180 ||
      sample.tick < lastTick ||
      !declared.has(sample.actor) ||
      (sample.code !== null && (typeof sample.code !== 'string' || sample.code.length > 64))
    )
      return empty();
    const samples = actors.get(sample.actor) ?? [];
    samples.push(sample);
    actors.set(sample.actor, samples);
    lastTick = sample.tick;
  }
  return { actors, complete: source.complete === true, lastTick };
}

/** Partial collection never establishes settings beyond its last known tick. */
export function recordedCrosshairAt(
  timeline: RecordedCrosshairTimeline,
  actor: string,
  tick: number,
): string | undefined {
  if (
    !Number.isFinite(tick) ||
    tick < 0 ||
    tick > 64 * 60 * 180 ||
    (!timeline.complete && tick > timeline.lastTick)
  )
    return;
  const samples = timeline.actors.get(actor);
  if (!samples?.length) return;
  let low = 0,
    high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return samples[low - 1]?.code ?? undefined;
}

export type RecordedCrosshair = {
  color: string;
  opacity: number;
  outlineColor: string;
  outlineOpacity: number;
  outline: number;
  length: number;
  thickness: number;
  gap: number;
  dot: boolean;
  tStyle: boolean;
  shape: 'cross' | 'circle' | 'dot' | 'square';
  dynamic: boolean;
  format: string;
};
const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

/** Decode bounded actual network settings. This is a static shape, never a
 * claim that native weapon spread, recoil or scope state has been simulated. */
export function recordedCrosshair(code: unknown, height = 1080): RecordedCrosshair | null {
  if (typeof code !== 'string' || code.length > 64 || code.length < 30) return null;
  try {
    const c = decodeCrosshairShareCode(code);
    // This renderer does not reproduce native Quad geometry yet.
    // Missing support must stay unavailable instead of becoming a generic cross.
    if (c.format !== 'legacy-v1' && [7, 9].includes(c.style)) return null;
    const reference = c.format === 'legacy-v1' ? 480 : c.screenHeight;
    if (!Number.isFinite(reference) || reference <= 0) return null;
    const scale = Math.min(2160, Math.max(240, height)) / reference;
    const outlineMode = 'outlineMode' in c ? c.outlineMode : c.outlineEnabled ? 1 : 0;
    const legacyColors = ['#ff0000', '#00ff00', '#ffff00', '#0000ff', '#00ffff'];
    return {
      color:
        c.format === 'legacy-v1' && c.color < 5
          ? legacyColors[c.color]
          : rgb(c.red, c.green, c.blue),
      opacity: c.format === 'legacy-v1' && !c.alphaEnabled ? 1 : c.alpha / 255,
      outlineColor:
        c.format === 'cs2-v1' ? rgb(c.outlineRed, c.outlineGreen, c.outlineBlue) : '#000000',
      outlineOpacity: c.format === 'cs2-v1' ? c.outlineAlpha / 255 : 1,
      outline: outlineMode
        ? (c.format === 'legacy-v1' ? c.outline : outlineMode === 2 ? 0.5 : 1) * scale
        : 0,
      length: c.length * scale,
      thickness: c.thickness * scale,
      gap: (c.format === 'legacy-v1' ? c.gap + 4 : c.gap) * scale,
      dot: c.centerDotEnabled,
      tStyle: c.tStyleEnabled,
      shape:
        c.format === 'legacy-v1'
          ? 'cross'
          : c.style === 6
            ? 'dot'
            : c.style === 1 || c.style === 3
              ? 'circle'
              : c.style === 8
                ? 'square'
                : 'cross',
      dynamic:
        c.followRecoil ||
        (c.format === 'legacy-v1' ? c.style !== 4 : [0, 1, 2, 5, 7].includes(c.style)),
      format: c.format,
    };
  } catch {
    return null;
  }
}
