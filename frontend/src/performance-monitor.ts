/** Frame timing and rendering counters for the optional performance overlay. Recording is a
 * timestamp in a ring buffer per frame; summaries are computed only when the overlay
 * refreshes, a few times per second. */
export type WorldFrameStats = {
  draws: number;
  triangles: number;
  textureBytes: number;
  bufferBytes?: number;
};
export type PerformanceSummary = {
  fps: number;
  p50: number;
  p95: number;
  worst: number;
  long: number;
  frames: number;
  draws: number;
  triangles: number;
};

/** A frame this long misses two 60 Hz refreshes and reads as a hitch. */
export const LONG_FRAME_MS = 50;
const capacity = 1024;

export class PerformanceMonitor {
  enabled = false;
  world?: WorldFrameStats;
  extra = { draws: 0, triangles: 0 };
  private times = new Float64Array(capacity);
  private next = 0;
  private count = 0;

  frame(now: number) {
    this.times[this.next] = now;
    this.next = (this.next + 1) % capacity;
    this.count = Math.min(capacity, this.count + 1);
  }

  reset() {
    this.next = this.count = 0;
    this.world = undefined;
    this.extra = { draws: 0, triangles: 0 };
  }

  /** Statistics over the frames of the last `windowMs`. */
  summary(now: number, windowMs = 3000): PerformanceSummary {
    const intervals: number[] = [];
    let previous: number | undefined, first: number | undefined;
    for (let i = 0; i < this.count; i++) {
      const time = this.times[(this.next - this.count + i + capacity) % capacity];
      if (now - time > windowMs) continue;
      first ??= time;
      if (previous !== undefined) intervals.push(time - previous);
      previous = time;
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
    const span = previous !== undefined && first !== undefined ? previous - first : 0;
    return {
      fps: span > 0 ? (intervals.length * 1000) / span : 0,
      p50: at(0.5),
      p95: at(0.95),
      worst: sorted.at(-1) ?? 0,
      long: intervals.filter((interval) => interval >= LONG_FRAME_MS).length,
      frames: intervals.length + (first === undefined ? 0 : 1),
      draws: (this.world?.draws ?? 0) + this.extra.draws,
      triangles: (this.world?.triangles ?? 0) + this.extra.triangles,
    };
  }
}

export const performanceMonitor = new PerformanceMonitor();
