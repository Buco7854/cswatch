import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  Scene,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
  type ShaderMaterial,
} from 'three';

export type ContactDepthUniforms = {
  contactDepth: { value: DepthTexture | null };
  contactDepthReady: { value: boolean };
};

/** Draw only nearby opaque triangles to a sampled depth buffer. */
export default function BurstContactDepth({
  vertices,
  materialRef,
  warm,
}: {
  vertices: Float32Array[];
  warm: boolean;
  materialRef: RefObject<ShaderMaterial | null>;
}) {
  const { gl, camera } = useThree();
  const resources = useMemo(() => {
    const material = new MeshBasicMaterial({
      name: 'utility-contact-depth',
      side: DoubleSide,
      colorWrite: false,
    });
    const target = new WebGLRenderTarget(1, 1, {
      depthTexture: new DepthTexture(1, 1, UnsignedIntType),
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      stencilBuffer: false,
    });
    return { material, target, scene: new Scene(), size: new Vector2() };
  }, []);
  useLayoutEffect(() => {
    if (!warm) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    const probe = new Mesh(geometry, resources.material);
    probe.frustumCulled = false;
    const previous = gl.getRenderTarget();
    resources.scene.add(probe);
    try {
      // Exercise the same renderer path as the first contact draw, entirely
      // inside the one-pixel target.
      gl.setRenderTarget(resources.target);
      gl.render(resources.scene, camera);
    } finally {
      resources.scene.remove(probe);
      gl.setRenderTarget(previous);
      geometry.dispose();
    }
  }, [warm, gl, camera, resources]);
  const mesh = useMemo(() => {
    const count = vertices.reduce((sum, part) => sum + part.length, 0);
    if (!count) return null;
    const joined = new Float32Array(count);
    let offset = 0;
    for (const part of vertices) {
      joined.set(part, offset);
      offset += part.length;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(joined, 3));
    return new Mesh(geometry, resources.material);
  }, [vertices, resources]);

  useLayoutEffect(() => {
    if (!mesh) return;
    resources.scene.add(mesh);
    return () => {
      resources.scene.remove(mesh);
      mesh.geometry.dispose();
    };
  }, [mesh, resources]);
  useEffect(
    () => () => {
      resources.target.dispose();
      resources.material.dispose();
    },
    [resources],
  );

  // Priority zero runs after the camera controls and before the ordinary
  // render or the existing sky/POV passes. It does not take over rendering.
  useFrame(({ gl, camera }) => {
    const material = materialRef.current;
    if (!material) return;
    // R3F owns the material's uniform objects and copies the supplied defaults.
    const uniforms = material.uniforms as ContactDepthUniforms;
    uniforms.contactDepthReady.value = false;
    if (!mesh?.parent) return;
    const { target, scene, size } = resources;
    gl.getDrawingBufferSize(size);
    const scale = Math.min(0.85, 1536 / Math.max(size.x, size.y));
    const width = Math.max(1, Math.round(size.x * scale));
    const height = Math.max(1, Math.round(size.y * scale));
    if (target.width !== width || target.height !== height) target.setSize(width, height);
    const previous = gl.getRenderTarget();
    const autoClear = gl.autoClear;
    try {
      gl.setRenderTarget(target);
      gl.autoClear = false;
      gl.clear(false, true, false);
      gl.render(scene, camera);
      uniforms.contactDepth.value = target.depthTexture;
      uniforms.contactDepthReady.value = true;
      material.uniformsNeedUpdate = true;
    } finally {
      gl.setRenderTarget(previous);
      gl.autoClear = autoClear;
    }
  });
  return null;
}
