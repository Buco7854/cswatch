import { FileLoader, ImageBitmapLoader, LoaderUtils, LoadingManager } from 'three';
import { GLTFLoader, MeshoptDecoder, type GLTF } from 'three-stdlib';
export type ScopedGLTFJob = (
  url: string,
  callbacks: {
    loaded: (value: GLTF) => void;
    failed: (error: unknown) => void;
    progress?: (event: ProgressEvent) => void;
  },
  maxBytes?: number,
  embeddedOnly?: boolean,
) => () => void;

/** A private manager owns only this request's cancellation, blob URLs and image bitmaps. */
export const loadScopedGLTF: ScopedGLTFJob = (
  url,
  callbacks,
  maxBytes = Infinity,
  embeddedOnly = false,
) => {
  const manager = new LoadingManager(),
    file = new FileLoader(manager),
    parser = new GLTFLoader(manager);
  const blobURLs = new Set<string>(),
    bitmaps = new Set<ImageBitmap>();
  let cancelled = false,
    finished = false;
  const aborted = () => new Error('Model loading cancelled');
  manager.setURLModifier((value) => {
    if (cancelled) {
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
    manager.abort();
    revoke();
    for (const bitmap of bitmaps) bitmap.close();
    bitmaps.clear();
  };
  const failed = (error: unknown) => {
    if (finished) return;
    finished = true;
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
                if (cancelled) {
                  bitmap.close();
                  onError?.(aborted());
                  return;
                }
                bitmaps.add(bitmap);
                onLoad?.(bitmap);
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
        parser.parse(
          data as ArrayBuffer,
          LoaderUtils.extractUrlBase(url),
          (value) => {
            if (finished) return;
            finished = true;
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
