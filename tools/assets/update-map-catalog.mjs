#!/usr/bin/env node
/** Explicit operator maintenance, separate from web and acquisition credentials. */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mapCatalogLimits, mapCatalogSchema } from '../../backend/dist/map-catalog.js';
import { fileVersion, regularFile, withDirectory } from '../../backend/dist/map-asset-files.js';

async function boundedCatalog(input) {
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.byteLength;
    if (!Number.isSafeInteger(size) || size < 0 || size > mapCatalogLimits.bytes - length)
      throw Error('Catalog exceeds its byte limit.');
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    length += bytes.length;
    chunks.push(bytes);
  }
  if (length < 2) throw Error('A complete reviewed catalog is required on stdin.');
  const catalog = mapCatalogSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))),
  );
  const bytes = Buffer.from(JSON.stringify(catalog) + '\n');
  if (bytes.length > mapCatalogLimits.bytes) throw Error('Catalog exceeds its byte limit.');
  return { catalog, bytes };
}

/** All ancestors are opened separately with O_NOFOLLOW. The final owned control
 * directory remains pinned for every lock, temporary file and rename operation.
 * A flock serializes cooperating maintenance containers and releases on crashes.
 * The directory must be writable only by its trusted operator UID. */
export async function updateMapCatalog({
  filename = process.env.MAP_CATALOG_FILE || '/map-catalog/catalog.json',
  input = process.stdin,
} = {}) {
  if (
    process.platform !== 'linux' ||
    !isAbsolute(filename) ||
    resolve(filename) !== filename ||
    filename.endsWith(sep) ||
    filename.split(sep).at(-1) !== 'catalog.json'
  )
    throw Error('A normalized absolute catalog.json path on Linux is required.');
  const { catalog, bytes } = await boundedCatalog(input);
  const result = await withDirectory(
    '/',
    dirname(filename).split(sep).filter(Boolean),
    async (directory) => {
      const owner = await directory.stat();
      if (owner.uid !== process.geteuid() || owner.mode & 0o022)
        throw Error('Catalog directory must be owned and private to the operator UID.');
      const anchor = '/proc/self/fd/' + directory.fd + '/';
      const lock = await open(
        anchor + '.catalog-update.lock',
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      let temporary;
      let temporaryFile;
      let existing;
      try {
        const lockInfo = await lock.stat();
        if (
          !lockInfo.isFile() ||
          lockInfo.nlink !== 1 ||
          lockInfo.uid !== process.geteuid() ||
          lockInfo.size > 4096 ||
          lockInfo.mode & 0o022
        )
          throw Error('Unsafe catalog maintenance lock.');
        const leased = spawnSync('flock', ['-n', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', lock.fd],
          timeout: 5000,
        });
        if (leased.error || leased.status !== 0)
          throw Error('Catalog maintenance is already active or flock is unavailable.');
        const targetVersion = async () => {
          let file;
          try {
            file = await regularFile(directory, 'catalog.json', 0, mapCatalogLimits.bytes);
            if (!file) throw Error('Unsafe existing catalog.');
            const info = await file.stat();
            if (info.uid !== process.geteuid() || info.mode & 0o022)
              throw Error('Unsafe existing catalog owner or mode.');
            return await fileVersion(file);
          } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
          } finally {
            await file?.close();
          }
        };
        existing = await targetVersion();
        temporary = anchor + '.catalog-' + randomBytes(16).toString('hex') + '.tmp';
        temporaryFile = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o640,
        );
        await temporaryFile.writeFile(bytes);
        await temporaryFile.sync();
        await temporaryFile.close();
        temporaryFile = undefined;
        if (existing !== (await targetVersion()))
          throw Error('Catalog changed during maintenance.');
        await rename(temporary, anchor + 'catalog.json');
        temporary = undefined;
        await directory.sync();
        return { entries: catalog.entries.length, bytes: bytes.length };
      } finally {
        await temporaryFile?.close();
        if (temporary) await unlink(temporary).catch(() => {});
        await lock.close();
      }
    },
  );
  if (!result)
    throw Error(
      'Catalog update refused: validate the catalog, ownership and real filesystem paths.',
    );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2)
      throw Error('Usage: update-map-catalog reads a reviewed catalog from stdin.');
    console.log(JSON.stringify(await updateMapCatalog()));
  } catch {
    console.error(
      'Catalog update refused. Supply a valid bounded catalog and an owned real catalog directory.',
    );
    process.exitCode = 1;
  }
}
