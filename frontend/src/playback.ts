import type { GrenadePathsMode } from './grenade-paths';
import type { Playback, Frame } from './types';
import type { PoseTiming } from './player-pose';
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
export type FrameSpan = {
  index: number;
  previous?: Frame;
  frame: Frame;
  next: Frame;
  following?: Frame;
  alpha: number;
};
export function frameAt(data: Pick<Playback, 'frames'>, tick: number): FrameSpan {
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
    index: lo,
    previous: data.frames[lo - 1],
    frame,
    next,
    following: lo + 2 < data.frames.length ? data.frames[lo + 2] : undefined,
    alpha:
      next.tick === frame.tick
        ? 0
        : Math.max(0, Math.min(1, (tick - frame.tick) / (next.tick - frame.tick))),
  };
}
const crossesRound = (data: Pick<Playback, 'rounds'>, from: number, to: number) =>
  data.rounds.some((round) => round.tick > from && round.tick <= to);
/** Interpolation timing for one actor, with the recorded samples on either side
 * of the interval when no round boundary separates them. */
export function poseTimingAt(
  data: Pick<Playback, 'rounds' | 'tickRate'>,
  span: FrameSpan,
  id: string,
): PoseTiming {
  const { previous, frame, next, following } = span;
  const sample = (at: Frame | undefined) => {
    const pose = at?.players.find((player) => player.id === id);
    return pose && { tick: at!.tick, pose };
  };
  return {
    fromTick: frame.tick,
    nextTick: next.tick,
    tickRate: data.tickRate,
    roundBoundary: crossesRound(data, frame.tick, next.tick),
    before:
      previous && !crossesRound(data, previous.tick, frame.tick) ? sample(previous) : undefined,
    after:
      following && !crossesRound(data, next.tick, following.tick) ? sample(following) : undefined,
  };
}
export type DeadTimeFilter = 'all' | 'freeze' | 'timeout';

export function skipDeadTime(
  data: Playback,
  tick: number,
  kind: DeadTimeFilter = 'all',
  lastTick = data.frames.at(-1)!.tick,
) {
  const segment = data.deadTimes?.find(
    (s) =>
      tick >= s.start &&
      tick < s.end &&
      (kind === 'all' || (kind === 'freeze' ? s.kind === 'freeze' : s.kind !== 'freeze')),
  );
  return segment ? Math.min(lastTick, segment.end) : tick;
}
export const KILL_LEAD_INS = [0, 3, 5, 8];
export const UTILITY_LEAD_INS = [0, 1.5, 2, 3, 5, 8];
export const RENDER_RESOLUTION_MIN = 50;
export const RENDER_RESOLUTION_MAX = 100;

export type ViewerSettings = {
  xray: boolean;
  playerLabels: boolean;
  flashFeedback: 'off' | 'indicator' | 'reduced' | 'strong';
  damageFeedback: boolean;
  shotEffects: boolean;
  shotTracers?: boolean;
  autoFollowDeath: boolean;
  crosshair: boolean;
  crosshairStyle: CrosshairStyle;
  crosshairSource: 'custom' | 'player';
  cameraFov: number;
  lookSensitivity: number;
  invertLook: boolean;
  freeCameraSpeed: number;
  teamLayout: 'split' | 'right';
  matchScore: boolean;
  reviewFeed: boolean;
  utilities: boolean;
  trajectories: GrenadePathsMode;
  trails: boolean;
  radar: boolean;
  killfeed: boolean;
  autoSkipFreeze: boolean;
  autoSkipTimeouts: boolean;
  inputs: boolean;
  mouseInput: boolean;
  inputDetails: boolean;
  controlsHidden: boolean;
  autoHideControls: boolean;
  grenadeLanding: boolean;
  killReplay: boolean;
  killLeadIn: number;
  utilityLeadIn: number;
  renderResolution: number;
  economy: boolean;
  inputLayout: 'wasd' | 'zqsd';
  voice: boolean;
  subtitles: boolean;
  chat: boolean;
  voiceScope: 'selected' | 'team' | 'all';
  voiceVolume: number;
  gameSounds: boolean;
  gameVolume: number;
  audioVolume: number;
  audioMuted: boolean;
  spatialAudio: boolean;
  soundWeapons: boolean;
  soundFootsteps: boolean;
  soundReloads: boolean;
  soundUtility: boolean;
  soundObjectives: boolean;
  soundRounds: boolean;
  quality: 'auto' | 'low' | 'high';
};
export const defaultSettings: ViewerSettings = {
  xray: true,
  playerLabels: true,
  flashFeedback: 'indicator',
  damageFeedback: true,
  shotEffects: true,
  autoFollowDeath: true,
  crosshair: true,
  crosshairStyle: defaultCrosshairStyle,
  crosshairSource: 'custom',
  cameraFov: 73.74,
  lookSensitivity: 1,
  invertLook: false,
  freeCameraSpeed: 8,
  teamLayout: 'split',
  matchScore: true,
  reviewFeed: true,
  utilities: true,
  trajectories: 'all',
  trails: false,
  radar: true,
  killfeed: true,
  autoSkipFreeze: false,
  autoSkipTimeouts: false,
  inputs: false,
  mouseInput: false,
  inputDetails: false,
  controlsHidden: false,
  autoHideControls: false,
  grenadeLanding: true,
  killReplay: true,
  killLeadIn: 3,
  utilityLeadIn: 1.5,
  renderResolution: RENDER_RESOLUTION_MAX,
  economy: true,
  inputLayout: 'zqsd',
  voice: false,
  subtitles: false,
  chat: false,
  voiceScope: 'selected',
  voiceVolume: 0.7,
  gameSounds: true,
  gameVolume: 0.8,
  audioVolume: 1,
  audioMuted: false,
  spatialAudio: true,
  soundWeapons: true,
  soundFootsteps: true,
  soundReloads: true,
  soundUtility: true,
  soundObjectives: true,
  soundRounds: true,
  quality: 'auto',
};
export function shotTracersEnabled(
  settings: Pick<ViewerSettings, 'quality' | 'shotTracers'>,
  mobileOrCompact: boolean,
) {
  return (
    settings.shotTracers ??
    (!mobileOrCompact && (settings.quality === 'auto' || settings.quality === 'high'))
  );
}

export const viewerPreferenceKey = (mobile: boolean) =>
  mobile ? 'viewer-settings-v2-mobile' : 'viewer-settings-v2';

export function readSettings(mobile = false): ViewerSettings {
  const defaults = mobile
    ? { ...defaultSettings, economy: false, reviewFeed: false }
    : defaultSettings;
  try {
    const saved = JSON.parse(localStorage.getItem(viewerPreferenceKey(mobile)) || '{}');
    const settings = { ...defaults };
    if (typeof saved.shotTracers === 'boolean') settings.shotTracers = saved.shotTracers;
    for (const k of Object.keys(defaultSettings) as (keyof ViewerSettings)[]) {
      if (
        k !== 'crosshairStyle' &&
        typeof saved[k] === typeof settings[k] &&
        (k !== 'inputLayout' || ['wasd', 'zqsd'].includes(saved[k])) &&
        (k !== 'voiceScope' || ['selected', 'team', 'all'].includes(saved[k])) &&
        (k !== 'trajectories' || ['all', 'selected', 'off'].includes(saved[k])) &&
        (k !== 'flashFeedback' || ['off', 'indicator', 'reduced', 'strong'].includes(saved[k])) &&
        (!['voiceVolume', 'gameVolume', 'audioVolume'].includes(k) ||
          (Number.isFinite(saved[k]) && saved[k] >= 0 && saved[k] <= 1)) &&
        (k !== 'killLeadIn' || KILL_LEAD_INS.includes(saved[k])) &&
        (k !== 'utilityLeadIn' || UTILITY_LEAD_INS.includes(saved[k])) &&
        (k !== 'renderResolution' ||
          (Number.isInteger(saved[k]) &&
            saved[k] >= RENDER_RESOLUTION_MIN &&
            saved[k] <= RENDER_RESOLUTION_MAX)) &&
        (k !== 'quality' || ['auto', 'low', 'high'].includes(saved[k])) &&
        (k !== 'lookSensitivity' ||
          (Number.isFinite(saved[k]) && saved[k] >= 0.25 && saved[k] <= 2)) &&
        (k !== 'freeCameraSpeed' ||
          (Number.isFinite(saved[k]) && saved[k] >= 2 && saved[k] <= 24)) &&
        (k !== 'cameraFov' || (Number.isFinite(saved[k]) && saved[k] >= 40 && saved[k] <= 110)) &&
        (k !== 'teamLayout' || ['split', 'right'].includes(saved[k])) &&
        (k !== 'crosshairSource' || ['custom', 'player'].includes(saved[k]))
      )
        (settings as any)[k] = saved[k];
    }
    settings.crosshairStyle = normalizeCrosshairStyle(saved.crosshairStyle);
    return settings;
  } catch {
    return { ...defaults, crosshairStyle: { ...defaultCrosshairStyle } };
  }
}
