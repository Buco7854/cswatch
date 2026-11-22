import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef, type Ref } from 'react';
import {
  DynamicDrawUsage,
  WebGLRenderTarget,
  type Mesh,
  type InstancedBufferAttribute,
  type InstancedBufferGeometry,
  type IUniform,
  type ShaderMaterial,
} from 'three';
import type { EffectSprite } from '../utility-effects';

const quad = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);

/** Two fixed-size instance buffers owned by the mounted Three scene. */
export default function UtilitySprites({
  name,
  capacity,
  warm,
  lighting,
  sprites,
  count = sprites.length,
  vertexShader,
  fragmentShader,
  renderOrder,
  uniforms,
  materialRef,
}: {
  name: string;
  capacity: number;
  warm: boolean;
  lighting: boolean;
  sprites: EffectSprite[];
  count?: number;
  vertexShader: string;
  fragmentShader: string;
  renderOrder: number;
  uniforms?: Record<string, IUniform>;
  materialRef?: Ref<ShaderMaterial>;
}) {
  const mesh = useRef<Mesh>(null);
  const { gl, scene, camera } = useThree();
  const geometry = useRef<InstancedBufferGeometry>(null);
  const originAttribute = useRef<InstancedBufferAttribute>(null);
  const effectAttribute = useRef<InstancedBufferAttribute>(null);
  const [origins, effect] = useMemo(
    () => [new Float32Array(capacity * 4), new Float32Array(capacity * 4)],
    [capacity],
  );
  useLayoutEffect(() => {
    const current = geometry.current!;
    current.instanceCount = Math.min(count, capacity);
    if (!current.instanceCount) return;
    for (let i = 0; i < current.instanceCount; i++) {
      const { position, age, strength, secondary, seed, variant } = sprites[i];
      const offset = i * 4;
      origins.set(position, offset);
      origins[offset + 3] = seed;
      effect[offset] = age;
      effect[offset + 1] = strength;
      effect[offset + 2] = secondary;
      effect[offset + 3] = variant;
    }
    for (const attribute of [originAttribute.current!, effectAttribute.current!]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, current.instanceCount * 4);
      attribute.needsUpdate = true;
    }
  }, [origins, effect, count, sprites, capacity]);
  useLayoutEffect(() => {
    if (!warm || !mesh.current) return;
    const previous = gl.getRenderTarget();
    const linear = new WebGLRenderTarget(1, 1);
    try {
      // The same scene-linear shader writes either display sRGB or a linear
      // render target for the authored grade. Reserve both program variants.
      gl.setRenderTarget(null);
      gl.compile(mesh.current, camera, scene);
      gl.setRenderTarget(linear);
      gl.compile(mesh.current, camera, scene);
    } finally {
      gl.setRenderTarget(previous);
      linear.dispose();
    }
  }, [warm, lighting, gl, scene, camera, vertexShader, fragmentShader]);
  return (
    <mesh
      ref={mesh}
      name={name}
      frustumCulled={false}
      renderOrder={renderOrder}
      visible={count > 0}
    >
      <instancedBufferGeometry ref={geometry} instanceCount={0}>
        <bufferAttribute attach="index" args={[indices, 1]} />
        <bufferAttribute attach="attributes-position" args={[quad, 3]} />
        <instancedBufferAttribute
          ref={originAttribute}
          attach="attributes-aOrigin"
          args={[origins, 4]}
          usage={DynamicDrawUsage}
        />
        <instancedBufferAttribute
          ref={effectAttribute}
          attach="attributes-aEffect"
          args={[effect, 4]}
          usage={DynamicDrawUsage}
        />
      </instancedBufferGeometry>
      <shaderMaterial
        ref={materialRef}
        name={name}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        toneMapped={false}
        depthTest
        depthWrite={false}
        transparent
      />
    </mesh>
  );
}

export const spriteVaryings = `
  varying vec2 spriteUv;
  varying vec4 effect;
  varying float seed;
`;

export const spriteVertexInputs = `
  attribute vec4 aOrigin;
  attribute vec4 aEffect;
  ${spriteVaryings}
`;

export const effectNoise = `
  float hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.11369);
    q += dot(q, q.yzx + 19.19);
    return fract((q.x + q.y) * q.z);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
      mix(hash(i+vec2(0,1)), hash(i+vec2(1)), f.x), f.y);
  }
`;
