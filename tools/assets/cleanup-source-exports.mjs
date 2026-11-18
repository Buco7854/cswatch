/** Remove only superseded, verified, private per-map exports made by this run. */
import { constants } from 'node:fs';
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { selectedMaps, steamAssetLimits } from './steam-assets-plan.mjs';
import { fileHash, regular } from './asset-storage.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';

async function realDirectory(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path))
    throw new Error('Source cleanup requires real private directories without links.');
  return `${info.dev}:${info.ino}`;
}

export async function cleanupSourceExports({
  stage,
  map,
  assetVersion,
  mergedInput,
  sources,
  provenance,
}) {
  selectedMaps([map]);
  const root = resolve(stage);
  const rootIdentity = await realDirectory(root);
  if (!Array.isArray(sources) || sources.length !== 2 || new Set(sources).size !== 2)
    throw new Error('Source cleanup requires the two exports from this map installation.');
  const expected = [new RegExp(`^${map}-export-[0-2]$`), new RegExp(`^${map}-sky-export-[0-2]$`)];
  const directories = [];
  for (const [index, source] of sources.entries()) {
    if (typeof source !== 'string') throw new Error('Unexpected source export cleanup path.');
    const absolute = resolve(source),
      directory = dirname(absolute);
    if (
      dirname(directory) !== root ||
      basename(absolute) !== 'scene.gltf' ||
      !expected[index].test(basename(directory))
    )
      throw new Error(
        'Source cleanup path is outside this run’s exact per-map export directories.',
      );
    directories.push({
      path: directory,
      identity: await realDirectory(directory),
      source: absolute,
    });
  }
  const merged = resolve(mergedInput);
  const provenancePath = resolve(provenance);
  if (
    !merged.startsWith(root + '/') ||
    directories.some(({ path }) => merged.startsWith(path + '/')) ||
    provenancePath !== join(root, 'prepared', 'environments', map, 'provenance.json')
  )
    throw new Error('Source cleanup cannot remove the merged result or use external provenance.');
  await realDirectory(dirname(merged));
  await realDirectory(dirname(provenancePath));
  const verifiedMerged = await verifyPreparedGlb(merged);
  let entries = 0,
    bytes = 0;
  async function inspect(path) {
    for (const name of await readdir(path)) {
      if (++entries > 100000)
        throw new Error('Source export cleanup file count exceeds its bound.');
      const child = join(path, name),
        info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error('Source export cleanup rejects symbolic links.');
      if (info.isDirectory()) await inspect(child);
      else if (info.isFile() && info.nlink === 1) {
        bytes += info.size;
        if (bytes > steamAssetLimits.outputBytes)
          throw new Error('Source exports exceed the cleanup byte bound.');
      } else throw new Error('Source export cleanup rejects linked or special files.');
    }
  }
  const records = [];
  for (const directory of directories) {
    await inspect(directory.path);
    records.push({
      path: relative(root, directory.source),
      sha256: await fileHash(directory.source, 'sha256', 64 * 1024 ** 2),
    });
  }
  await regular(provenancePath, 1024 * 1024);
  const original = JSON.parse(
    await readFile(provenancePath, {
      encoding: 'utf8',
      flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    }),
  );
  if (
    !original ||
    original.schemaVersion !== 1 ||
    original.map !== map ||
    original.assetVersion !== assetVersion
  )
    throw new Error('Source cleanup provenance does not belong to this prepared environment.');
  const report = {
    verifiedMerged,
    sources: records,
    directories: directories.map(({ path }) => relative(root, path)),
    bytes,
    files: entries,
  };
  const serialized = JSON.stringify({ ...original, sourceExportsCleaned: report }, null, 2);
  if (Buffer.byteLength(serialized) > 1024 * 1024)
    throw new Error('Source cleanup provenance exceeds its byte bound.');
  const next = join(dirname(provenancePath), 'cleanup-provenance.json');
  await writeFile(next, serialized, { flag: 'wx', mode: 0o600 });
  await rename(next, provenancePath);
  // Complete every path and file check before deleting either source. The stage
  // is private to this installer; directory identity is rechecked at mutation.
  if ((await realDirectory(root)) !== rootIdentity)
    throw new Error('Installation stage changed before source cleanup.');
  for (const directory of directories) {
    if ((await realDirectory(directory.path)) !== directory.identity)
      throw new Error('Source export changed before cleanup.');
  }
  for (const directory of directories) await rm(directory.path, { recursive: true, force: false });
  return report;
}
