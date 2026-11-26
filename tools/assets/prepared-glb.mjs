/** Bounded self-contained GLB verification without loading its binary payload. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { steamAssetLimits } from './steam-assets-plan.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';

const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const identity = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const meshopt = 'EXT_meshopt_compression';
const exact = (object, keys) =>
  object &&
  typeof object === 'object' &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...keys].sort().join(',');
function validateBuffers(data, binaryBytes, geometryBytes) {
  const buffers = data.buffers,
    views = data.bufferViews;
  const required =
    Array.isArray(data.extensionsRequired) && data.extensionsRequired.includes(meshopt);
  if (
    !Array.isArray(buffers) ||
    ![1, 2].includes(buffers.length) ||
    buffers.some((buffer) => buffer?.uri !== undefined) ||
    buffers[0]?.extensions?.[meshopt] !== undefined ||
    !integer(buffers[0]?.byteLength, 1) ||
    buffers[0].byteLength > binaryBytes ||
    binaryBytes - buffers[0].byteLength > 3 ||
    !Array.isArray(views) ||
    !views.length ||
    views.length > 200000
  )
    throw new Error('Prepared map must contain self-contained buffers/textures.');
  if (
    buffers.length === 2 &&
    (!required ||
      !data.extensionsUsed?.includes(meshopt) ||
      !integer(buffers[1]?.byteLength, 1) ||
      buffers[1].byteLength > geometryBytes ||
      !exact(buffers[1].extensions, [meshopt]) ||
      !exact(buffers[1].extensions[meshopt], ['fallback']) ||
      buffers[1].extensions[meshopt].fallback !== true)
  )
    throw new Error('Invalid required Meshopt virtual fallback buffer.');
  const compressed = [];
  let decoded = 0;
  for (const view of views) {
    const offset = view?.byteOffset ?? 0,
      extension = view?.extensions?.[meshopt];
    if (
      !integer(offset) ||
      !integer(view?.byteLength, 1) ||
      (view.byteStride !== undefined &&
        (!integer(view.byteStride, 4) || view.byteStride > 252 || view.byteStride % 4))
    )
      throw new Error('Prepared GLB buffer view escapes its embedded binary chunk.');
    if (extension !== undefined) {
      if (!extension || typeof extension !== 'object' || Array.isArray(extension))
        throw new Error('Invalid Meshopt view descriptor.');
      const fields = [
        'buffer',
        'byteOffset',
        'byteLength',
        'byteStride',
        'count',
        'mode',
        ...(Object.hasOwn(extension, 'filter') ? ['filter'] : []),
      ];
      if (
        !required ||
        buffers.length !== 2 ||
        view.buffer !== 1 ||
        offset + view.byteLength > buffers[1].byteLength ||
        !exact(extension, fields) ||
        extension.buffer !== 0 ||
        !integer(extension.byteOffset) ||
        extension.byteOffset % 4 ||
        !integer(extension.byteLength, 1) ||
        extension.byteOffset + extension.byteLength > buffers[0].byteLength ||
        !integer(extension.count, 1) ||
        !integer(extension.byteStride, 1) ||
        extension.count * extension.byteStride !== view.byteLength ||
        !['ATTRIBUTES', 'INDICES', 'TRIANGLES'].includes(extension.mode) ||
        (extension.filter !== undefined && extension.filter !== 'NONE')
      )
        throw new Error('Invalid bounded Meshopt compressed view.');
      if (
        extension.mode === 'ATTRIBUTES'
          ? extension.byteStride < 4 ||
            extension.byteStride > 256 ||
            extension.byteStride % 4 ||
            (view.byteStride !== undefined && view.byteStride !== extension.byteStride)
          : ![2, 4].includes(extension.byteStride) ||
            (extension.mode === 'TRIANGLES' && extension.count % 3) ||
            view.byteStride !== undefined
      )
        throw new Error('Invalid Meshopt mode, count or stride.');
      decoded += view.byteLength;
      if (decoded > geometryBytes) throw new Error('Decoded Meshopt geometry exceeds its budget.');
      compressed.push(extension);
    } else if (view.buffer !== 0 || offset + view.byteLength > buffers[0].byteLength)
      throw new Error('Prepared GLB buffer view escapes its embedded binary chunk.');
  }
  if ((buffers.length === 2 || required) && !compressed.length)
    throw new Error('Virtual fallback has no required Meshopt views.');
  const accessors = data.accessors ?? [];
  if (!Array.isArray(accessors) || accessors.length > 200000)
    throw new Error('Too many prepared accessors.');
  const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 },
    components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const used = new Set();
  let zeroBytes = 0;
  for (const accessor of accessors) {
    const component = sizes[accessor.componentType],
      parts = components[accessor.type],
      offset = accessor.byteOffset ?? 0;
    const matrix = accessor.type?.startsWith('MAT') ? Number(accessor.type.slice(3)) : 0;
    const element = matrix ? Math.ceil((matrix * component) / 4) * 4 * matrix : parts * component;
    if (
      !component ||
      !parts ||
      !integer(accessor.count, 1) ||
      accessor.count * element > geometryBytes ||
      !integer(offset) ||
      offset % component
    )
      throw new Error('Invalid bounded prepared accessor.');
    if (accessor.bufferView !== undefined) {
      const view = views[accessor.bufferView],
        stride = view?.byteStride ?? element;
      if (
        !integer(accessor.bufferView) ||
        !view ||
        stride < element ||
        offset + (accessor.count - 1) * stride + element > view.byteLength
      )
        throw new Error('Prepared accessor escapes its decoded view.');
      used.add(accessor.bufferView);
    } else zeroBytes += accessor.count * element;
    if (accessor.sparse !== undefined)
      throw new Error('Sparse prepared map accessors are unsupported.');
  }
  if ([...used].reduce((sum, index) => sum + views[index].byteLength, zeroBytes) > geometryBytes)
    throw new Error('Decoded prepared geometry exceeds its budget.');
  return compressed;
}
async function readFully(file, length, position) {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(result, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('Incomplete prepared GLB metadata.');
    offset += bytesRead;
  }
  return result;
}

/** `animationOnly` accepts a skeleton-and-curves bank, which has no meshes. */
export async function verifyPreparedGlb(path, { animationOnly = false } = {}) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size < 48n ||
      info.size > BigInt(steamAssetLimits.modelBytes)
    )
      throw new Error('Expected a bounded regular prepared GLB no larger than 2 GiB.');
    const size = Number(info.size);
    const header = await readFully(file, 20, 0);
    const jsonBytes = header.readUInt32LE(12);
    if (
      header.toString('ascii', 0, 4) !== 'glTF' ||
      header.readUInt32LE(4) !== 2 ||
      header.readUInt32LE(8) !== size ||
      header.readUInt32LE(16) !== 0x4e4f534a ||
      !jsonBytes ||
      jsonBytes > 64 * 1024 ** 2 ||
      jsonBytes % 4 ||
      jsonBytes > size - 28
    )
      throw new Error('Invalid prepared map GLB.');
    const data = JSON.parse((await readFully(file, jsonBytes, 20)).toString('utf8'));
    const binaryHeader = await readFully(file, 8, 20 + jsonBytes);
    const binaryBytes = binaryHeader.readUInt32LE(0);
    if (
      binaryHeader.readUInt32LE(4) !== 0x004e4942 ||
      !binaryBytes ||
      binaryBytes % 4 ||
      28 + jsonBytes + binaryBytes !== size
    )
      throw new Error('Prepared GLB requires one complete embedded binary chunk.');
    if (
      data.asset?.version !== '2.0' ||
      ![data.scenes, data.nodes, animationOnly ? data.animations : data.meshes].every(
        (items) => Array.isArray(items) && items.length > 0 && items.length <= 200000,
      ) ||
      (animationOnly && data.meshes !== undefined) ||
      !Array.isArray(data.bufferViews)
    )
      throw new Error(
        'Prepared map must contain real scene meshes and self-contained buffers/textures.',
      );
    const compressed = validateBuffers(data, binaryBytes, steamAssetLimits.modelBytes);
    const images = data.images ?? [];
    if (
      !Array.isArray(images) ||
      images.length > 20000 ||
      images.some(
        (image) =>
          image?.uri !== undefined ||
          !integer(image?.bufferView) ||
          image.bufferView >= data.bufferViews.length ||
          data.bufferViews[image.bufferView].buffer !== 0 ||
          data.bufferViews[image.bufferView].extensions?.[meshopt] !== undefined ||
          !['image/png', 'image/jpeg', 'image/webp', 'image/ktx2', 'image/avif'].includes(
            image.mimeType,
          ),
      )
    )
      throw new Error('Prepared GLB textures must reference bounded embedded image views.');
    if (compressed.length) {
      await MeshoptDecoder.ready;
      for (const view of compressed) {
        const source = await readFully(file, view.byteLength, 28 + jsonBytes + view.byteOffset);
        const decoded = new Uint8Array(view.count * view.byteStride);
        try {
          MeshoptDecoder.decodeGltfBuffer(
            decoded,
            view.count,
            view.byteStride,
            source,
            view.mode,
            view.filter ?? 'NONE',
          );
        } catch {
          throw new Error('Prepared Meshopt payload failed local decoding.');
        }
      }
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(512 * 1024);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (!bytesRead) throw new Error('Incomplete prepared GLB payload.');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (identity(info) !== identity(await file.stat({ bigint: true })))
      throw new Error('Prepared GLB changed during verification.');
    return { bytes: size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}
