import { useLayoutEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { Loader, LoadingManager } from 'three';
import type { GLTF } from 'three-stdlib';
import { ModelCache } from './model-cache';
import { mapModelResources } from './map-model-resources';
import { loadScopedGLTF } from './scoped-gltf-loader';

const MiB = 1024 * 1024;
const mobile = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width:780px),(pointer:coarse)').matches;
const cache = new ModelCache<GLTF>({
  maxUnused: 12,
  maxConcurrent: 2,
  inactiveBytes: () => (mobile() ? 32 : 64) * MiB,
  residentBytes: () => (mobile() ? 128 : 256) * MiB,
  inspect: mapModelResources,
  clear: (url) => useLoader.clear(EquipmentGLTFLoader, url),
  load: (url, callbacks) => loadScopedGLTF(url, callbacks, 16 * MiB, true),
});
export class EquipmentGLTFLoader extends Loader<GLTF> {
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
export const useEquipmentGLTF = (url: string) => useLoader(EquipmentGLTFLoader, url);
export function useEquipmentScope(url: string, identity: object) {
  const scope = useMemo(() => cache.scope(url), [url, identity]);
  useLayoutEffect(() => scope.acquire(), [scope]);
  return scope;
}

/** Scene leases retain the two current agent assets across 2D and selected-player POV changes. */
export function useModelLeases(urls: readonly string[], identity: object) {
  const key = urls.join('\0');
  const scopes = useMemo(() => urls.map((url) => cache.scope(url)), [key, identity]);
  useLayoutEffect(() => {
    const releases = scopes.map((scope) => scope.acquire());
    return () => {
      for (const release of releases) release();
    };
  }, [scopes]);
}
