/** Visible playback follows monotonic time, independently of delivered render-frame frequency. */
export class PlaybackClock {
  private anchorTick = 0;
  private anchorTime = 0;
  tick = 0;
  reset(tick: number, now: number) {
    this.tick = this.anchorTick = Number.isFinite(tick) ? tick : 0;
    this.anchorTime = Number.isFinite(now) ? now : 0;
  }
  at(now: number, ticksPerSecond: number, availableUntil: number) {
    const elapsed = Math.max(0, (now - this.anchorTime) / 1000),
      rate = Number.isFinite(ticksPerSecond) ? Math.max(0, ticksPerSecond) : 0;
    const proposed = this.anchorTick + elapsed * rate,
      limit = Number.isFinite(availableUntil)
        ? Math.max(this.anchorTick, availableUntil)
        : this.anchorTick;
    this.tick = Math.min(proposed, limit);
    // Time spent waiting for an unavailable slice must not become a catch-up jump.
    if (proposed > limit) this.reset(limit, now);
    return this.tick;
  }
}
