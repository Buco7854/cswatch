const FRAME_WINDOW = 30;
const MIN_WINDOW_FRAMES = 8;
const WINDOW_MS = 1500;
const SLOW_FRAME_MS = 25;
const FAST_FRAME_MS = 19;
const FAST_WINDOWS_TO_UPGRADE = 4;
const SLOW_WINDOWS_TO_SUSPEND_SHADOWS = 2;
const SETTLE_MS = 750;
const RESOLUTION_STEP = 10;
const MIN_RESOLUTION = 50;

export type RenderQuality = { resolution: number; shadows: boolean };

/** Adjust pixel and live shadow work under sustained load without changing the map tier. */
export class AdaptiveResolution {
  private previous?: number;
  private settledAt = 0;
  private windowStarted?: number;
  private frames = 0;
  private slow = 0;
  private fast = 0;
  private fastWindows = 0;
  private slowAtFloor = 0;

  reset() {
    this.previous = undefined;
    this.windowStarted = undefined;
    this.frames = this.slow = this.fast = this.fastWindows = this.slowAtFloor = 0;
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
    if (
      this.frames < FRAME_WINDOW &&
      (this.frames < MIN_WINDOW_FRAMES || now - this.windowStarted < WINDOW_MS)
    )
      return current;

    this.fastWindows = this.fast >= this.frames * 0.9 ? this.fastWindows + 1 : 0;
    const slowWindow = this.slow >= this.frames * 0.7;
    this.slowAtFloor =
      slowWindow && current.resolution === MIN_RESOLUTION ? this.slowAtFloor + 1 : 0;
    const next = slowWindow
      ? Math.max(MIN_RESOLUTION, current.resolution - RESOLUTION_STEP)
      : this.fastWindows >= FAST_WINDOWS_TO_UPGRADE
        ? Math.min(ceiling, current.resolution + RESOLUTION_STEP)
        : current.resolution;
    let shadows = current.shadows && allowShadows;
    if (this.slowAtFloor >= SLOW_WINDOWS_TO_SUSPEND_SHADOWS) shadows = false;
    if (
      allowShadows &&
      current.resolution === ceiling &&
      this.fastWindows >= FAST_WINDOWS_TO_UPGRADE
    )
      shadows = true;
    this.frames = this.slow = this.fast = 0;
    this.windowStarted = undefined;
    if (next !== current.resolution || shadows !== current.shadows) {
      this.fastWindows = this.slowAtFloor = 0;
      this.settledAt = now + SETTLE_MS;
      return { resolution: next, shadows };
    }
    return current;
  }
}
