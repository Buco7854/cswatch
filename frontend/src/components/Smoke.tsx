import { NativePasses } from '../world/frame-context';
import { useContext, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Group, PerspectiveCamera, Vector3 } from 'three';
import type { SmokeTrack } from '../../../shared/smoke-state.mjs';
import type { UtilityZone } from '../utility-state';
import type { Playback } from '../types';
import type { MapSun } from '../actor-sun';
import { useReducedMotion } from '../reduced-motion';
import { useSmokeDensity } from '../smoke-render-state';
import {
  HIGH_SUN,
  activeSmokeHoles,
  analyticSmokeField,
  indexSmokeBlasts,
  scenePoint,
  smokeAlbedo,
  smokeEnvelope,
  unionSmokeBounds,
  type SmokeField,
  type SmokeSample,
} from '../smoke-field';
import { SmokeVolumePass, type SmokeDraw, type SmokeSunTrace } from '../smoke-volume';

function VolumePass({
  draws,
  sun,
  color,
  low,
  xray,
  sunTrace,
  labelSmoke,
  onUnavailable,
}: {
  draws: SmokeDraw[];
  sun: Vector3;
  color: Color;
  low: boolean;
  xray: boolean;
  sunTrace?: SmokeSunTrace;
  labelSmoke: RefObject<SmokeSample[]>;
  onUnavailable: (unavailable: boolean) => void;
}) {
  const group = useMemo(() => new Group(), []);
  const pass = useMemo(() => new SmokeVolumePass(group, sun, sunTrace), [group, sun, sunTrace]);
  const { gl, invalidate } = useThree();
  const available = useRef(true);
  useLayoutEffect(() => {
    labelSmoke.current = available.current ? draws : [];
    invalidate();
  }, [draws, labelSmoke, invalidate]);
  useLayoutEffect(() => {
    const canvas = gl.domElement;
    const lose = () => {
      pass.hide();
      available.current = false;
      labelSmoke.current = [];
      onUnavailable(true);
    };
    const restore = () => {
      pass.revalidateTargets();
      invalidate();
    };
    if (!gl.getContext().isContextLost()) pass.warm(gl);
    canvas.addEventListener('webglcontextlost', lose);
    canvas.addEventListener('webglcontextrestored', restore);
    if (gl.getContext().isContextLost()) lose();
    return () => {
      canvas.removeEventListener('webglcontextlost', lose);
      canvas.removeEventListener('webglcontextrestored', restore);
      pass.dispose();
      available.current = true;
      labelSmoke.current = [];
      onUnavailable(false);
    };
  }, [gl, invalidate, labelSmoke, onUnavailable, pass]);

  const native = useContext(NativePasses);
  useLayoutEffect(
    () => () => {
      if (native) delete native.smoke;
    },
    [native],
  );
  useFrame(({ gl, scene, camera }) => {
    const prepare = (framebuffer?: WebGLFramebuffer) => {
      const ready =
        camera instanceof PerspectiveCamera &&
        pass.render(gl, scene, camera, draws, color, low, xray, 1, framebuffer);
      if (available.current === ready) return;
      if (!ready) pass.hide();
      available.current = ready;
      labelSmoke.current = ready ? draws : [];
      onUnavailable(!ready);
      invalidate();
    };
    if (native) native.smoke = prepare;
    else prepare();
  });
  return <primitive object={group} />;
}

export default function Smoke({
  data,
  zones,
  tick,
  modelReady,
  sunTrace,
  low,
  xray,
  labelSmoke,
  sun,
  onUnavailable,
}: {
  data: Playback;
  zones: UtilityZone[];
  tick: number;
  modelReady: boolean;
  sunTrace?: SmokeSunTrace;
  low: boolean;
  xray: boolean;
  labelSmoke: RefObject<SmokeSample[]>;
  sun: MapSun | null;
  onUnavailable: (unavailable: boolean) => void;
}) {
  const rate = data.tickRate;
  const reducedMotion = useReducedMotion();
  const direction = useMemo(
    () =>
      (sun
        ? new Vector3(...sun.position).sub(new Vector3(...sun.target))
        : new Vector3(...HIGH_SUN)
      ).normalize(),
    [sun],
  );
  const solarColor = useMemo(
    () => (sun ? new Color(...sun.color) : new Color(1, 0.95, 0.86)),
    [sun],
  );
  const sunVector = useMemo(() => direction.toArray(), [direction]);
  const active = useSmokeDensity(modelReady ? data.smokeTracks : undefined, tick, rate, sunVector);
  const matches = (zone: UtilityZone, track: SmokeTrack) =>
    (zone.entity === undefined || track.entity === zone.entity) &&
    Math.abs(track.start - zone.start) <= rate &&
    Math.abs(track.origin[0] - zone.x) <= 1 &&
    Math.abs(track.origin[1] - zone.y) <= 1 &&
    Math.abs(track.origin[2] - zone.z) <= 1;
  const events = zones
    .filter((zone) => zone.kind === 'smoke' && !active.some(({ track }) => matches(zone, track)))
    .slice(0, 8);
  const sources = [
    ...active.map(({ key, track, density }) => ({
      key,
      origin: scenePoint(track.origin),
      start: track.start,
      end: track.end,
      color: track.color,
      density,
    })),
    ...events.map(({ id, x, y, z, start, end }) => ({
      key: id,
      origin: scenePoint([x, y, z]),
      start,
      end,
      color: undefined,
      density: undefined,
    })),
  ];
  const blasts = useMemo(() => indexSmokeBlasts(data.events), [data.events]);
  const analytic = useMemo(() => {
    let cached: SmokeField | undefined;
    return () => (cached ??= analyticSmokeField(sunVector));
  }, [sunVector]);
  const draws: SmokeDraw[] = [];
  for (const { key, origin, start, end, color, density } of sources) {
    // A valid empty journal sample remains empty. Use the analytic field only
    // while voxels are unavailable, with the observed origin and interval.
    const previous = density?.previous ?? analytic();
    const current = density?.current ?? previous;
    const mix = density?.mix ?? 1;
    const bounds =
      mix === 0
        ? previous.bounds
        : mix === 1
          ? current.bounds
          : unionSmokeBounds(previous.bounds, current.bounds);
    if (!bounds) continue;
    const age = (tick - start) / rate;
    const stoppedAt = density?.stoppedAt;
    const fade =
      stoppedAt === undefined
        ? density
          ? 0.75
          : 1.8
        : Math.max(1 / rate, (end - stoppedAt) / rate);
    const cloud: SmokeDraw = {
      key,
      origin,
      scale: density ? 1 : 0.32 + 0.68 * Math.min(1, Math.max(0, age)),
      previous,
      current,
      bounds,
      mix,
      amount: smokeEnvelope(age, (end - tick) / rate, fade),
      tint: new Color(...smokeAlbedo(color)),
      recorded: Boolean(density),
      drift: reducedMotion ? 0 : age,
      holes: [],
    };
    cloud.holes = activeSmokeHoles(blasts, cloud, start, tick, rate);
    draws.push(cloud);
  }
  // The pass stays mounted between smokes so its programs and targets survive.
  return (
    <VolumePass
      draws={draws}
      sun={direction}
      sunTrace={sunTrace}
      color={solarColor}
      low={low}
      xray={xray}
      labelSmoke={labelSmoke}
      onUnavailable={onUnavailable}
    />
  );
}
