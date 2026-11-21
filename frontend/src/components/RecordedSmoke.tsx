import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { SmokeTrack } from '../../../shared/smoke-state.mjs';
import type { UtilityZone } from '../utility-state';

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

/** Actual simulated density cells share one depth-tested instanced draw per grenade. */
export function RecordedSmoke({
  track,
  cells,
  tick,
  rate,
}: {
  track: SmokeTrack;
  cells: Float32Array;
  tick: number;
  rate: number;
}) {
  const color = useMemo(
    () =>
      new Color(0.57, 0.61, 0.64).lerp(
        new Color().setRGB(track.color[0] / 255, track.color[1] / 255, track.color[2] / 255),
        0.26,
      ),
    [track],
  );
  const [x, y, z] = track.origin;
  return (
    <SmokePuffs
      name="recorded-smoke-volume"
      cells={cells}
      color={color}
      origin={[x * 0.0254, z * 0.0254, -y * 0.0254]}
      age={(tick - track.start) / rate}
      opacity={Math.min(1, ((track.end - tick) / rate) * 3)}
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

export function ApproximateSmoke({
  zone,
  tick,
  rate,
}: {
  zone: UtilityZone;
  tick: number;
  rate: number;
}) {
  const age = (tick - zone.start) / rate;
  return (
    <SmokePuffs
      name="utility-zone:smoke"
      cells={approximateCells}
      color={approximateColor}
      origin={[zone.x * 0.0254, zone.z * 0.0254, -zone.y * 0.0254]}
      age={age}
      puffSize={2.2}
      expansion={0.28 + 0.72 * Math.min(1, Math.max(0, age))}
      opacity={Math.max(0, Math.min(1, age * 5, ((zone.end - tick) / rate) * 2))}
    />
  );
}
