import { createRoot, extend, useThree } from '@react-three/fiber';
import { useLayoutEffect, type ReactNode } from 'react';
import * as T from 'three';
import { MapGradeContext } from '../../src/map-grade';
import { StaticMapGroup } from '../../src/static-map-group';
import { useMapShadowCache } from '../../src/useMapShadowCache';
import SceneLighting from '../../src/components/SceneLighting';
import type { MapGrade } from '../../../shared/map-grade.mjs';

extend(T);
export async function gradedShadowScene(canvas: HTMLCanvasElement) {
  const gl = new T.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  const camera = new T.PerspectiveCamera(45, 4 / 3, 0.1, 100);
  camera.position.set(6, 7, 9);
  camera.lookAt(0, 0, 0);
  const root = createRoot(canvas);
  await root.configure({
    gl,
    camera,
    frameloop: 'never',
    shadows: true,
    size: { width: 320, height: 240, left: 0, top: 0 },
  });
  gl.info.autoReset = false;
  const map = new StaticMapGroup();
  const floor = new T.Mesh(new T.PlaneGeometry(12, 12), new T.MeshStandardMaterial());
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const geometry = new T.BoxGeometry(1.5, 2, 1.5);
  const count = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(weights, 4));
  const caster = new T.SkinnedMesh(geometry, new T.MeshStandardMaterial());
  const bone = new T.Bone();
  caster.position.y = 1;
  caster.castShadow = true;
  caster.frustumCulled = false;
  caster.add(bone);
  caster.bind(new T.Skeleton([bone]));
  map.add(floor, caster);
  map.seal([]);
  const sun = {
    position: [-4, 6, -3] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    color: [1, 1, 1] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    shadow: { left: -8, right: 8, bottom: -8, top: 8, near: 0.1, far: 30 },
  };
  let scene: T.Scene;
  function Owner({ children, ready }: { children: ReactNode; ready: () => void }) {
    useMapShadowCache(true);
    scene = useThree((state) => state.scene);
    useLayoutEffect(ready, [ready]);
    return children;
  }
  const grade = { exposure: { min: 0.8, max: 1, bias: 0 } } as MapGrade;
  const mount = (graded: boolean) =>
    new Promise<void>((resolve) => {
      root.render(
        <Owner ready={resolve}>
          <MapGradeContext.Provider value={graded ? grade : undefined}>
            <SceneLighting sample={false} sun={sun} shadows={true} skylight={false} />
            <primitive object={map} />
          </MapGradeContext.Provider>
        </Owner>,
      );
    });
  const draw = () => {
    gl.info.reset();
    gl.render(scene, camera);
    const context = gl.getContext();
    const bytes = new Uint8Array(320 * 240 * 4);
    context.readPixels(0, 0, 320, 240, context.RGBA, context.UNSIGNED_BYTE, bytes);
    return { calls: gl.info.render.calls, bytes };
  };
  const differences = (a: Uint8Array, b: Uint8Array) =>
    a.reduce((n, v, i) => n + Number(v !== b[i]), 0);
  try {
    await mount(false);
    draw();
    draw();
    await mount(true);
    draw();
    const quiet = draw();
    bone.position.x = 3;
    const moved = draw();
    const reused = draw();
    gl.shadowMap.needsUpdate = true;
    const reference = draw();
    return {
      quiet: quiet.calls,
      moved: moved.calls,
      reused: reused.calls,
      reference: reference.calls,
      movedBytes: differences(quiet.bytes, moved.bytes),
      referenceDifferences: differences(moved.bytes, reference.bytes),
    };
  } finally {
    root.unmount();
    gl.dispose();
  }
}
