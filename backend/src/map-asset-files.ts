import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
export { fileVersion, fileDigest } from './asset-content.js';

/** DATA_DIR is operator configuration. Every child is descriptor-anchored and
 * no-follow, so replacing a directory never redirects a later file open. */
export async function withDirectory<T>(
  root: string,
  parts: string[],
  read: (directory: FileHandle) => Promise<T>,
): Promise<T | undefined> {
  const handles: FileHandle[] = [];
  try {
    if (process.platform !== 'linux') return;
    handles.push(await open(root, constants.O_RDONLY | constants.O_DIRECTORY));
    for (const part of parts)
      handles.push(
        await open(
          `/proc/self/fd/${handles.at(-1)!.fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
    return await read(handles.at(-1)!);
  } catch {
    return;
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function regularFile(
  directory: FileHandle,
  filename: string,
  min: number,
  max: number,
): Promise<FileHandle | undefined> {
  const file = await open(
    `/proc/self/fd/${directory.fd}/${filename}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < min || info.size > max) {
      await file.close();
      return;
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function bytesFrom(file: FileHandle, size: number, max: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > max)
    throw new Error('Map asset size limit');
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!result.bytesRead) throw new Error('Incomplete map asset');
    offset += result.bytesRead;
  }
  return bytes;
}
