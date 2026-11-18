/** Bounded trusted-local glTF reads, validated before any decoded geometry allocation. */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { localDirectory } from './toolchain-security.mjs';
import { fileHash } from './asset-storage.mjs';
import { equipmentModelLimits as limits } from './equipment-model-registry.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function safeFile(path, max) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > max ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error('Equipment source must be a bounded operator-owned regular file.');
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
/** Reject declarations that could allocate excessive arrays before NodeIO decodes them. */
export function validateEquipmentGeometryMetadata(json) {
  const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 },
    parts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
  if (
    !Array.isArray(json.accessors) ||
    !json.accessors.length ||
    json.accessors.length > 8192 ||
    !Array.isArray(json.bufferViews) ||
    json.bufferViews.length > 8192 ||
    !Array.isArray(json.buffers) ||
    !json.buffers.length ||
    json.buffers.length > 512
  )
    throw Error('Equipment geometry metadata exceeds its bounded structure.');
  let total = 0,
    decoded = 0;
  const sparseEntries = [];
  for (const buffer of json.buffers)
    if (!integer(buffer.byteLength, 1) || buffer.byteLength > limits.sourceFileBytes)
      throw Error('Equipment buffer declaration exceeds its source bound.');
  for (const [accessorIndex, accessor] of json.accessors.entries()) {
    const component = sizes[accessor.componentType],
      components = parts[accessor.type],
      matrix = accessor.type?.startsWith('MAT') ? Number(accessor.type.slice(3)) : 0;
    const bytes = matrix
      ? Math.ceil((matrix * component) / 4) * 4 * matrix
      : component * components;
    if (
      !component ||
      !components ||
      !integer(accessor.count, 1) ||
      !integer(accessor.byteOffset ?? 0) ||
      (accessor.byteOffset ?? 0) % component ||
      (accessor.bufferView === undefined
        ? !accessor.sparse || (accessor.byteOffset ?? 0) !== 0
        : !integer(accessor.bufferView) || !json.bufferViews[accessor.bufferView]) ||
      accessor.count * bytes > limits.geometryBytes
    )
      throw Error('Equipment accessor allocation exceeds 8 MiB or has invalid storage.');
    total += accessor.count * bytes;
    if (total > limits.geometryBytes) throw Error('Equipment accessor allocations exceed8MiB.');
    const view = json.bufferViews[accessor.bufferView];
    if (view) {
      const stride = view.byteStride ?? bytes;
      if (
        !integer(stride, bytes) ||
        !integer(view.byteLength, 1) ||
        ((view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)) % component ||
        (accessor.byteOffset ?? 0) + (accessor.count - 1) * stride + bytes > view.byteLength
      )
        throw Error('Equipment accessor exceeds its buffer view.');
    }
    if (accessor.sparse !== undefined) {
      const sparse = accessor.sparse,
        indexBytes = { 5121: 1, 5123: 2, 5125: 4 }[sparse?.indices?.componentType];
      if (!sparse || !integer(sparse.count, 1) || sparse.count > accessor.count || !indexBytes)
        throw Error('Equipment sparse accessor count/type exceeds its bounded dense allocation.');
      for (const [entry, width] of [
        [sparse.indices, indexBytes],
        [sparse.values, bytes],
      ]) {
        const sparseView = entry && json.bufferViews[entry.bufferView],
          alignment = entry === sparse.indices ? indexBytes : component;
        if (
          !entry ||
          !integer(entry.bufferView) ||
          !sparseView ||
          !integer(entry.byteOffset ?? 0) ||
          (entry.byteOffset ?? 0) % alignment ||
          ((sparseView.byteOffset ?? 0) + (entry.byteOffset ?? 0)) % alignment ||
          !integer(sparseView.byteLength, 1) ||
          (entry.byteOffset ?? 0) + sparse.count * width > sparseView.byteLength ||
          sparseView.byteStride !== undefined ||
          sparseView.extensions?.EXT_meshopt_compression !== undefined
        )
          throw Error('Equipment sparse accessor index/value range or alignment is invalid.');
      }
      sparseEntries.push({
        accessor: accessorIndex,
        count: sparse.count,
        indexBytes,
        bufferView: sparse.indices.bufferView,
        byteOffset: sparse.indices.byteOffset ?? 0,
        maximum: accessor.count,
      });
    }
  }
  for (const view of json.bufferViews) {
    if (
      !integer(view.buffer) ||
      !json.buffers[view.buffer] ||
      !integer(view.byteOffset ?? 0) ||
      !integer(view.byteLength, 1) ||
      (view.byteOffset ?? 0) + view.byteLength > json.buffers[view.buffer].byteLength ||
      (view.byteStride !== undefined &&
        (!integer(view.byteStride, 4) || view.byteStride > 252 || view.byteStride % 4))
    )
      throw Error('Equipment buffer view exceeds its bounded buffer.');
    const ext = view.extensions?.EXT_meshopt_compression;
    if (ext === undefined) continue;
    if (
      !ext ||
      !integer(ext.buffer) ||
      !json.buffers[ext.buffer] ||
      !integer(ext.byteOffset ?? 0) ||
      !integer(ext.byteLength, 1) ||
      (ext.byteOffset ?? 0) + ext.byteLength > json.buffers[ext.buffer].byteLength ||
      !integer(ext.count, 1) ||
      !integer(ext.byteStride, 1) ||
      ext.count * ext.byteStride !== view.byteLength ||
      ext.count * ext.byteStride > limits.geometryBytes ||
      !['ATTRIBUTES', 'INDICES', 'TRIANGLES'].includes(ext.mode) ||
      (ext.filter !== undefined && ext.filter !== 'NONE')
    )
      throw Error('Equipment Meshopt allocation exceeds its bounded geometry.');
    decoded += ext.count * ext.byteStride;
    if (decoded > limits.geometryBytes) throw Error('Equipment Meshopt allocations exceed8MiB.');
  }
  return sparseEntries;
}
async function bounded(path, max) {
  await localDirectory(dirname(path));
  const { handle, stat } = await safeFile(path, max);
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw Error('Equipment source changed during read.');
    return bytes;
  } finally {
    await handle.close();
  }
}
/** Validate ALL resources before NodeIO can resolve a path. Never follow a URI or symlink. */
export async function inspectEquipmentGltf(path) {
  path = resolve(path);
  const source = await bounded(path, limits.sourceFileBytes);
  let json;
  if (extname(path) === '.gltf') {
    if (source.length > 4 * 1024 ** 2) throw Error('Equipment JSON metadata exceeds 4 MiB.');
    json = JSON.parse(source.toString('utf8'));
  } else if (extname(path) === '.glb') {
    if (
      source.length < 28 ||
      source.toString('ascii', 0, 4) !== 'glTF' ||
      source.readUInt32LE(4) !== 2 ||
      source.readUInt32LE(8) !== source.length ||
      source.readUInt32LE(16) !== 0x4e4f534a ||
      source.readUInt32LE(12) > 4 * 1024 ** 2 ||
      source.readUInt32LE(12) > source.length - 28
    )
      throw Error('Invalid bounded equipment GLB.');
    json = JSON.parse(source.subarray(20, 20 + source.readUInt32LE(12)).toString('utf8'));
  } else throw Error('Equipment input must be a local S2V .gltf or .glb.');
  if (json.asset?.version !== '2.0') throw Error('Equipment requires glTF2.');
  const sparseEntries = validateEquipmentGeometryMetadata(json);
  const paths = new Set([path]);
  for (const rows of [json.buffers ?? [], json.images ?? []]) {
    if (!Array.isArray(rows) || rows.length > limits.sourceFiles)
      throw Error('Equipment resource count exceeded.');
    for (const row of rows) {
      if (row.uri === undefined) continue;
      if (typeof row.uri !== 'string' || row.uri.length > 1024)
        throw Error('Equipment sources require exact local resource paths.');
      let uri;
      try {
        uri = decodeURIComponent(row.uri);
      } catch {
        throw Error('Invalid equipment resource path.');
      }
      if (
        !uri ||
        /[\x00-\x1f\x7f\\:?#%]/.test(uri) ||
        uri.startsWith('/') ||
        uri.split('/').some((x) => !x || x === '.' || x === '..')
      )
        throw Error('Equipment sources require exact local resource paths.');
      paths.add(join(dirname(path), uri));
    }
  }
  if (paths.size > limits.sourceFiles) throw Error('Equipment resource count exceeded.');
  const resources = [],
    sizesByPath = new Map();
  let total = 0;
  for (const local of paths) {
    await localDirectory(dirname(local));
    const { handle, stat } = await safeFile(local, limits.sourceFileBytes);
    await handle.close();
    sizesByPath.set(local, stat.size);
    total += stat.size;
    if (total > limits.sourceBytes) throw Error('Equipment source resources exceed 512 MiB.');
    resources.push({
      file: local === path ? basename(local) : local.slice(dirname(path).length + 1),
      bytes: stat.size,
      sha256: await fileHash(local, 'sha256', limits.sourceFileBytes),
    });
  }
  for (const [index, definition] of json.buffers.entries()) {
    if (definition.uri !== undefined) {
      if (
        definition.byteLength >
        sizesByPath.get(join(dirname(path), decodeURIComponent(definition.uri)))
      )
        throw Error('Equipment source buffer is truncated.');
    } else if (definition.extensions?.EXT_meshopt_compression?.fallback === true) {
      if (
        definition.byteLength > limits.geometryBytes ||
        !json.extensionsRequired?.includes('EXT_meshopt_compression')
      )
        throw Error('Equipment virtual Meshopt allocation exceeds8MiB.');
    } else {
      const jsonLength = extname(path) === '.glb' ? source.readUInt32LE(12) : 0,
        header = 20 + jsonLength;
      if (
        extname(path) !== '.glb' ||
        index !== 0 ||
        header + 8 > source.length ||
        source.readUInt32LE(header + 4) !== 0x004e4942 ||
        header + 8 + source.readUInt32LE(header) !== source.length ||
        definition.byteLength > source.readUInt32LE(header)
      )
        throw Error('Equipment source requires complete exact local buffers.');
    }
  }
  // Sparse indices are payload, not just metadata. Check them monotonically in
  // <=64KiB windows before NodeIO can expand any dense accessor.
  for (const entry of sparseEntries) {
    const view = json.bufferViews[entry.bufferView],
      definition = json.buffers[view.buffer];
    let file, embedded;
    if (definition.uri === undefined) {
      const jsonLength = extname(path) === '.glb' ? source.readUInt32LE(12) : 0,
        header = 20 + jsonLength;
      if (
        extname(path) !== '.glb' ||
        view.buffer !== 0 ||
        header + 8 > source.length ||
        source.readUInt32LE(header + 4) !== 0x004e4942 ||
        header + 8 + source.readUInt32LE(header) !== source.length ||
        definition.byteLength > source.readUInt32LE(header)
      )
        throw Error('Sparse index storage requires a complete exact local buffer.');
      embedded = source.subarray(header + 8);
    } else {
      const local = join(dirname(path), decodeURIComponent(definition.uri));
      const opened = await safeFile(local, limits.sourceFileBytes);
      file = opened.handle;
      if (definition.byteLength > opened.stat.size) {
        await file.close();
        throw Error('Sparse index buffer is truncated.');
      }
    }
    let previous = -1;
    try {
      const width = entry.indexBytes,
        chunk = Buffer.alloc(Math.min(65536, entry.count * width));
      for (let at = 0; at < entry.count;) {
        const count = Math.min(chunk.length / width, entry.count - at),
          length = count * width,
          position = (view.byteOffset ?? 0) + entry.byteOffset + at * width;
        let bytes;
        if (embedded) {
          bytes = embedded.subarray(position, position + length);
          if (bytes.length !== length) throw Error('Sparse index bytes are truncated.');
        } else {
          let read = 0;
          while (read < length) {
            const result = await file.read(chunk, read, length - read, position + read);
            if (!result.bytesRead) throw Error('Sparse index bytes are truncated.');
            read += result.bytesRead;
          }
          bytes = chunk;
        }
        for (let index = 0; index < count; index++) {
          const value =
            width === 1
              ? bytes[index]
              : width === 2
                ? bytes.readUInt16LE(index * 2)
                : bytes.readUInt32LE(index * 4);
          if (value <= previous || value >= entry.maximum)
            throw Error(
              'Sparse indices must be strictly increasing within the dense accessor count.',
            );
          previous = value;
        }
        at += count;
      }
    } finally {
      await file?.close();
    }
  }
  return { path, json, resources, bytes: total, sourceSha256: hash(source) };
}
