import type { Manifest } from './format';

// Hash, inflate and transpose in a worker so downloaded high mips cannot stall camera input.
export function assetReader(dir: URL, manifest: Manifest) {
  const worker = new Worker(new URL('./asset-worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<
    number,
    {
      resolve: (bytes: Uint8Array<ArrayBuffer>) => void;
      reject: (error: Error) => void;
      read: Promise<Uint8Array<ArrayBuffer>>;
    }
  >();
  let sequence = 0;
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(Error(data.error));
    else request.resolve(data.bytes);
  };
  worker.onerror = (event) => {
    for (const request of pending.values()) request.reject(Error(event.message));
    pending.clear();
  };
  return {
    read(file: string) {
      const id = ++sequence;
      let settle!: {
        resolve: (bytes: Uint8Array<ArrayBuffer>) => void;
        reject: (error: Error) => void;
      };
      const read = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        settle = { resolve, reject };
      });
      pending.set(id, { ...settle, read });
      worker.postMessage({ id, directory: dir.href, file, record: manifest.files[file] });
      return read;
    },
    close() {
      for (const request of pending.values()) {
        // Closing ends the map: a read nobody awaits any more (a texture
        // prefetch at teardown) is a handled abort, not an uncaught error.
        // A caller that still awaits the read receives the AbortError.
        request.read.catch(() => {});
        request.reject(new DOMException('Map closed', 'AbortError'));
      }
      pending.clear();
      worker.terminate();
    },
  };
}
