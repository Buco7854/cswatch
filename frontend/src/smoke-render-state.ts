import { useEffect, useMemo, useRef, useState } from 'react';
import { smokeLimits, type SmokeTrack } from '../../shared/smoke-state.mjs';

type SmokeTarget = { key: string; track: SmokeTrack; updateTick: number; offset: number };
export type SmokeDensityRequest = { targets: SmokeTarget[] };
export type SmokeDensityResult = { key: string; updateTick: number; cells?: Float32Array };

function targetAt(track: SmokeTrack, tick: number): SmokeTarget | undefined {
  if (tick < track.start || tick >= track.end) return;
  let low = 0;
  let high = track.updates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (track.updates[middle][0] <= tick) low = middle + 1;
    else high = middle;
  }
  const [updateTick, offset] = track.updates[low - 1];
  return {
    key: track.entity + ':' + track.serial + ':' + track.start,
    track,
    updateTick,
    offset,
  };
}

/** One local worker per visible scene. A slow response never queues old frames or survives a seek. */
export function useSmokeDensity(
  tracks: SmokeTrack[] | undefined,
  tick: number,
  rate: number,
  playing: boolean,
) {
  const [responses, setResponses] = useState<{
    tracks: SmokeTrack[];
    rows: SmokeDensityResult[];
  }>();
  const controller = useRef<((targets: SmokeTarget[]) => void) | undefined>(undefined);
  const targets = useMemo(() => {
    const result: SmokeTarget[] = [];
    for (const track of tracks ?? []) {
      if (track.start > tick || result.length >= smokeLimits.active) break;
      const target = targetAt(track, tick);
      if (target) result.push(target);
    }
    return result;
  }, [tracks, tick]);
  useEffect(() => {
    if (!tracks?.length || typeof Worker === 'undefined') return;
    let worker: Worker | undefined;
    let active = true;
    let waiting = false;
    let last = '';
    let latest: SmokeTarget[] = [];
    const send = () => {
      if (waiting || !active) return;
      const request = latest.map(({ key, offset }) => key + '@' + offset).join('|');
      if (request === last) return;
      if (!latest.length && !worker) return;
      last = request;
      if (!worker) {
        try {
          worker = new Worker(new URL('./smoke-density.worker.ts', import.meta.url), {
            type: 'module',
          });
        } catch {
          active = false;
          return;
        }
        worker.onmessage = ({ data }: MessageEvent<SmokeDensityResult[]>) => {
          if (!active) return;
          setResponses({ tracks, rows: data });
          waiting = false;
          send();
        };
        worker.onerror = () => {
          active = false;
          worker?.terminate();
          setResponses(undefined);
        };
      }
      waiting = true;
      worker.postMessage({ targets: latest } satisfies SmokeDensityRequest);
    };
    controller.current = (target) => {
      latest = target;
      send();
    };
    return () => {
      active = false;
      controller.current = undefined;
      worker?.terminate();
    };
  }, [tracks]);
  useEffect(() => controller.current?.(targets), [tracks, targets]);

  if (responses?.tracks !== tracks) return [];
  return targets.flatMap(({ key, track, updateTick }) => {
    const reply = responses?.rows.find((item) => item.key === key);
    // During continuous playback retain at most half a second of earlier density.
    if (
      !reply?.cells ||
      reply.updateTick > updateTick ||
      updateTick - reply.updateTick > (playing ? rate / 2 : 0)
    )
      return [];
    return [{ key, track, cells: reply.cells }];
  });
}
