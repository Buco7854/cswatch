import { useMemo } from 'react';
import { grenadePathEvents, indexGrenadePaths } from '../grenade-paths';
import type { Playback } from '../types';

export function useGrenadePaths(data: Playback) {
  const events = useMemo(() => grenadePathEvents(data.events), [data.events]);
  return useMemo(
    () => indexGrenadePaths(data.grenades, events, data.players, data.tickRate, data.frames),
    [data.grenades, events, data.players, data.tickRate, data.frames],
  );
}
