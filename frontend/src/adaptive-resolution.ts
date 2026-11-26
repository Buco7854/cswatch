import { RENDER_RESOLUTION_MIN } from './playback';

const FRAME_WINDOW = 30;
const MIN_WINDOW_FRAMES = 8;
const WINDOW_MS = 1500;
const SLOW_FRAME_MS = 25;
const FAST_FRAME_MS = 19;
const TARGET_FRAME_MS = 20;
const STALL_MS = 100;
const SHADOW_RESOLUTION_THRESHOLD = 80;
const SETTLE_MS = 750;
const RESOLUTION_STEP = 10;
/** A resolution change reallocates the canvas and every target sized from it, and makes
 * the GPU finish its queued work. Each level is held at least this long. */
const HOLD_MS = 8000;
/** Raising the resolution needs this long of uninterrupted fast frames. */
const UPGRADE_AFTER_MS = 15000;

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
  private elapsedMs = 0;
  private fastSince?: number;
  private resizedAt = -Infinity;

  reset() {
    this.stalls = this.stalledMs = this.elapsedMs = 0;
    this.previous = undefined;
    this.windowStarted = undefined;
    this.fastSince = undefined;
    this.frames = this.slow = this.fast = 0;
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
    this.elapsedMs += elapsed;
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
    const fastWindow = this.fast >= this.frames * 0.9;
    const slowWindow = stalling || this.slow >= this.frames * 0.7;
    const meanFrame = this.elapsedMs / this.frames;
    this.frames = this.slow = this.fast = this.stalls = this.stalledMs = this.elapsedMs = 0;
    this.windowStarted = undefined;
    if (!fastWindow) this.fastSince = undefined;
    else this.fastSince ??= now - windowMs;

    let shadows = current.shadows && allowShadows;
    let next = current.resolution;
    const holding = now - this.resizedAt < HOLD_MS;
    if (slowWindow) {
      // Live shadows go first: dropping them changes no buffer size.
      if (shadows && (current.resolution <= SHADOW_RESOLUTION_THRESHOLD || stalling))
        shadows = false;
      else if (!holding) {
        // Pixel work scales with the square of the resolution. Step straight to the level
        // the measured frame time calls for instead of resizing again and again.
        const needed = current.resolution * Math.sqrt(TARGET_FRAME_MS / Math.max(meanFrame, 1));
        next = Math.max(
          RENDER_RESOLUTION_MIN,
          Math.min(
            current.resolution - RESOLUTION_STEP,
            Math.floor(needed / RESOLUTION_STEP) * RESOLUTION_STEP,
          ),
        );
      }
    } else if (
      !holding &&
      this.fastSince !== undefined &&
      now - this.fastSince >= UPGRADE_AFTER_MS &&
      current.resolution < ceiling
    ) {
      next = Math.min(ceiling, current.resolution + RESOLUTION_STEP);
      this.fastSince = now;
    }
    if (
      allowShadows &&
      !shadows &&
      current.resolution === ceiling &&
      this.fastSince !== undefined &&
      now - this.fastSince >= UPGRADE_AFTER_MS
    )
      shadows = true;
    if (next !== current.resolution || shadows !== current.shadows) {
      if (next !== current.resolution) this.resizedAt = now;
      this.settledAt = now + SETTLE_MS;
      return { resolution: next, shadows };
    }
    return current;
  }
}
