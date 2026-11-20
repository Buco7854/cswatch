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

const vertexShader = `
  attribute vec4 smokeCell;
  varying vec2 cellUv;
  varying float cellDensity;
  varying vec3 driftOrigin;
  void main() {
    cellUv = position.xy * 2.0;
    cellDensity = smokeCell.w;
    driftOrigin = smokeCell.xyz;
    vec4 eye = modelViewMatrix * vec4(smokeCell.xyz, 1.0);
    eye.xy += position.xy * (0.92 + 0.16 * smokeCell.w);
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
  const material = useRef<ShaderMaterial>(null);
  const invalidate = useThree((state) => state.invalidate);
  const uniforms = useMemo(() => {
    const recorded = new Color().setRGB(
      track.color[0] / 255,
      track.color[1] / 255,
      track.color[2] / 255,
    );
    return {
      smokeColor: { value: new Color(0.57, 0.61, 0.64).lerp(recorded, 0.26) },
      smokeOpacity: { value: 1 },
      smokeTime: { value: 0 },
    };
  }, [track]);
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
    shader.uniforms.smokeTime.value = (tick - track.start) / rate;
    shader.uniforms.smokeOpacity.value = Math.min(1, ((track.end - tick) / rate) * 3);
    invalidate();
  }, [track, cells, tick, rate, invalidate]);
  if (!cells.length) return null;
  const [x, y, z] = track.origin;
  return (
    <mesh name="recorded-smoke-volume" position={[x * 0.0254, z * 0.0254, -y * 0.0254]}>
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
