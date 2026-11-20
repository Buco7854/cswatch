import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { steamAssetLimits } from './steam-assets-plan.mjs';

export const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
export async function readableDirectory(path) {
  let current = '/';
  for (const part of resolve(path).split('/').filter(Boolean)) {
    current = join(current, part);
    let created = false;
    try {
      await mkdir(current, { mode: 0o755 });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Operator asset paths must contain only real directories.');
    if (created) await chmod(current, 0o755);
  }
}
export async function regular(path, max, min = 1) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < min ||
    info.size > max
  )
    throw new Error('Expected a bounded regular operator asset file.');
  return info;
}
export async function fileHash(path, algorithm = 'sha256', max = steamAssetLimits.outputBytes) {
  const initial = await regular(path, max);
  const hash = createHash(algorithm);
  let bytes = 0;
  for await (const chunk of createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  })) {
    bytes += chunk.length;
    if (bytes > max) throw new Error('Operator asset grew beyond its byte limit.');
    hash.update(chunk);
  }
  const after = await regular(path, max);
  if (
    bytes !== initial.size ||
    after.ino !== initial.ino ||
    after.dev !== initial.dev ||
    after.size !== initial.size ||
    after.mtimeMs !== initial.mtimeMs ||
    after.ctimeMs !== initial.ctimeMs
  )
    throw new Error('Operator asset changed during verification.');
  return hash.digest('hex');
}
export async function allocatedStorage(root) {
  let physicalBytes = 0,
    logicalBytes = 0,
    files = 0;
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++files > 100000) throw new Error('Asset cache file count limit exceeded.');
      const child = join(path, entry.name),
        info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error('Asset cache may not contain symlinks.');
      if (info.isDirectory()) await walk(child);
      else if (info.isFile()) {
        physicalBytes += info.blocks * 512;
        logicalBytes += info.size;
      } else throw new Error('Asset cache contains a non-regular entry.');
    }
  }
  await walk(root);
  return { physicalBytes, logicalBytes, files };
}
export async function checkStorage(cache, output, needed = 0) {
  const storage = await allocatedStorage(cache);
  if (storage.physicalBytes > steamAssetLimits.cacheBytes)
    throw new Error('Asset cache exceeds the 16 GiB allocated-storage limit.');
  await checkFreeReserve(cache, output, needed);
  return storage;
}
/** Periodic guards check only filesystem counters, never recursively scan files. */
export async function checkFreeReserve(cache, output, needed = 0) {
  if (!(await hasFreeReserve(cache, output, needed)))
    throw new Error(
      'Insufficient free disk space for the selective asset stage and 512 MiB reserve.',
    );
}
export async function hasFreeReserve(cache, output, needed) {
  for (const path of [cache, output]) {
    const disk = await statfs(path),
      available = disk.bavail * disk.bsize;
    if (available < steamAssetLimits.reserveBytes + needed) return false;
  }
  return true;
}
