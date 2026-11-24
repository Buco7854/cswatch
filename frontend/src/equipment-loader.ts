import { useLayoutEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { Loader, LoadingManager } from 'three';
import type { GLTF } from 'three-stdlib';
import { ModelCache } from './model-cache';
import { mapModelResources } from './map-model-resources';
import { loadScopedGLTF } from './scoped-gltf-loader';
import { retainEquipmentRestGeometry } from './equipment-rest-skin';

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
  class EquipmentGLTFLoader extends Loader<GLTF> {
    constructor() {
      super(new LoadingManager());
    }
    load(
      url: string,
      onLoad: (gltf: GLTF) => void,
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
  const cache = new ModelCache<GLTF>({
    ...limits,
    inspect: mapModelResources,
    clear: (url) => useLoader.clear(EquipmentGLTFLoader, url),
    load: (url, callbacks) =>
      loadScopedGLTF(
        url,
        {
          ...callbacks,
          loaded(gltf) {
            if (url.startsWith('/api/assets/equipment-models/') && !gltf.animations.length)
              retainEquipmentRestGeometry(gltf.scene);
            callbacks.loaded(gltf);
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
export const useEquipmentGLTF = (url: string) => useLoader(world.Loader, url);
export const usePovGLTF = (url: string) => useLoader(pov.Loader, url);
function useNativeScope(cache: ModelCache<GLTF>, url: string, identity: object) {
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
