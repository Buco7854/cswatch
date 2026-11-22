import { useMemo } from 'react';
import { DoubleSide } from 'three';
import type { BombShockwaveSample } from '../bomb-shockwave';

const vertexShader = `
  varying vec2 ringUV;
  void main() {
    ringUV = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = `
  varying vec2 ringUV;
  uniform float strength;
  void main() {
    float radius = length(ringUV);
    float wave = smoothstep(0.68, 0.94, radius) * (1.0 - smoothstep(0.96, 1.0, radius));
    gl_FragColor = vec4(mix(vec3(0.82, 0.29, 0.08), vec3(1.0, 0.83, 0.60), wave), wave * strength);
    #include <colorspace_fragment>
  }
`;

/** One world-space draw within the replay's detonation window. */
export default function BombShockwave({ wave }: { wave: BombShockwaveSample }) {
  const uniforms = useMemo(() => ({ strength: { value: wave.opacity } }), [wave.opacity]);
  return (
    <mesh
      name="bomb-shockwave"
      position={wave.position}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={wave.radius}
    >
      <ringGeometry args={[0.68, 1, 48]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        side={DoubleSide}
        transparent
        forceSinglePass
        depthWrite={false}
      />
    </mesh>
  );
}
