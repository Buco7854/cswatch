import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { MapShadowCache } from './map-shadow-cache';

/** Viewer/renderer-local ownership; never changes Three's global defaults. */
export function useMapShadowCache(enabled: boolean): void {
  const { gl, scene } = useThree();
  useLayoutEffect(() => {
    if (!enabled) return;
    const cache = new MapShadowCache(),
      previous = scene.onBeforeRender,
      autoUpdate = gl.shadowMap.autoUpdate;
    const beforeRender: typeof previous = function (
      this: typeof scene,
      renderer,
      current,
      camera,
      ...rest
    ) {
      previous.call(this, renderer, current, camera, ...rest);
      cache.update(scene, camera, renderer);
    };
    scene.onBeforeRender = beforeRender;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      if (scene.onBeforeRender === beforeRender) scene.onBeforeRender = previous;
      gl.shadowMap.autoUpdate = autoUpdate;
      gl.shadowMap.needsUpdate = true;
    };
  }, [enabled, gl, scene]);
}
