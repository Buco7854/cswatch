/** Operator-only Source 2 dependency planning. Reads local files, never URLs or uploads.
 * Formats: ValvePak VPK tree and ValveResourceFormat Resource/ResourceExtRefList. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const dependencyLimits = Object.freeze({
  vpkFileBytes: 16 * 1024 ** 3,
  treeBytes: 64 * 1024 ** 2,
  entries: 500000,
  resourceBytes: 128 * 1024 ** 2,
  verifyEntryBytes: 512 * 1024 ** 2,
  verifyChunkBytes: 64 * 1024,
  resourcePathBytes: 1024,
  resources: 100000,
  blocks: 1024,
  references: 20000,
  // rush_001, the largest official closure on manifest 5924479096069937098, reads 4.92 GiB.
  totalReadBytes: 6 * 1024 ** 3,
});
const decoder = new TextDecoder('utf-8', { fatal: true });
const embeddedArchive = 0x7fff;
function boundedLimits(options = {}) {
  const result = { ...dependencyLimits, ...options };
  for (const [key, value] of Object.entries(result))
    if (
      !(key in dependencyLimits) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > dependencyLimits[key]
    )
      throw new Error('Invalid dependency limit. Limits may only be tightened.');
  return result;
}
export function resourcePath(
  value,
  { compiled = false, maxBytes = dependencyLimits.resourcePathBytes } = {},
) {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > maxBytes ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    (!/^[A-Za-z0-9_ .@()+,/-]+$/.test(value) &&
      // Compiled entity lumps can carry this internal name marker in the verified VPK.
      !/^maps\/[a-z0-9_]+\/entities\/[0-9]+(?:_[0-9]+){1,7}#entitylumpname\.vents(?:_c)?$/i.test(
        value,
      )) ||
    value
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part.endsWith(' ') || part.endsWith('.'),
      )
  )
    throw new Error('Unsafe Source 2 resource path.');
  const normalized = value.toLowerCase();
  const result = compiled && !normalized.endsWith('_c') ? normalized + '_c' : normalized;
  if (Buffer.byteLength(result) > maxBytes)
    throw new Error('Source 2 resource path exceeds the limit.');
  return result;
}
async function localRegular(path, max) {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    )
      throw new Error('Dependency inputs must be regular local files without linked ancestors.');
  }
  const file = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > max)
      throw new Error('Dependency input file exceeds the limit.');
    return { file, info, path: absolute };
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function slice(file, start, length, max) {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > max ||
    !Number.isSafeInteger(start + length)
  )
    throw new Error('Dependency slice exceeds the limit.');
  const info = await file.stat();
  if (!info.isFile() || info.nlink !== 1 || start + length > info.size)
    throw new Error('Incomplete dependency slice.');
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const part = await file.read(bytes, offset, length - offset, start + offset);
    if (!part.bytesRead) throw new Error('Incomplete dependency slice.');
    offset += part.bytesRead;
  }
  return bytes;
}
const stamp = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const stableIdentity = (info) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
async function sha256(file, size) {
  const digest = createHash('sha256');
  for (let offset = 0; offset < size; offset += 512 * 1024)
    digest.update(await slice(file, offset, Math.min(512 * 1024, size - offset), 512 * 1024));
  return digest.digest('hex');
}

/** The returned index stores only the bounded directory tree, not archive bodies.
 * readEntry returns undefined for unavailable/partial/CRC-failing sparse data. */
export async function readVpkDirectory(path, { limits: options } = {}) {
  const limits = boundedLimits(options),
    source = await localRegular(path, limits.vpkFileBytes);
  try {
    const prefix = await slice(source.file, 0, 12, 12);
    if (prefix.readUInt32LE(0) !== 0x55aa1234) throw new Error('Invalid VPK signature.');
    const version = prefix.readUInt32LE(4),
      treeSize = prefix.readUInt32LE(8),
      headerSize = version === 2 ? 28 : 12;
    if (![1, 2].includes(version) || treeSize < 1 || treeSize > limits.treeBytes)
      throw new Error('Invalid VPK version or tree size.');
    const header = await slice(source.file, 0, headerSize, headerSize);
    const dataSize =
      version === 2 ? header.readUInt32LE(12) : source.info.size - headerSize - treeSize;
    if (dataSize < 0 || headerSize + treeSize + dataSize > limits.vpkFileBytes)
      throw new Error('Invalid VPK data section.');
    const tree = await slice(source.file, headerSize, treeSize, limits.treeBytes),
      entries = new Map();
    let offset = 0;
    const need = (size) => {
      if (offset + size > tree.length) throw new Error('Truncated VPK tree.');
    };
    const string = () => {
      const end = tree.indexOf(0, offset);
      if (end < 0 || end - offset > limits.resourcePathBytes)
        throw new Error('Invalid VPK tree string.');
      const result = decoder.decode(tree.subarray(offset, end));
      offset = end + 1;
      return result;
    };
    for (let extension; (extension = string()) !== '';)
      for (let folder; (folder = string()) !== '';)
        for (let name; (name = string()) !== '';) {
          need(18);
          const checksum = tree.readUInt32LE(offset),
            preloadBytes = tree.readUInt16LE(offset + 4),
            archiveIndex = tree.readUInt16LE(offset + 6),
            start = tree.readUInt32LE(offset + 8),
            length = tree.readUInt32LE(offset + 12),
            terminator = tree.readUInt16LE(offset + 16);
          offset += 18;
          if (
            terminator !== 0xffff ||
            archiveIndex > embeddedArchive ||
            preloadBytes + length > limits.vpkFileBytes
          )
            throw new Error('Invalid VPK entry.');
          need(preloadBytes);
          const preload = tree.subarray(offset, offset + preloadBytes);
          offset += preloadBytes;
          const resource = resourcePath(
            (folder === ' ' ? '' : folder + '/') +
              name +
              (extension === ' ' ? '' : '.' + extension),
            { maxBytes: limits.resourcePathBytes },
          );
          if (entries.has(resource) || entries.size >= limits.entries)
            throw new Error('Duplicate or excessive VPK entries.');
          if (archiveIndex === embeddedArchive && length > 0 && start + length > dataSize)
            throw new Error('VPK entry exceeds embedded data section.');
          if (length > 0 && start + length > limits.vpkFileBytes)
            throw new Error('VPK entry exceeds the archive file limit.');
          if (archiveIndex !== embeddedArchive && !/_dir\.vpk$/i.test(source.path))
            throw new Error('Split VPK entries require a _dir.vpk source.');
          const archivePath =
            archiveIndex === embeddedArchive
              ? source.path
              : join(
                  dirname(source.path),
                  basename(source.path).replace(
                    /_dir\.vpk$/i,
                    `_${String(archiveIndex).padStart(3, '0')}.vpk`,
                  ),
                );
          entries.set(resource, {
            resource,
            archiveIndex,
            archivePath,
            offset: length
              ? start + (archiveIndex === embeddedArchive ? headerSize + treeSize : 0)
              : 0,
            length,
            preloadBytes,
            crc32: checksum,
            preload,
          });
        }
    if (offset !== tree.length) throw new Error('Trailing bytes in VPK directory tree.');
    const hash = await sha256(source.file, source.info.size);
    if (stamp(await source.file.stat()) !== stamp(source.info))
      throw new Error('VPK directory changed during planning.');
    const readEntry = async (name) => {
      const entry = entries.get(resourcePath(name, { maxBytes: limits.resourcePathBytes }));
      if (!entry) return;
      // Directory indexes also contain large unselected shader blobs. Metadata
      // is cheap, but selected RERL resources may never allocate beyond this cap.
      if (entry.preloadBytes + entry.length > limits.resourceBytes)
        throw new Error('Selected VPK resource exceeds the read limit.');
      if (entry.length === 0) {
        const bytes = Buffer.from(entry.preload);
        return crc32(bytes) === entry.crc32 ? bytes : undefined;
      }
      let archive;
      try {
        archive = await localRegular(entry.archivePath, limits.vpkFileBytes);
        const bytes = await slice(archive.file, entry.offset, entry.length, limits.resourceBytes);
        const complete = entry.preloadBytes ? Buffer.concat([entry.preload, bytes]) : bytes;
        if (
          crc32(complete) !== entry.crc32 ||
          stamp(await archive.file.stat()) !== stamp(archive.info)
        )
          return;
        return complete;
      } catch {
        return;
      } finally {
        await archive?.file.close();
      }
    };
    /** CRC-only verification for selected operator shader programs. It never
     * allocates the complete resource or passes large blobs into RERL parsing. */
    const verifyEntry = async (name) => {
      const entry = entries.get(resourcePath(name, { maxBytes: limits.resourcePathBytes }));
      if (!entry) return false;
      if (entry.preloadBytes + entry.length > limits.verifyEntryBytes)
        throw new Error('Selected VPK resource exceeds the streamed verification limit.');
      let checksum = crc32(entry.preload);
      if (!entry.length) return checksum === entry.crc32;
      let archive;
      try {
        archive = await localRegular(entry.archivePath, limits.vpkFileBytes);
        const before = await archive.file.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size > BigInt(limits.vpkFileBytes) ||
          !Number.isSafeInteger(entry.offset + entry.length) ||
          entry.offset + entry.length > Number(before.size)
        )
          return false;
        const buffer = Buffer.alloc(Math.min(limits.verifyChunkBytes, entry.length));
        let offset = 0;
        while (offset < entry.length) {
          const { bytesRead } = await archive.file.read(
            buffer,
            0,
            Math.min(buffer.length, entry.length - offset),
            entry.offset + offset,
          );
          if (!bytesRead) return false;
          checksum = crc32(buffer.subarray(0, bytesRead), checksum);
          offset += bytesRead;
        }
        const after = await archive.file.stat({ bigint: true });
        const named = await lstat(entry.archivePath, { bigint: true });
        return (
          checksum === entry.crc32 &&
          after.isFile() &&
          after.nlink === 1n &&
          named.isFile() &&
          named.nlink === 1n &&
          stableIdentity(before) === stableIdentity(after) &&
          stableIdentity(before) === stableIdentity(named)
        );
      } catch {
        return false;
      } finally {
        await archive?.file.close();
      }
    };
    return {
      entries,
      readEntry,
      verifyEntry,
      provenance: {
        file: basename(source.path),
        path: source.path,
        bytes: source.info.size,
        sha256: hash,
        version,
        treeBytes: treeSize,
        entries: entries.size,
      },
    };
  } finally {
    await source.file.close();
  }
}

/** Resource header offsets are relative to their own uint32 fields. RERL
 * strings are signed offsets from the field after each uint64 resource ID. */
export function source2References(bytes, { limits: options } = {}) {
  const limits = boundedLimits(options);
  if (!Buffer.isBuffer(bytes) || bytes.length > limits.resourceBytes)
    throw new Error('Invalid Source 2 resource buffer.');
  if (bytes.length < 16 || bytes.readUInt16LE(4) !== 12) return [];
  const fileSize = bytes.readUInt32LE(0),
    table = 8 + bytes.readUInt32LE(8),
    count = bytes.readUInt32LE(12);
  if (
    fileSize < 16 ||
    fileSize > bytes.length ||
    count > limits.blocks ||
    (count && (table < 16 || table + count * 12 > fileSize))
  )
    throw new Error('Invalid Source 2 block table.');
  const references = new Set();
  for (let index = 0; index < count; index++) {
    const row = table + index * 12,
      block = row + 4 + bytes.readUInt32LE(row + 4),
      size = bytes.readUInt32LE(row + 8);
    if (block > fileSize || block + size > fileSize)
      throw new Error('Source 2 block exceeds resource bounds.');
    if (bytes.toString('ascii', row, row + 4) !== 'RERL' || !size) continue;
    if (size < 8) throw new Error('Truncated Source 2 reference block.');
    const begin = block + bytes.readUInt32LE(block),
      length = bytes.readUInt32LE(block + 4),
      end = block + size;
    if (length > limits.references || (length && (begin < block + 8 || begin + length * 16 > end)))
      throw new Error('Invalid Source 2 reference table.');
    for (let item = 0; item < length; item++) {
      const position = begin + item * 16 + 8,
        start = position + bytes.readInt32LE(position);
      if (start < block + 8 || start >= end)
        throw new Error('Invalid Source 2 resource string offset.');
      const relativeEnd = bytes
        .subarray(start, Math.min(end, start + limits.resourcePathBytes + 1))
        .indexOf(0);
      if (relativeEnd < 0) throw new Error('Invalid Source 2 resource string offset.');
      const terminator = start + relativeEnd;
      references.add(
        resourcePath(decoder.decode(bytes.subarray(start, terminator)), {
          compiled: true,
          maxBytes: limits.resourcePathBytes,
        }),
      );
      if (references.size > limits.references) throw new Error('Too many Source 2 references.');
    }
  }
  return [...references];
}

/** Re-run after fetching pending entries. A CRC-proven available material may
 * reveal texture dependencies that were intentionally absent in an earlier pass. */
export async function scanSource2Dependencies({
  mapVpk,
  addonVpk,
  csgoVpk,
  coreVpk,
  looseRoots = [],
  required = [],
  limits: options,
}) {
  const limits = boundedLimits(options);
  if (
    !Array.isArray(looseRoots) ||
    looseRoots.length > 16 ||
    !Array.isArray(required) ||
    required.length > limits.resources
  )
    throw new Error('Dependency root or seed limit exceeded.');
  const sources = [];
  // gameinfo mounts the official addon root ahead of the game's own packages.
  for (const [group, path] of [
    ['map', mapVpk],
    ['addon', addonVpk],
    ['csgo', csgoVpk],
    ['core', coreVpk],
  ])
    if (path) sources.push({ group, index: await readVpkDirectory(path, { limits }) });
  if (!sources.some((source) => source.group === 'map'))
    throw new Error('Provide a complete local map VPK.');
  const roots = looseRoots.map((root) => resolve(root));
  const initial = [
    ...sources.find((source) => source.group === 'map').index.entries.keys(),
    ...required.map((name) => resourcePath(name, { maxBytes: limits.resourcePathBytes })),
  ];
  const queue = [...new Set(initial)],
    queued = new Set(queue),
    visited = new Set(),
    pending = { map: [], addon: [], csgo: [], core: [] },
    unknown = [],
    loose = [],
    materials = [];
  if (queue.length > limits.resources) throw new Error('Dependency resource limit exceeded.');
  let read = 0,
    readBytes = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const resource = queue[cursor];
    visited.add(resource);
    let bytes, looseSource;
    for (const root of roots) {
      let local;
      try {
        local = await localRegular(join(root, ...resource.split('/')), limits.resourceBytes);
        bytes = await slice(local.file, 0, local.info.size, limits.resourceBytes);
        if (stamp(await local.file.stat()) !== stamp(local.info))
          throw new Error('Loose resource changed during planning.');
        looseSource = root;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally {
        await local?.file.close();
      }
    }
    const source = sources.find((candidate) => candidate.index.entries.has(resource));
    if (!bytes && source) bytes = await source.index.readEntry(resource);
    if (!bytes) {
      if (source) {
        const { preload: _preload, ...entry } = source.index.entries.get(resource);
        pending[source.group].push(entry);
      } else unknown.push(resource);
      continue;
    }
    read++;
    readBytes += bytes.length;
    if (readBytes > limits.totalReadBytes) throw new Error('Dependency read budget exceeded.');
    if (looseSource)
      loose.push({
        resource,
        root: looseSource,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    if (resource.endsWith('.vmat_c'))
      materials.push({
        resource,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        source: looseSource
          ? { kind: 'loose', path: join(looseSource, resource) }
          : { kind: 'vpk', path: source.index.provenance.path },
      });
    for (const reference of source2References(bytes, { limits }))
      if (!queued.has(reference)) {
        if (queue.length >= limits.resources)
          throw new Error('Dependency resource limit exceeded.');
        queued.add(reference);
        queue.push(reference);
      }
  }
  const pendingCount = Object.values(pending).reduce((sum, records) => sum + records.length, 0);
  return {
    schemaVersion: 1,
    sources: sources.map(({ group, index }) => ({ group, ...index.provenance })),
    loose,
    materials,
    counts: {
      initial: new Set(initial).size,
      visited: visited.size,
      read,
      readBytes,
      pending: pendingCount,
      unknown: unknown.length,
    },
    pending,
    unknown,
    complete: pendingCount === 0 && unknown.length === 0,
  };
}
