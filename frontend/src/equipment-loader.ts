import { reusePackedSceneSamples } from './packed-material';
import { useLayoutEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { Loader, LoadingManager } from 'three';
import { ModelCache } from './model-cache';
import { equipmentModelResources, retainEquipmentModel } from './model-resources';

import { packEquipmentJoints } from './equipment-geometry';
import { loadScopedGLTF } from './scoped-gltf-loader';
import { retainEquipmentRestGeometry } from './equipment-rest-skin';

type EquipmentGLTF = ReturnType<typeof retainEquipmentModel>;

const MiB = 1024 * 1024;
const mobile = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width:780px),(pointer:coarse)').matches;

function equipmentLoader(
  transferMiB: number,
  limits: {
    maxUnused: number;
    maxConcurrent: number;
    inactiveBytes: (active: boolean) => number;
    residentBytes: () => number;
  },
  textureEdge?: (url: string) => number | undefined,
) {
  class EquipmentGLTFLoader extends Loader<EquipmentGLTF> {
    constructor() {
      super(new LoadingManager());
    }
    load(
      url: string,
      onLoad: (gltf: EquipmentGLTF) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (error: unknown) => void,
    ) {
      cache.request(url, {
        loaded: onLoad,
        progress: onProgress,
        failed: (error) => onError?.(error),
      });
    }
  }
  const cache = new ModelCache<EquipmentGLTF>({
    ...limits,
    inspect: equipmentModelResources,
    clear: (url) => useLoader.clear(EquipmentGLTFLoader, url),
    load: (url, callbacks) =>
      loadScopedGLTF(
        url,
        {
          ...callbacks,
          loaded(gltf) {
            reusePackedSceneSamples(gltf.scenes);
            packEquipmentJoints(gltf.scenes);
            if (url.startsWith('/api/assets/equipment-models/') && !gltf.animations.length)
              retainEquipmentRestGeometry(gltf.scene);
            callbacks.loaded(retainEquipmentModel(gltf));
          },
        },
        transferMiB * MiB,
        true,
        undefined,
        textureEdge?.(url),
      ),
  });
  return { Loader: EquipmentGLTFLoader, cache };
}

const worldBudget = () => (mobile() ? 128 : 256) * MiB;

const world = equipmentLoader(
  16,
  {
    maxUnused: 12,
    maxConcurrent: 2,
    // During a replay, recently holstered weapons share the existing total budget.
    // On exit, trim idle models back to the smaller background allowance.
    inactiveBytes: (active) => (active ? worldBudget() : worldBudget() / 4),
    residentBytes: worldBudget,
  },
  (url) => (mobile() && url.startsWith('/api/assets/equipment-models/') ? 512 : undefined),
);

// Reserve a small independent budget so the visible POV can load while
// agents and world items still own their live leases on compact devices.
const pov = equipmentLoader(8, {
  maxUnused: 2,
  maxConcurrent: 1,
  inactiveBytes: () => (mobile() ? 20 : 40) * MiB,
  residentBytes: () => (mobile() ? 48 : 80) * MiB,
});
export const loadedEquipmentModel = (url: string) => world.cache.peek(url);
/** Storage held by loaded agents, equipment and first-person rigs. */
export const loadedModelBytes = () => world.cache.ownedBytes() + pov.cache.ownedBytes();
export const useEquipmentGLTF = (url: string) => useLoader(world.Loader, url);
/** Hold and load a world model ahead of use. `loaded` runs once the model is resident and
 * mounting it no longer suspends; the returned release ends the hold. */
export function holdEquipmentModel(url: string, loaded: () => void, failed: () => void) {
  const release = world.cache.scope(url).acquire();
  let active = true,
    timer: ReturnType<typeof setTimeout> | undefined;
  world.cache.request(url, {
    loaded: () => {
      if (!active) return;
      useLoader.preload(world.Loader, url);
      // The loader's own promise settles in a microtask; report after it.
      timer = setTimeout(() => active && loaded(), 0);
    },
    failed: () => {
      if (active) failed();
    },
  });
  return () => {
    active = false;
    clearTimeout(timer);
    release();
  };
}
export const usePovGLTF = (url: string) => useLoader(pov.Loader, url);
function useNativeScope(cache: ModelCache<EquipmentGLTF>, url: string, identity: object) {
  const scope = useMemo(() => cache.scope(url), [cache, url, identity]);
  useLayoutEffect(() => scope.acquire(), [scope]);
  return scope;
}
export const useEquipmentScope = (url: string, identity: object) =>
  useNativeScope(world.cache, url, identity);
export const usePovScope = (url: string, identity: object) =>
  useNativeScope(pov.cache, url, identity);

/** Scene leases retain the two current agent assets across 2D and selected-player POV changes. */
export function useModelLeases(urls: readonly string[], identity: object) {
  const key = urls.join('\0');
  const scopes = useMemo(() => urls.map((url) => world.cache.scope(url)), [key, identity]);
  useLayoutEffect(() => {
    const releases = scopes.map((scope) => scope.acquire());
    return () => {
      for (const release of releases) release();
    };
  }, [scopes]);
}
