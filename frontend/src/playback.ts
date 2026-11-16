import type { Playback, Frame } from './types';
export function frameAt(
  data: Playback,
  tick: number,
): { frame: Frame; next: Frame; alpha: number } {
  let lo = 0,
    hi = data.frames.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (data.frames[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  const frame = data.frames[lo],
    next = data.frames[Math.min(lo + 1, data.frames.length - 1)];
  return {
    frame,
    next,
    alpha:
      next.tick === frame.tick
        ? 0
        : Math.max(0, Math.min(1, (tick - frame.tick) / (next.tick - frame.tick))),
  };
}
export function skipDeadTime(data: Playback, tick: number, kind: 'all' | 'timeout' = 'all') {
  const segment = data.deadTimes?.find(
    (s) => tick >= s.start && tick < s.end && (kind === 'all' || s.kind !== 'freeze'),
  );
  return segment ? Math.min(data.frames.at(-1)!.tick, segment.end) : tick;
}
export type ViewerSettings = {
  xray: boolean;
  crosshair: boolean;
  utilities: boolean;
  trajectories: boolean;
  trails: boolean;
  radar: boolean;
  killfeed: boolean;
  autoSkip: boolean;
  quality: 'auto' | 'low' | 'high';
};
export const defaultSettings: ViewerSettings = {
  xray: true,
  crosshair: true,
  utilities: true,
  trajectories: true,
  trails: false,
  radar: true,
  killfeed: true,
  autoSkip: false,
  quality: 'auto',
};
export function readSettings(): ViewerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem('viewer-settings') || '{}');
    const settings = { ...defaultSettings };
    for (const k of Object.keys(defaultSettings) as (keyof ViewerSettings)[]) {
      if (
        typeof saved[k] === typeof settings[k] &&
        (k !== 'quality' || ['auto', 'low', 'high'].includes(saved[k]))
      )
        (settings as any)[k] = saved[k];
    }
    return settings;
  } catch {
    return defaultSettings;
  }
}
