import { createContext } from 'react';

// The mounted canvas drives presentation time. A timer samples it for React and
// also drives playback in 2D while no compositor is attached.
export class ReplayFrames {
  tick = 0;
  private advance: ((now: number) => number) | undefined;
  private invalidate: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  attach(invalidate: () => void) {
    this.invalidate = invalidate;
    invalidate();
    return () => {
      if (this.invalidate === invalidate) this.invalidate = undefined;
    };
  }
  sample(now: number) {
    if (this.advance && !document.hidden) {
      this.tick = this.advance(now);
      this.invalidate?.();
    }
  }
  play(advance: (now: number) => number, publish: (tick: number) => void) {
    this.advance = advance;
    this.invalidate?.();
    this.timer = setInterval(() => {
      if (document.hidden) return;
      if (!this.invalidate) this.sample(performance.now());
      publish(this.tick);
    }, 100);
    return () => {
      clearInterval(this.timer);
      this.advance = undefined;
      publish(this.tick);
    };
  }
}
export const ReplayFrameContext = createContext<ReplayFrames | null>(null);
