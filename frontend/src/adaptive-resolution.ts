import { RENDER_RESOLUTION_MIN } from './playback';

const FRAME_WINDOW = 30;
const MIN_WINDOW_FRAMES = 8;
const WINDOW_MS = 1500;
const SLOW_FRAME_MS = 25;
const FAST_FRAME_MS = 19;
const STALL_MS = 100;
const STALL_STEP = 25;
const FAST_WINDOWS_TO_UPGRADE = 4;
const SHADOW_RESOLUTION_THRESHOLD = 80;
const SETTLE_MS = 750;
const RESOLUTION_STEP = 10;

export type RenderQuality = { resolution: number; shadows: boolean };

/** A dense mobile target fits one megapixel at 100%. Explicit High can spend
 * four megapixels on extra detail while preserving its regular desktop scale. */
export function mapDetailDpr(deviceScale: number, area: number, tier: 'mobile' | 'desktop') {
  const scale = Math.max(1, deviceScale);
  const high = tier === 'desktop';
  const pixelBudget = (high ? 4 : 1) * 1024 ** 2;
  const bounded = Math.min(
    scale,
    high ? 3 : 2,
    Math.max(1, Math.sqrt(pixelBudget / Math.max(1, area))),
  );
  return high ? Math.max(bounded, Math.min(1.75, scale)) : bounded;
}

/** Scale the additional high-density pixels away first, reaching the original
 * half-CSS-pixel emergency floor. A fixed user ceiling stays proportional. */
export function adaptiveDetailDpr(targetDpr: number, resolution: number, ceiling: number) {
  const maxDpr = targetDpr * (ceiling / 100);
  const floor = RENDER_RESOLUTION_MIN / 100;
  // An explicit ceiling at 50% still means half of the display target.
  if (resolution >= ceiling) return maxDpr;
  if (resolution <= RENDER_RESOLUTION_MIN) return floor;
  const headroom = (resolution - RENDER_RESOLUTION_MIN) / (ceiling - RENDER_RESOLUTION_MIN);
  return floor + headroom * (maxDpr - floor);
}

/** Adjust pixel and live shadow work under sustained load without changing the map tier. */
export class AdaptiveResolution {
  private previous?: number;
  private settledAt = 0;
  private windowStarted?: number;
  private frames = 0;
  private slow = 0;
  private fast = 0;
  private stalls = 0;
  private stalledMs = 0;
  private fastWindows = 0;

  reset() {
    this.stalls = this.stalledMs = 0;
    this.previous = undefined;
    this.windowStarted = undefined;
    this.frames = this.slow = this.fast = this.fastWindows = 0;
  }

  sample(now: number, current: RenderQuality, ceiling: number, allowShadows = true): RenderQuality {
    const previous = this.previous;
    this.previous = now;
    if (previous === undefined) {
      this.settledAt = now + SETTLE_MS;
      return current;
    }
    if (now <= this.settledAt) return current;
    const elapsed = now - previous;
    if (elapsed <= 0) return current;
    this.windowStarted ??= previous;
    this.frames++;
    if (elapsed > SLOW_FRAME_MS) this.slow++;
    if (elapsed <= FAST_FRAME_MS) this.fast++;
    if (elapsed >= STALL_MS) {
      this.stalls++;
      this.stalledMs += elapsed;
    }
    // Under heavy backpressure a handful of long gaps can consume nearly the
    // whole window even when most individual intervals look fast. Wait for
    // three separate stalls; one shader compile or seek should not lower quality.
    const windowMs = now - this.windowStarted;
    const stalling = this.stalls >= 3 && windowMs >= 600 && this.stalledMs >= windowMs * 0.7;
    if (
      !stalling &&
      this.frames < FRAME_WINDOW &&
      (this.frames < MIN_WINDOW_FRAMES || now - this.windowStarted < WINDOW_MS)
    )
      return current;

    this.fastWindows = this.fast >= this.frames * 0.9 ? this.fastWindows + 1 : 0;
    const slowWindow = stalling || this.slow >= this.frames * 0.7;
    let shadows = current.shadows && allowShadows;
    // Try dropping live shadows before spending another step of image detail.
    // Further slow windows can still reach the existing emergency pixel floor.
    const suspendShadows =
      slowWindow && shadows && (current.resolution <= SHADOW_RESOLUTION_THRESHOLD || stalling);
    if (suspendShadows) shadows = false;
    let next = current.resolution;
    if (slowWindow && !suspendShadows) {
      next = Math.max(
        RENDER_RESOLUTION_MIN,
        current.resolution - (stalling ? STALL_STEP : RESOLUTION_STEP),
      );
    } else if (this.fastWindows >= FAST_WINDOWS_TO_UPGRADE) {
      next = Math.min(ceiling, current.resolution + RESOLUTION_STEP);
    }
    if (
      allowShadows &&
      current.resolution === ceiling &&
      this.fastWindows >= FAST_WINDOWS_TO_UPGRADE
    )
      shadows = true;
    this.frames = this.slow = this.fast = this.stalls = this.stalledMs = 0;
    this.windowStarted = undefined;
    if (next !== current.resolution || shadows !== current.shadows) {
      this.fastWindows = 0;
      this.settledAt = now + SETTLE_MS;
      return { resolution: next, shadows };
    }
    return current;
  }
}
