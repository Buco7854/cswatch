import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, Frustum, Matrix4, Vector3 } from 'three';
import { smokeLimits, type SmokeTrack } from '../../shared/smoke-state.mjs';
import {
  HALF_GRID,
  scenePoint,
  smooth,
  smokeTransmittance,
  type SmokeField,
  type SmokeSample,
  type XYZ,
} from './smoke-field';

type SmokeTarget = {
  key: string;
  track: SmokeTrack;
  offset: number;
  previousOffset: number;
  updateTick: number;
  fadeTicks: number;
};
export type SmokeDensityRequest = { targets: SmokeTarget[]; sun: XYZ };
export type SmokeDensityResult = {
  key: string;
  offset: number;
  previous?: SmokeField;
  current?: SmokeField;
  stoppedAt?: number;
};

function targetAt(track: SmokeTrack, tick: number, rate: number): SmokeTarget | undefined {
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
    previousOffset: track.updates[low - 2]?.[1] ?? offset,
    fadeTicks: Math.min(rate * 0.1, (track.updates[low]?.[0] ?? track.end) - updateTick),
  };
}

const requestKey = (targets: SmokeTarget[]) =>
  targets.map(({ key, offset }) => key + '@' + offset).join('|');

/** Ask for the latest visible revision. Keep exact matches only, including
 * when a response arrives after a seek but before the next demand frame. */
export function useSmokeDensity(
  tracks: SmokeTrack[] | undefined,
  tick: number,
  rate: number,
  sun: XYZ,
) {
  const [responses, setResponses] = useState<{
    tracks: SmokeTrack[];
    sun: XYZ;
    rows: SmokeDensityResult[];
  }>();
  const invalidate = useThree((state) => state.invalidate);
  const controller = useRef<((targets: SmokeTarget[]) => void) | undefined>(undefined);
  const targets = useMemo(() => {
    const result: SmokeTarget[] = [];
    for (const track of tracks ?? []) {
      if (track.start > tick || result.length >= smokeLimits.active) break;
      const target = targetAt(track, tick, rate);
      if (target) result.push(target);
    }
    return result;
  }, [tracks, tick, rate]);
  const desired = useRef<SmokeTarget[]>([]);
  useLayoutEffect(() => {
    desired.current = targets;
  }, [targets]);
  useLayoutEffect(() => {
    if (!tracks?.length || typeof Worker === 'undefined') return;
    let worker: Worker | undefined;
    let active = true;
    let waiting = false;
    let last = '';
    let latest: SmokeTarget[] = [];
    const fail = () => {
      active = false;
      worker?.terminate();
      setResponses(undefined);
      invalidate();
    };
    const send = () => {
      if (waiting || !active) return;
      const request = requestKey(latest);
      if (request === last) return;
      last = request;
      if (!request) return;
      if (!worker) {
        try {
          worker = new Worker(new URL('./smoke-density.worker.ts', import.meta.url), {
            type: 'module',
          });
        } catch {
          fail();
          return;
        }
        worker.onmessage = ({ data }: MessageEvent<SmokeDensityResult[]>) => {
          if (!active) return;
          const exact = data.filter((row) =>
            desired.current.some(
              (target) => target.key === row.key && target.offset === row.offset,
            ),
          );
          if (exact.length) {
            setResponses((previous) => {
              const retained =
                previous?.tracks === tracks && previous.sun === sun
                  ? previous.rows.filter(
                      (row) =>
                        desired.current.some(
                          (target) =>
                            target.key === row.key &&
                            (target.offset === row.offset || target.previousOffset === row.offset),
                        ) && !exact.some(({ key }) => key === row.key),
                    )
                  : [];
              return { tracks, sun, rows: [...retained, ...exact] };
            });
          } else last = '';
          waiting = false;
          invalidate();
        };
        worker.onerror = fail;
        worker.onmessageerror = fail;
      }
      waiting = true;
      try {
        worker.postMessage({ targets: latest, sun } satisfies SmokeDensityRequest);
      } catch {
        fail();
      }
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
  }, [tracks, sun, invalidate]);

  const rows = responses?.tracks === tracks && responses?.sun === sun ? responses.rows : [];
  const projection = useMemo(() => new Matrix4(), []);
  const frustum = useMemo(() => new Frustum(), []);
  const box = useMemo(() => new Box3(), []);
  const extent = useMemo(() => new Vector3().setScalar(HALF_GRID), []);
  useFrame(({ camera }) => {
    if (!controller.current) return;
    if (!targets.length) {
      controller.current(targets);
      return;
    }
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    controller.current(
      targets.filter(({ key, offset, track }) => {
        if (rows.some((row) => row.key === key && row.offset === offset)) return false;
        box.min.fromArray(scenePoint(track.origin));
        box.max.copy(box.min).add(extent);
        box.min.sub(extent);
        return frustum.intersectsBox(box);
      }),
    );
  });

  return targets.map((target) => {
    const exact = rows.find((row) => row.key === target.key && row.offset === target.offset);
    // The already displayed predecessor is part of the new pair. Hold it
    // briefly while the next field arrives, without applying late replies.
    const reply =
      exact ?? rows.find((row) => row.key === target.key && row.offset === target.previousOffset);
    return {
      key: target.key,
      track: target.track,
      density:
        reply?.current && reply.previous
          ? {
              current: reply.current,
              previous: exact ? reply.previous : reply.current,
              mix: exact ? smooth(tick - target.updateTick, target.fadeTicks) : 1,
              stoppedAt: reply.stoppedAt,
            }
          : undefined,
    };
  });
}

export function smokeHidesLabel(volumes: SmokeSample[], from: XYZ, to: XYZ) {
  let transmittance = 1;
  for (const smoke of volumes) {
    transmittance *= smokeTransmittance(smoke, from, to);
    if (transmittance <= 0.12) return true;
  }
  return false;
}
