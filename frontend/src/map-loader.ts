import { useLayoutEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import { ImageBitmapLoader, Loader, LoadingManager, Texture } from 'three';
import type { GLTF, GLTFLoader } from 'three-stdlib';
import { loadScopedGLTF } from './scoped-gltf-loader';
import { ModelCache, type ModelScope } from './model-cache';
import { mapModelResources } from './map-model-resources';
import { registerMapBakedLighting } from './map-baked-lighting';
import { reusePackedMapSamples } from './map-packed-material';
import { improveMapTextureDetail } from './map-texture-detail';

const MiB = 1024 * 1024;
const inactiveLimit = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width:780px),(pointer:coarse)').matches
    ? 512 * MiB
    : 1024 * MiB;

/** Keep Three's sampler, channel, color-space and material handling. For ordinary embedded
 * map images, the bytes already belong to the parser and need no blob URL or fetch. */
function configureMap(loader: GLTFLoader, ownBitmap: (image: ImageBitmap) => void) {
  registerMapBakedLighting(loader);
  loader.register((parser) => ({
    name: 'cswatch-embedded-map-images',
    beforeRoot() {
      const bitmaps = parser.textureLoader;
      if (!(bitmaps instanceof ImageBitmapLoader)) return null;
      const original = parser.loadImageSource.bind(parser);
      const sources = new Map<number, Promise<Texture>>();
      parser.loadImageSource = (index, imageLoader) => {
        const image = parser.json.images[index];
        if (
          imageLoader !== bitmaps ||
          image.uri !== undefined ||
          !Number.isSafeInteger(image.bufferView) ||
          image.extras !== undefined ||
          !['image/webp', 'image/png', 'image/jpeg'].includes(image.mimeType)
        )
          return original(index, imageLoader);
        const existing = sources.get(index);
        if (existing) return existing.then((texture) => texture.clone());
        const pending = parser
          .getDependency('bufferView', image.bufferView)
          .then(async (bytes: ArrayBuffer) => {
            const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }), {
              ...bitmaps.options,
              colorSpaceConversion: 'none',
            });
            ownBitmap(bitmap);
            const texture = new Texture(bitmap);
            texture.needsUpdate = true;
            texture.userData.mimeType = image.mimeType;
            return texture;
          });
        sources.set(index, pending);
        return pending;
      };
      return null;
    },
  }));
}

const cache = new ModelCache<GLTF>({
  inactiveBytes: inactiveLimit,
  maxUnused: 2,
  maxConcurrent: 2,
  clear: (url) => useLoader.clear(MapGLTFLoader, url),
  inspect: mapModelResources,
  load: (url, callbacks) =>
    loadScopedGLTF(
      url,
      {
        ...callbacks,
        loaded(gltf) {
          reusePackedMapSamples(gltf.scenes);
          if (url.split('/').at(-2) === 'desktop') improveMapTextureDetail(gltf.scenes);
          callbacks.loaded(gltf);
        },
      },
      undefined,
      false,
      configureMap,
    ),
});

/** Private map loader class gives useLoader a cache namespace separate from agent assets. */
class MapGLTFLoader extends Loader<GLTF> {
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
