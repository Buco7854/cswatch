import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Color,
  Group,
  PerspectiveCamera,
  SRGBColorSpace,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { SmokeTrack } from '../../../shared/smoke-state.mjs';
import type { UtilityZone } from '../utility-state';
import type { Playback } from '../types';
import type { MapSun } from '../map-sun';
import { useReducedMotion } from '../reduced-motion';
import { useSmokeDensity } from '../smoke-render-state';
import {
  CELL,
  GRID,
  HALF_GRID,
  HIGH_SUN,
  activeSmokeHoles,
  approximateField,
  indexSmokeBlasts,
  scenePoint,
  smokeEnvelope,
  unionSmokeBounds,
  type SmokeField,
  type SmokeSample,
  type XYZ,
} from '../smoke-field';
import { SmokeVolumePass, type SmokeDraw, type SmokeSunTrace } from '../smoke-volume';

const vertexShader = `
  uniform float smokeSize;
  uniform float smokeExpansion;
  attribute vec4 smokeCell;
  varying vec2 cellUv;
  varying float cellDensity;
  varying vec3 driftOrigin;
  void main() {
    cellUv = position.xy * 2.0;
    cellDensity = smokeCell.w;
    driftOrigin = smokeCell.xyz;
    vec4 eye = modelViewMatrix * vec4(smokeCell.xyz * smokeExpansion, 1.0);
    eye.xy += position.xy * (0.92 + 0.16 * smokeCell.w) * smokeSize * smokeExpansion;
    gl_Position = projectionMatrix * eye;
  }
`;
const fragmentShader = `
  uniform vec3 smokeColor;
  uniform float smokeOpacity;
  uniform float smokeTime;
  varying vec2 cellUv;
  varying vec3 driftOrigin;
  varying float cellDensity;
  void main() {
    float r = dot(cellUv, cellUv);
    if (r >= 1.0) discard;
    float roll = sin(dot(driftOrigin, vec3(2.62, 0.43, 1.48)) + smokeTime * 0.83
      + dot(cellUv, vec2(2.3, 1.73)));
    float softness = (1.0 - r) * (1.0 - r);
    float alpha = softness * cellDensity * smokeOpacity * (0.43 + 0.09 * roll);
    gl_FragColor = vec4(smokeColor * (0.90 + 0.10 * roll), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function SmokePuffs({
  cells,
  color,
  origin,
  age,
  opacity,
  expansion = 1,
  puffSize = 1,
  name,
}: {
  cells: Float32Array;
  color: Color;
  origin: [number, number, number];
  age: number;
  opacity: number;
  expansion?: number;
  puffSize?: number;
  name: string;
}) {
  const material = useRef<ShaderMaterial>(null);
  const invalidate = useThree((state) => state.invalidate);
  const uniforms = useMemo(
    () => ({
      smokeColor: { value: color },
      smokeOpacity: { value: 1 },
      smokeTime: { value: 0 },
      smokeSize: { value: puffSize },
      smokeExpansion: { value: 1 },
    }),
    [color, puffSize],
  );
  const geometry = useMemo(() => {
    const base = new PlaneGeometry();
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(base.index);
    geometry.setAttribute('position', base.attributes.position);
    geometry.setAttribute('smokeCell', new InstancedBufferAttribute(cells, 4));
    geometry.instanceCount = cells.length / 4;
    geometry.boundingSphere = new Sphere(new Vector3(), 15);
    return geometry;
  }, [cells]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // The mesh stores its color, trajectory and opacity in demo time, including at pause.
  useLayoutEffect(() => {
    const shader = material.current;
    if (!shader) return;
    shader.uniforms.smokeTime.value = age;
    shader.uniforms.smokeOpacity.value = opacity;
    shader.uniforms.smokeExpansion.value = expansion;
    invalidate();
  }, [cells, age, opacity, expansion, invalidate]);
  if (!cells.length) return null;
  return (
    <mesh name={name} position={origin}>
      <primitive object={geometry} attach="geometry" />
      <shaderMaterial
        ref={material}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

function billboardCells(field: SmokeField) {
  const cells = [];
  for (let i = 0; i < field.texels.length / 2 && cells.length < 4096 * 4; i++) {
    const density = field.texels[i * 2];
    if (!density) continue;
    cells.push(
      ((i % GRID) + 0.5) * CELL - HALF_GRID,
      ((Math.floor(i / GRID) % GRID) + 0.5) * CELL - HALF_GRID,
      (Math.floor(i / (GRID * GRID)) + 0.5) * CELL - HALF_GRID,
      Math.min(1, Math.log1p((density * 50) / 255) / Math.log1p(40)),
    );
  }
  return new Float32Array(cells);
}

function RecordedBillboards({ cloud }: { cloud: SmokeDraw }) {
  const cells = useMemo(() => billboardCells(cloud.current), [cloud.current]);
  return (
    <SmokePuffs
      name="recorded-smoke-puffs"
      cells={cells}
      color={approximateColor}
      origin={cloud.origin}
      age={cloud.drift}
      opacity={cloud.amount}
    />
  );
}

// An event-only archive has no density or reliable simulation history. The
// fallback uses a bounded, fixed cloud with the recorded detonation as its origin.
const approximateColor = new Color(0.5, 0.54, 0.57);
const approximateCells = (() => {
  const cells: number[] = [];
  for (let y = -2; y <= 2; y++) {
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        const distance = Math.hypot(x / 3.6, y / 2.65, z / 3.6);
        if (distance >= 1) continue;
        const variation = Math.sin(x * 12.9 + y * 13.1 + z * 8.7);
        cells.push(x * 0.95 + variation * 0.2, y * 0.68 + 1.5, z * 0.95, 1 - distance * 0.38);
      }
    }
  }
  return new Float32Array(cells);
})();

function ApproximateSmoke({
  zone,
  tick,
  rate,
  reducedMotion,
}: {
  zone: UtilityZone;
  tick: number;
  rate: number;
  reducedMotion: boolean;
}) {
  const age = (tick - zone.start) / rate;
  return (
    <SmokePuffs
      name="utility-zone:smoke"
      cells={approximateCells}
      color={approximateColor}
      origin={zoneOrigin(zone)}
      age={reducedMotion ? 0 : age}
      puffSize={2.2}
      expansion={0.28 + 0.72 * Math.min(1, Math.max(0, age))}
      opacity={Math.max(0, Math.min(1, age * 5, ((zone.end - tick) / rate) * 2))}
    />
  );
}

const zoneOrigin = (zone: UtilityZone) => scenePoint([zone.x, zone.y, zone.z]);
const luminance = (c: Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

function smokeTint(track: SmokeTrack) {
  const recorded = new Color().setRGB(...(track.color.map((c) => c / 255) as XYZ), SRGBColorSpace);
  const light = luminance(recorded);
  const neutral = new Color(1, 1, 1);
  return light > 0.002 ? neutral.lerp(recorded.multiplyScalar(1 / light), 0.055) : neutral;
}

function VolumePass({
  draws,
  sun,
  color,
  low,
  xray,
  onUnavailable,
  sunTrace,
}: {
  draws: SmokeDraw[];
  sun: Vector3;
  color: Color;
  low: boolean;
  xray: boolean;
  onUnavailable: () => void;
  sunTrace?: SmokeSunTrace;
}) {
  const group = useMemo(() => new Group(), []);
  const pass = useMemo(() => new SmokeVolumePass(group, sun, sunTrace), [group, sun, sunTrace]);
  useLayoutEffect(() => () => pass.dispose(), [pass]);
  useFrame(({ gl, scene, camera }) => {
    if (
      !(camera instanceof PerspectiveCamera) ||
      !pass.render(gl, scene, camera, draws, color, low, xray)
    )
      onUnavailable();
  });
  return <primitive object={group} />;
}

export function SmokeEffects({
  data,
  zones,
  tick,
  nativeVolume,
  sunTrace,
  low,
  xray,
  labelSmoke,
  sun,
}: {
  data: Playback;
  zones: UtilityZone[];
  tick: number;
  nativeVolume: boolean;
  sunTrace?: SmokeSunTrace;
  low: boolean;
  xray: boolean;
  labelSmoke: RefObject<SmokeSample[]>;
  sun: MapSun | null;
}) {
  const rate = data.tickRate;
  const reducedMotion = useReducedMotion();
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [failed, setFailed] = useState(false);
  const supported = useMemo(() => {
    const context = gl.getContext();
    return (
      'MAX_3D_TEXTURE_SIZE' in context && context.getParameter(context.MAX_3D_TEXTURE_SIZE) >= GRID
    );
  }, [gl]);
  const volume = !failed && supported;
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
  const { recorded, unsupported } = useSmokeDensity(
    nativeVolume ? data.smokeTracks : undefined,
    tick,
    rate,
    sunVector,
  );
  const matches = (zone: UtilityZone, track: SmokeTrack) =>
    track.entity === zone.entity &&
    Math.abs(track.start - zone.start) <= rate &&
    Math.abs(track.origin[0] - zone.x) <= 1 &&
    Math.abs(track.origin[1] - zone.y) <= 1 &&
    Math.abs(track.origin[2] - zone.z) <= 1;
  const approximate = zones
    .filter((zone) => zone.kind === 'smoke' && !recorded.some(({ track }) => matches(zone, track)))
    .slice(0, 8);
  const usePuffs = (zone: UtilityZone) =>
    !volume || unsupported.some((track) => matches(zone, track));
  const blasts = useMemo(() => indexSmokeBlasts(data.events), [data.events]);
  const analytic = useMemo(() => {
    let cached: SmokeField | undefined;
    return () => (cached ??= approximateField(sunVector));
  }, [sunVector]);
  const draws: SmokeDraw[] = [];
  for (const { track, key, previous, current, mix, stoppedAt } of recorded) {
    const bounds =
      mix === 0
        ? previous.bounds
        : mix === 1
          ? current.bounds
          : unionSmokeBounds(previous.bounds, current.bounds);
    if (!bounds) continue;
    const age = (tick - track.start) / rate;
    const remaining = (track.end - tick) / rate;
    const fade =
      stoppedAt === undefined ? 0.75 : Math.max(1 / rate, (track.end - stoppedAt) / rate);
    const cloud: SmokeDraw = {
      key,
      origin: scenePoint(track.origin),
      scale: 1,
      previous,
      current,
      bounds,
      mix,
      amount: smokeEnvelope(age, remaining, fade),
      tint: smokeTint(track),
      drift: reducedMotion ? 0 : age,
      holes: [],
    };
    cloud.holes = activeSmokeHoles(blasts, cloud, track.start, tick, rate);
    draws.push(cloud);
  }
  const recordedDraws = draws.length;
  if (volume)
    for (const zone of approximate) {
      if (usePuffs(zone)) continue;
      const field = analytic();
      if (!field.bounds) continue;
      const age = (tick - zone.start) / rate;
      const cloud: SmokeDraw = {
        key: zone.id,
        origin: zoneOrigin(zone),
        scale: 0.32 + 0.68 * Math.min(1, Math.max(0, age)),
        previous: field,
        current: field,
        bounds: field.bounds,
        mix: 1,
        tint: new Color(1, 1, 1),
        amount: smokeEnvelope(age, (zone.end - tick) / rate, 1.8),
        drift: reducedMotion ? 0 : age,
        holes: [],
      };
      cloud.holes = activeSmokeHoles(blasts, cloud, zone.start, tick, rate);
      draws.push(cloud);
    }

  useLayoutEffect(() => {
    labelSmoke.current = draws;
    if (draws.length) invalidate();
    return () => {
      labelSmoke.current = [];
    };
  }, [draws, labelSmoke, invalidate]);
  return (
    <>
      {!volume &&
        draws
          .slice(0, recordedDraws)
          .map((cloud) => <RecordedBillboards key={cloud.key} cloud={cloud} />)}
      {approximate.filter(usePuffs).map((zone) => (
        <ApproximateSmoke
          key={zone.id}
          zone={zone}
          tick={tick}
          rate={rate}
          reducedMotion={reducedMotion}
        />
      ))}
      {volume && draws.length > 0 && (
        <VolumePass
          draws={draws}
          sun={direction}
          sunTrace={sunTrace}
          color={solarColor}
          low={low}
          xray={xray}
          onUnavailable={() => setFailed(true)}
        />
      )}
    </>
  );
}
