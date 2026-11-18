import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function fileVersion(file: FileHandle) {
  const info = await file.stat({ bigint: true });
  if (!info.isFile() || info.nlink !== 1n) throw new Error('Invalid asset file');
  return `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}:${info.size}`;
}

/** Filesystems may reuse even nanosecond timestamps for different same-size
 * writes. Cache reuse therefore requires a fresh bounded content proof. */
export async function fileDigest(file: FileHandle, maximum: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid asset digest bound');
  const before = await fileVersion(file);
  const info = await file.stat();
  if (info.size < 1 || info.size > maximum)
    throw new Error('Asset exceeds its content proof bound');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(65536, maximum));
  let position = 0;
  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, maximum - position + 1),
      position,
    );
    signal?.throwIfAborted();
    if (!bytesRead) break;
    position += bytesRead;
    if (position > maximum) throw new Error('Asset grew beyond its content proof bound');
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (position !== info.size || before !== (await fileVersion(file)))
    throw new Error('Asset changed during content verification');
  signal?.throwIfAborted();
  return hash.digest('hex');
}
