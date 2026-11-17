import type { Playback, Frame } from './types';
import { defaultCrosshairStyle, normalizeCrosshairStyle, type CrosshairStyle } from './crosshair';
export function playbackBounds(data: Playback) {
  if (data.worldBounds) return data.worldBounds;
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const frame of data.frames)
    for (const player of frame.players) {
      bounds.minX = Math.min(bounds.minX, player.x);
      bounds.maxX = Math.max(bounds.maxX, player.x);
      bounds.minY = Math.min(bounds.minY, player.y);
      bounds.maxY = Math.max(bounds.maxY, player.y);
      bounds.minZ = Math.min(bounds.minZ, player.z);
      bounds.maxZ = Math.max(bounds.maxZ, player.z);
    }
  return bounds;
}
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
export function skipDeadTime(
  data: Playback,
  tick: number,
  kind: 'all' | 'timeout' = 'all',
  lastTick = data.frames.at(-1)!.tick,
) {
  const segment = data.deadTimes?.find(
    (s) => tick >= s.start && tick < s.end && (kind === 'all' || s.kind !== 'freeze'),
  );
  return segment ? Math.min(lastTick, segment.end) : tick;
}
export type ViewerSettings = {
  xray: boolean;
  crosshair: boolean;
  crosshairStyle: CrosshairStyle;
  cameraFov: number;
  teamLayout: 'split' | 'right';
  matchScore: boolean;
  reviewFeed: boolean;
  utilities: boolean;
  trajectories: boolean;
  trails: boolean;
  radar: boolean;
  killfeed: boolean;
  autoSkip: boolean;
  inputs: boolean;
  mouseInput: boolean;
  inputDetails: boolean;
  controlsHidden: boolean;
  autoHideControls: boolean;
  grenadeLanding: boolean;
  killReplay: boolean;
  economy: boolean;
  inputLayout: 'wasd' | 'zqsd';
  voice: boolean;
  subtitles: boolean;
  chat: boolean;
  voiceScope: 'selected' | 'team' | 'all';
  voiceVolume: number;
  quality: 'auto' | 'low' | 'high';
};
export const defaultSettings: ViewerSettings = {
  xray: true,
  crosshair: true,
  crosshairStyle: defaultCrosshairStyle,
  cameraFov: 48,
  teamLayout: 'split',
  matchScore: true,
  reviewFeed: false,
  utilities: true,
  trajectories: true,
  trails: false,
  radar: true,
  killfeed: true,
  autoSkip: false,
  inputs: false,
  mouseInput: false,
  inputDetails: false,
  controlsHidden: false,
  autoHideControls: true,
  grenadeLanding: true,
  killReplay: true,
  economy: false,
  inputLayout: 'zqsd',
  voice: false,
  subtitles: false,
  chat: false,
  voiceScope: 'selected',
  voiceVolume: 0.7,
  quality: 'auto',
};
export function readSettings(): ViewerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem('viewer-settings') || '{}');
    const settings = { ...defaultSettings };
    for (const k of Object.keys(defaultSettings) as (keyof ViewerSettings)[]) {
      if (
        k !== 'crosshairStyle' &&
        typeof saved[k] === typeof settings[k] &&
        (k !== 'inputLayout' || ['wasd', 'zqsd'].includes(saved[k])) &&
        (k !== 'voiceScope' || ['selected', 'team', 'all'].includes(saved[k])) &&
        (k !== 'voiceVolume' || (Number.isFinite(saved[k]) && saved[k] >= 0 && saved[k] <= 1)) &&
        (k !== 'quality' || ['auto', 'low', 'high'].includes(saved[k])) &&
        (k !== 'cameraFov' || (Number.isFinite(saved[k]) && saved[k] >= 40 && saved[k] <= 110)) &&
        (k !== 'teamLayout' || ['split', 'right'].includes(saved[k]))
      )
        (settings as any)[k] = saved[k];
    }
    settings.crosshairStyle = normalizeCrosshairStyle(saved.crosshairStyle);
    return settings;
  } catch {
    return { ...defaultSettings, crosshairStyle: { ...defaultCrosshairStyle } };
  }
}
