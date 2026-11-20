import { useLayoutEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { Loader, LoadingManager } from 'three';
import type { GLTF } from 'three-stdlib';
import { loadScopedGLTF } from './scoped-gltf-loader';
import { ModelCache, type ModelScope } from './model-cache';
import { mapModelResources } from './map-model-resources';
import { registerMapBakedLighting } from './map-baked-lighting';

const MiB = 1024 * 1024;
const inactiveLimit = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width:780px),(pointer:coarse)').matches
    ? 512 * MiB
    : 1024 * MiB;

const cache = new ModelCache<GLTF>({
  inactiveBytes: inactiveLimit,
  maxUnused: 2,
  maxConcurrent: 2,
  clear: (url) => useLoader.clear(MapGLTFLoader, url),
  inspect: mapModelResources,
  load: (url, callbacks) =>
    loadScopedGLTF(url, callbacks, undefined, false, registerMapBakedLighting),
});

/** Private map loader class gives useLoader a cache namespace separate from agent assets. */
export class MapGLTFLoader extends Loader<GLTF> {
  constructor() {
    super(new LoadingManager());
  }
  load(
    url: string,
    onLoad: (value: GLTF) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): void {
    cache.request(url, {
      loaded: onLoad,
      failed: (error) => onError?.(error),
      progress: onProgress,
    });
  }
}
export function useMapGLTF(url: string) {
  return useLoader(MapGLTFLoader, url);
}

/** Keep current-map decoded images reusable through 2D and pin actual Model teardown separately. */
export function useMapModelScope(url: string | null, attempt: object): ModelScope | null {
  const scope = useMemo(() => (url ? cache.scope(url) : null), [url, attempt]);
  useLayoutEffect(() => scope?.acquire(), [scope]);
  return scope;
}
