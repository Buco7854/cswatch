import { worldQueries, type WorldQueries } from './queries';
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, Color, DirectionalLight, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { compositor, type FramePasses } from './compositor';
import { createRenderer, type NativeRenderer } from './renderer';
import { loadManifest, type Manifest } from './format';
import { sourceToViewer } from './space';
import { mapSun, type MapSun } from '../actor-sun';
import type { playerShadows } from '../player-shadows';

export interface LoadedWorld {
  manifest: Manifest;
  native: NativeRenderer;
  queries: WorldQueries;
}
interface Props {
  url: string;
  tactical: boolean;
  passes: FramePasses;
  shadows: ReturnType<typeof playerShadows>;
  loaded: (url: string, status: 'ready' | 'error', sun: MapSun | null) => void;
  register: (world: LoadedWorld | null) => void;
}
// Only this positive-priority callback submits the composed frame. Other scene
// components update transforms, animation and effect lists before it runs.
export function NativeWorld({ url, tactical, passes, shadows, loaded, register }: Props) {
  const { gl: renderer, scene, invalidate } = useThree();
  const current = useRef<ReturnType<typeof compositor> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cleanup: (() => void) | undefined;
    async function load() {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const dir = new URL('.', new URL(url, location.href));
      const manifest = await loadManifest(dir);
      controller.signal.throwIfAborted();
      const native = await createRenderer(gl, dir, manifest, controller.signal);
      controller.signal.throwIfAborted();
      renderer.resetState();
      const compositorInstance = compositor(renderer, native);
      const env = native.environments.find((env) => !env.sky)!;
      const direction = new Vector3(...env.lightDir).transformDirection(sourceToViewer);
      const light = new DirectionalLight(
        new Color(...(env.color as [number, number, number])),
        Math.PI,
      );
      light.position.copy(direction);
      light.target = new Object3D();
      scene.add(light, light.target);
      const fit = new Box3(
        new Vector3(...manifest.bounds.slice(0, 3)),
        new Vector3(...manifest.bounds.slice(3)),
      ).applyMatrix4(sourceToViewer);
      const sun = mapSun(
        {
          directionToSun: direction.toArray(),
          color: env.color.map((c) => Math.min(c, 1)) as [number, number, number],
        },
        fit,
      );
      passes.sun = light;
      current.current = compositorInstance;
      cleanup = () => {
        current.current = null;
        delete passes.sun;
        register(null);
        scene.remove(light, light.target);
        compositorInstance.dispose();
        native.dispose();
      };
      register({
        manifest,
        native,
        queries: worldQueries(manifest, native.geometry.vertices, native.geometry.indices),
      });
      loaded(url, 'ready', sun);
      invalidate();
      await native.refine(invalidate);
      renderer.resetState();
      invalidate();
    }
    load().catch((error) => {
      if (!controller.signal.aborted) {
        console.error('Native world:', error);
        loaded(url, 'error', null);
      }
    });
    return () => {
      cleanup?.();
      controller.abort();
    };
  }, [url, renderer, scene, passes, loaded, register, invalidate]);
  useFrame(({ camera }) => {
    if (!current.current || !(camera instanceof PerspectiveCamera)) return;
    const depth = shadows.depth;
    const texture =
      depth.cswatchPlayerShadows.value &&
      depth.cswatchPlayerDepth.value &&
      (renderer.properties.get(depth.cswatchPlayerDepth.value) as { __webglTexture: WebGLTexture })
        .__webglTexture;
    const shadow = texture
      ? {
          texture,
          projection: new Float32Array(
            depth.cswatchPlayerProjection.value.clone().multiply(sourceToViewer).elements,
          ),
          bias: depth.cswatchPlayerBias.value,
        }
      : undefined;
    current.current.frame(scene, camera, tactical, passes, shadow);
  }, 3);
  return null;
}
