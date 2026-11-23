import {
  FileLoader,
  ImageBitmapLoader,
  LoaderUtils,
  LoadingManager,
  TextureLoader,
  type Texture,
} from 'three';
import { GLTFLoader, MeshoptDecoder, type GLTF } from 'three-stdlib';
import type { ModelLoadCallbacks } from './model-cache';
type ScopedGLTFJob = (
  url: string,
  callbacks: ModelLoadCallbacks<GLTF>,
  maxBytes?: number,
  embeddedOnly?: boolean,
  configure?: (parser: GLTFLoader) => void,
  maxTextureEdge?: number,
) => () => void;

async function compactImage(image: ImageBitmap | HTMLImageElement, edge: number) {
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;
  const scale = edge / Math.max(width, height);
  if (scale >= 1) return image;
  const resizeWidth = Math.max(1, Math.round(width * scale));
  const resizeHeight = Math.max(1, Math.round(height * scale));
  if (typeof createImageBitmap === 'function') {
    const resized = await createImageBitmap(image, {
      resizeWidth,
      resizeHeight,
      resizeQuality: 'high',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    if ('close' in image) image.close();
    return resized;
  }
  const canvas = document.createElement('canvas');
  canvas.width = resizeWidth;
  canvas.height = resizeHeight;
  const context = canvas.getContext('2d');
  if (!context) throw Error('Could not prepare compact equipment textures');
  context.drawImage(image, 0, 0, resizeWidth, resizeHeight);
  return canvas;
}

/** A private manager owns only this request's cancellation, blob URLs and image bitmaps. */
export const loadScopedGLTF: ScopedGLTFJob = (
  url,
  callbacks,
  maxBytes = Infinity,
  embeddedOnly = false,
  configure,
  maxTextureEdge,
) => {
  const manager = new LoadingManager(),
    file = new FileLoader(manager),
    parser = new GLTFLoader(manager);
  const blobURLs = new Set<string>(),
    bitmaps = new Set<ImageBitmap>();
  let cancelled = false,
    finished = false,
    parsing = false;
  const aborted = () => new Error('Model loading cancelled');
  manager.setURLModifier((value) => {
    if (cancelled && (!parsing || !value.startsWith('blob:'))) {
      if (value.startsWith('blob:')) URL.revokeObjectURL(value);
      throw aborted();
    }
    if (embeddedOnly && value !== url && !value.startsWith('blob:'))
      throw new Error('Equipment model contains an external resource');
    if (value.startsWith('blob:')) blobURLs.add(value);
    return value;
  });
  const revoke = () => {
    for (const url of blobURLs) URL.revokeObjectURL(url);
    blobURLs.clear();
  };
  const cancel = () => {
    cancelled = true;
    file.abort();
    // Embedded parsing is bounded and local. Aborting/revoking an in-flight blob fetch
    // makes Three report a false texture failure when a held item simply disappears.
    // Let it settle; the retired cache generation disposes every late GLTF resource.
    if (parsing && !finished) return;
    manager.abort();
    revoke();
    for (const bitmap of bitmaps) bitmap.close();
    bitmaps.clear();
  };
  const failed = (error: unknown) => {
    if (finished) return;
    finished = true;
    parsing = false;
    cancel();
    callbacks.failed(error);
  };
  parser.register((scoped) => {
    return {
      name: 'cswatch-scoped-resource-owner',
      beforeRoot: () => {
        if (embeddedOnly) {
          const json = scoped.json;
          if (
            (json.buffers || []).some((buffer: { uri?: string }) => buffer.uri !== undefined) ||
            (json.images || []).some(
              (image: { uri?: string; bufferView?: number }) =>
                image.uri !== undefined || !Number.isInteger(image.bufferView),
            )
          )
            throw new Error('Equipment model must embed its resources');
        }
        const textures = scoped.textureLoader;
        if (textures instanceof ImageBitmapLoader) {
          const load = textures.load.bind(textures);
          textures.load = (url, onLoad, onProgress, onError) =>
            load(
              url,
              (bitmap) => {
                bitmaps.add(bitmap);
                const deliver = (result: ImageBitmap) => {
                  bitmaps.delete(bitmap);
                  if (finished || (cancelled && !parsing)) {
                    result.close();
                    onError?.(aborted());
                    return;
                  }
                  bitmaps.add(result);
                  onLoad?.(result);
                };
                if (maxTextureEdge)
                  void compactImage(bitmap, maxTextureEdge).then(
                    (result) => deliver(result as ImageBitmap),
                    onError,
                  );
                else deliver(bitmap);
              },
              onProgress,
              onError,
            );
        } else if (maxTextureEdge && textures instanceof TextureLoader) {
          const load = textures.load.bind(textures);
          textures.load = (url, onLoad, onProgress, onError) =>
            load(
              url,
              (texture) => {
                void compactImage(texture.image as HTMLImageElement, maxTextureEdge).then(
                  (image) => {
                    if (finished || (cancelled && !parsing)) {
                      if ('close' in image) image.close();
                      onError?.(aborted());
                      return;
                    }
                    if ('close' in image) bitmaps.add(image);
                    (texture as Texture).image = image;
                    texture.needsUpdate = true;
                    onLoad?.(texture);
                  },
                  onError,
                );
              },
              onProgress,
              onError,
            );
        }
        return null;
      },
    };
  });
  parser.setMeshoptDecoder(
    typeof MeshoptDecoder === 'function' ? MeshoptDecoder() : MeshoptDecoder,
  );
  configure?.(parser);
  file.setResponseType('arraybuffer');
  file.load(
    url,
    (data) => {
      if (cancelled) {
        failed(aborted());
        return;
      }
      try {
        if (!(data instanceof ArrayBuffer) || data.byteLength > maxBytes)
          throw new Error('Model exceeds its transfer limit');
        parsing = true;
        callbacks.downloaded?.();
        parser.parse(
          data as ArrayBuffer,
          LoaderUtils.extractUrlBase(url),
          (value) => {
            if (finished) return;
            finished = true;
            parsing = false;
            revoke();
            bitmaps.clear();
            callbacks.loaded(value);
          },
          failed,
        );
      } catch (error) {
        failed(error);
      }
    },
    (event) => {
      if (event.loaded > maxBytes || event.total > maxBytes) {
        failed(new Error('Model exceeds its transfer limit'));
        return;
      }
      callbacks.progress?.(event);
    },
    failed,
  );
  return cancel;
};
