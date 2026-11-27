import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { c4BeepCues } from './c4-beeps';
import { brassCues } from './brass';
import { silencerCues } from './silencer-cues';
import { indexWeaponFire } from './weapon-fire';
import type { GameplaySoundInfo, SharedGameplaySoundCatalog } from '../../shared/gameplay-sounds';
import type { Playback } from './types';
import { frameAt, type ViewerSettings } from './playback';
import { GameplayPlayback } from './gameplay-playback';
import { fetchGameplaySoundCatalog, gameplaySoundCategories } from './gameplay-sound-assets';
import { ViewerAudio, useViewerAudioState } from './viewer-audio';
import type { WallTrace } from './shot-wall-audio';

export const soundCategorySettings = {
  weapon: 'soundWeapons',
  footstep: 'soundFootsteps',
  reload: 'soundReloads',
  utility: 'soundUtility',
  objective: 'soundObjectives',
  round: 'soundRounds',
} as const;
export type GameplayAudioReport = {
  status: 'loading' | 'ready' | 'missing' | 'error' | 'unavailable';
  coverage?: GameplaySoundInfo;
  installed: number;
  missing: number;
  error: string;
  retry: () => void;
};
const empty: SharedGameplaySoundCatalog = { schemaVersion: 1, items: {} };
const silent: GameplaySoundCueArray = [];
type GameplaySoundCueArray = NonNullable<Playback['sounds']>;

export function useGameplayAudio({
  identity,
  audio,
  data,
  tick,
  playing,
  speed,
  selected,
  mode,
  settings,
  cameraReady,
  wallTrace,
}: {
  identity: string;
  audio: ViewerAudio;
  data: Playback | null;
  tick: number;
  playing: boolean;
  speed: number;
  selected: string;
  mode: string;
  settings: ViewerSettings;
  cameraReady: MutableRefObject<boolean>;
  wallTrace: MutableRefObject<WallTrace | undefined>;
}): GameplayAudioReport {
  const audioState = useViewerAudioState(audio);
  const [assets, setAssets] = useState<{
    identity: string;
    catalog: SharedGameplaySoundCatalog;
    status: GameplayAudioReport['status'];
  }>({ identity, catalog: empty, status: 'loading' });
  const [failure, setFailure] = useState({ identity, message: '' });
  const engine = useRef<GameplayPlayback | null>(null);
  const [retry, setRetry] = useState(0);
  // Recorded cues plus the C4 beeps derived from the recorded plant and timer, and brass.
  const cues = useMemo(() => {
    if (!data) return undefined;
    const beeps = c4BeepCues(data.objectives, data.tickRate, (actor, tick) => {
      const at = frameAt(data, tick).frame;
      if (Math.abs(at.tick - tick) > data.tickRate / 4) return undefined;
      const player = at.players.find((candidate) => candidate.id === actor);
      return player ? { x: player.x, y: player.y, z: player.z } : undefined;
    });
    // Casings landing after recorded shots (Bounce.Shell is client-side in CS2, too).
    const shots = [...indexWeaponFire(data)].flatMap(([actor, list]) =>
      list.map((shot) => ({ ...shot, actor, seed: Math.imul(shot.tick | 0, 7919) })),
    );
    const brass = brassCues(shots, data.tickRate, (actor, tick) => {
      const at = frameAt(data, tick).frame;
      if (Math.abs(at.tick - tick) > data.tickRate / 4) return undefined;
      return at.players.find((candidate) => candidate.id === actor && candidate.alive);
    });
    const silencer = silencerCues(data);
    return beeps.length || brass.length || silencer.length
      ? [...(data.sounds || []), ...beeps, ...brass, ...silencer].sort((a, b) => a.tick - b.tick)
      : data.sounds;
  }, [data]);
  const neededKey = useMemo(
    () => [...new Set((cues || []).map((cue) => cue.soundId))].sort().join(','),
    [cues],
  );
  const enabled = Boolean(
    data?.gameplaySounds &&
    gameplaySoundCategories.some(
      (category) => data.gameplaySounds!.coverage[category] !== 'unavailable',
    ),
  );
  const discoveryScope = useMemo(
    () => ({ identity, started: Date.now() }),
    [identity, enabled, retry],
  );
  const previousAssets = useRef(assets);
  const loadedDiscovery = useRef<object | null>(null);
  previousAssets.current = assets;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let catalog =
      previousAssets.current.identity === identity ? previousAssets.current.catalog : empty;
    let attempt = 0;
    if (!enabled)
      return () => {
        controller.abort();
      };
    if (!Object.keys(catalog.items).length)
      setAssets({ identity, catalog: empty, status: 'loading' });
    setFailure({ identity, message: '' });
    const needs = neededKey.split(',').filter(Boolean);
    if (
      loadedDiscovery.current === discoveryScope &&
      Object.keys(catalog.items).length &&
      needs.every((id) => catalog.items[id])
    )
      return () => {
        active = false;
        controller.abort();
      };
    const schedule = () => {
      if (!active || Date.now() - discoveryScope.started >= 180000) return;
      const delay = [2000, 5000, 15000][Math.min(attempt++, 2)];
      if (Date.now() + delay - discoveryScope.started <= 180000)
        timer = setTimeout(() => void load(), delay);
    };
    async function load() {
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(abort, 10000);
      try {
        const incoming = await fetchGameplaySoundCatalog(request.signal);
        if (!active || controller.signal.aborted) return;
        const merged = {
          schemaVersion: 1 as const,
          items: { ...catalog.items, ...incoming.items },
        };
        const changed =
          Object.keys(merged.items).length !== Object.keys(catalog.items).length ||
          Object.entries(merged.items).some(
            ([id, item]) => catalog.items[id]?.sha256 !== item.sha256,
          );
        catalog = changed ? merged : catalog;
        loadedDiscovery.current = discoveryScope;
        const status = Object.keys(catalog.items).length
          ? ('ready' as const)
          : ('missing' as const);
        setAssets((previous) =>
          previous.identity === identity &&
          previous.catalog === catalog &&
          previous.status === status
            ? previous
            : { identity, catalog, status },
        );
        if (!Object.keys(catalog.items).length || needs.some((id) => !catalog.items[id]))
          schedule();
      } catch {
        if (active) {
          if (!Object.keys(catalog.items).length) setAssets({ identity, catalog, status: 'error' });
          schedule();
        }
      } finally {
        clearTimeout(deadline);
        controller.signal.removeEventListener('abort', abort);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [identity, enabled, neededKey, discoveryScope]);
  const current =
    assets.identity === identity
      ? assets
      : { identity, catalog: empty, status: 'loading' as const };
  useEffect(() => {
    const value = new GameplayPlayback(audio, empty, (message) =>
      setFailure((previous) =>
        previous.identity === identity && previous.message === message
          ? previous
          : { identity, message },
      ),
    );
    engine.current = value;
    return () => {
      value.close();
      if (engine.current === value) engine.current = null;
    };
  }, [identity, audio, retry]);
  useEffect(() => {
    engine.current?.updateCatalog(current.catalog);
  }, [current.catalog, identity, audio, retry]);
  const categories = useMemo(
    () => gameplaySoundCategories.filter((category) => settings[soundCategorySettings[category]]),
    [
      settings.soundWeapons,
      settings.soundFootsteps,
      settings.soundReloads,
      settings.soundUtility,
      settings.soundObjectives,
      settings.soundRounds,
    ],
  );
  const active =
    playing &&
    settings.gameSounds &&
    !settings.audioMuted &&
    settings.audioVolume > 0 &&
    settings.gameVolume > 0 &&
    audioState === 'running';
  useEffect(() => {
    if (!active || !data) {
      engine.current?.stop();
      return;
    }
    // Tactical/no-WebGL views listen from the selected recorded player. The
    // actual free/POV/follow camera supplies its own listener in 3D.
    const frame = frameAt(data, tick).frame;
    if (!cameraReady.current || mode === '2d') {
      const actor = frame.players.find((player) => player.id === selected);
      if (actor) {
        const yaw = (actor.yaw * Math.PI) / 180;
        audio.setListener({
          position: [actor.x * 0.0254, actor.z * 0.0254 + 1.65, -actor.y * 0.0254],
          forward: [Math.cos(yaw), 0, -Math.sin(yaw)],
          up: [0, 1, 0],
        });
      }
    }
    engine.current?.sync(
      cues || silent,
      tick,
      data.tickRate,
      speed,
      settings.gameVolume,
      categories,
      settings.spatialAudio,
      `${selected}:${mode}`,
      (cue) => {
        const at = frameAt(data, cue.tick).frame;
        if (Math.abs(at.tick - cue.tick) > data.tickRate / 4) return;
        return at.players.find((player) => player.id === cue.actor);
      },
      mode === 'pov' ? selected : undefined,
      data.rounds,
      mode === '2d' ? undefined : wallTrace.current,
    );
  }, [
    active,
    data,
    cues,
    tick,
    speed,
    selected,
    mode,
    categories,
    settings.gameVolume,
    settings.spatialAudio,
    audio,
    wallTrace,
    current.catalog,
  ]);
  const missing = useMemo(
    () =>
      new Set(
        (cues || []).filter((cue) => !current.catalog.items[cue.soundId]).map((cue) => cue.soundId),
      ).size,
    [cues, current.catalog],
  );
  return {
    status: enabled ? current.status : 'unavailable',
    coverage: data?.gameplaySounds,
    installed: Object.keys(current.catalog.items).length,
    missing,
    error: failure.identity === identity ? failure.message : '',
    retry: useCallback(() => setRetry((value) => value + 1), []),
  };
}
