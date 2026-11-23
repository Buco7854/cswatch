/** Lossless EXT_meshopt_compression transport. No filters, quantization or index rotation. */
import { Format, GLB_BUFFER } from '@gltf-transform/core';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
const extension = 'EXT_meshopt_compression';
const limit = 2 * 1024 ** 3;
const aligned = (value) => value + 3 - ((value + 3) % 4);

function serializeGlb(json, binary, bytes) {
  const jsonSize = aligned(json.length),
    binSize = aligned(bytes),
    outputSize = 28 + jsonSize + binSize;
  if (json.length > 64 * 1024 ** 2 || outputSize > limit)
    throw new Error('Encoded Meshopt model exceeds its GLB bounds.');
  const header = Buffer.alloc(20),
    binaryHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(outputSize, 8);
  header.writeUInt32LE(jsonSize, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binaryHeader.writeUInt32LE(binSize, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat(
    [
      header,
      json,
      Buffer.alloc(jsonSize - json.length, 32),
      binaryHeader,
      ...binary,
      Buffer.alloc(binSize - bytes),
    ],
    outputSize,
  );
}

/** Use the writer's binary resource directly, avoiding a full uncompressed GLB copy. */
export async function compressMapDocumentGeometry(io, sourceDocument) {
  const { json, resources } = await io.writeJSON(sourceDocument, { format: Format.GLB });
  const binary = resources[GLB_BUFFER];
  if (!(binary instanceof Uint8Array) || !binary.length || Object.keys(resources).length !== 1)
    throw new Error('Geometry compression requires one self-contained uncompressed buffer.');
  const bin = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const metadata = Buffer.from(JSON.stringify(json));
  const length = 28 + aligned(metadata.length) + aligned(bin.length);
  if (metadata.length > 64 * 1024 ** 2 || length > limit)
    throw new Error('Expected bounded prepared GLB bytes.');
  return compressGeometry(json, bin, length, () => serializeGlb(metadata, [bin], bin.length));
}

export async function compressGlbGeometry(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 48 || bytes.byteLength > limit)
    throw new Error('Expected bounded prepared GLB bytes.');
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = source.readUInt32LE(12);
  if (
    source.toString('ascii', 0, 4) !== 'glTF' ||
    source.readUInt32LE(4) !== 2 ||
    source.readUInt32LE(8) !== source.length ||
    source.readUInt32LE(16) !== 0x4e4f534a ||
    jsonLength > 64 * 1024 ** 2 ||
    jsonLength % 4 ||
    jsonLength > source.length - 28
  )
    throw new Error('Invalid geometry-compression GLB header.');
  const document = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8')),
    binStart = 28 + jsonLength;
  if (
    source.readUInt32LE(24 + jsonLength) !== 0x004e4942 ||
    binStart + source.readUInt32LE(20 + jsonLength) !== source.length
  )
    throw new Error('Geometry compression requires one self-contained uncompressed buffer.');
  return compressGeometry(document, source.subarray(binStart), source.length, () => source);
}

async function compressGeometry(document, bin, sourceLength, uncompressed) {
  if (
    document.buffers?.length !== 1 ||
    document.buffers[0].uri !== undefined ||
    document.buffers[0].byteLength > bin.length
  )
    throw new Error('Geometry compression requires one self-contained uncompressed buffer.');
  if (document.extensionsRequired?.includes(extension))
    throw new Error('Geometry is already Meshopt compressed.');
  const views = document.bufferViews ?? [],
    accessors = document.accessors ?? [];
  if (
    !Array.isArray(views) ||
    views.length > 200000 ||
    !Array.isArray(accessors) ||
    accessors.length > 200000
  )
    throw new Error('Geometry metadata count exceeds its bound.');
  const references = new Map();
  for (const accessor of accessors)
    if (Number.isInteger(accessor.bufferView)) {
      const list = references.get(accessor.bufferView) ?? [];
      list.push(accessor);
      references.set(accessor.bufferView, list);
    }
  const images = new Set((document.images ?? []).map((image) => image.bufferView));
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const chunks = [],
    outputViews = [];
  let physical = 0,
    virtual = 0,
    compressedViews = 0,
    decodedBytes = 0,
    compressedBytes = 0;
  function append(payload) {
    const offset = physical,
      padding = aligned(payload.length) - payload.length;
    chunks.push(payload);
    if (padding) chunks.push(Buffer.alloc(padding));
    physical += payload.length + padding;
    return offset;
  }
  for (const [index, view] of views.entries()) {
    const offset = view.byteOffset ?? 0;
    if (
      view.buffer !== 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(view.byteLength) ||
      view.byteLength < 1 ||
      offset + view.byteLength > document.buffers[0].byteLength ||
      view.extensions?.[extension]
    )
      throw new Error('Geometry view escapes the source buffer.');
    const payload = bin.subarray(offset, offset + view.byteLength),
      refs = references.get(index) ?? [];
    let mode = 'ATTRIBUTES',
      stride = view.byteStride ?? 4;
    if (view.target === 34963) {
      const component = refs[0]?.componentType;
      stride = component === 5123 ? 2 : component === 5125 ? 4 : 0;
      mode = 'INDICES';
      if (
        refs.some((accessor) => accessor.type !== 'SCALAR' || accessor.componentType !== component)
      )
        stride = 0;
    }
    const eligible =
      refs.length &&
      !images.has(index) &&
      stride > 0 &&
      payload.length % stride === 0 &&
      (mode === 'INDICES' || (stride >= 4 && stride <= 256 && stride % 4 === 0));
    let compressed;
    if (eligible) {
      const count = payload.length / stride;
      compressed = MeshoptEncoder.encodeGltfBuffer(payload, count, stride, mode);
      const restored = new Uint8Array(payload.length);
      MeshoptDecoder.decodeGltfBuffer(restored, count, stride, compressed, mode, 'NONE');
      if (!Buffer.from(restored.buffer, restored.byteOffset, restored.byteLength).equals(payload))
        throw new Error('Meshopt failed exact byte-preserving geometry verification.');
      if (compressed.length >= payload.length) compressed = undefined;
    }
    if (compressed) {
      const encodedOffset = append(compressed),
        fallbackOffset = virtual;
      virtual += aligned(payload.length);
      decodedBytes += payload.length;
      compressedBytes += compressed.length;
      compressedViews++;
      if (virtual > limit) throw new Error('Decoded geometry exceeds the 2 GiB bound.');
      outputViews.push({
        ...view,
        buffer: 1,
        byteOffset: fallbackOffset,
        extensions: {
          ...view.extensions,
          [extension]: {
            buffer: 0,
            byteOffset: encodedOffset,
            byteLength: compressed.length,
            byteStride: stride,
            count: payload.length / stride,
            mode,
          },
        },
      });
    } else outputViews.push({ ...view, byteOffset: append(payload) });
  }
  if (!compressedViews)
    return {
      bytes: uncompressed(),
      report: {
        extension,
        lossless: true,
        filters: 'NONE',
        compressedViews: 0,
        decodedBytes: 0,
        compressedBytes: 0,
        encodedBytesBefore: sourceLength,
        encodedBytesAfter: sourceLength,
      },
    };
  document.bufferViews = outputViews;
  document.buffers = [
    { ...document.buffers[0], byteLength: physical },
    { byteLength: virtual, extensions: { [extension]: { fallback: true } } },
  ];
  document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), extension])];
  document.extensionsRequired = [...new Set([...(document.extensionsRequired ?? []), extension])];
  const result = serializeGlb(Buffer.from(JSON.stringify(document)), chunks, physical);
  return {
    bytes: result,
    report: {
      extension,
      lossless: true,
      filters: 'NONE',
      compressedViews,
      decodedBytes,
      compressedBytes,
      encodedBytesBefore: sourceLength,
      encodedBytesAfter: result.length,
    },
  };
}

export { MeshoptDecoder };
