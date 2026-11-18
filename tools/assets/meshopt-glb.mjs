/** Lossless EXT_meshopt_compression transport. No filters, quantization or index rotation. */
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
const extension = 'EXT_meshopt_compression';
const limit = 2 * 1024 ** 3;
const aligned = (value) => value + 3 - ((value + 3) % 4);
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
    binStart + source.readUInt32LE(20 + jsonLength) !== source.length ||
    document.buffers?.length !== 1 ||
    document.buffers[0].uri !== undefined ||
    document.buffers[0].byteLength > source.length - binStart
  )
    throw new Error('Geometry compression requires one self-contained uncompressed buffer.');
  if (document.extensionsRequired?.includes(extension))
    throw new Error('Geometry is already Meshopt compressed.');
  const bin = source.subarray(binStart),
    views = document.bufferViews ?? [],
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
      if (!Buffer.from(restored).equals(payload))
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
      bytes: source,
      report: {
        extension,
        lossless: true,
        filters: 'NONE',
        compressedViews: 0,
        decodedBytes: 0,
        compressedBytes: 0,
        encodedBytesBefore: source.length,
        encodedBytesAfter: source.length,
      },
    };
  const encodedBin = Buffer.concat(chunks, physical);
  document.bufferViews = outputViews;
  document.buffers = [
    { ...document.buffers[0], byteLength: encodedBin.length },
    { byteLength: virtual, extensions: { [extension]: { fallback: true } } },
  ];
  document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), extension])];
  document.extensionsRequired = [...new Set([...(document.extensionsRequired ?? []), extension])];
  const json = Buffer.from(JSON.stringify(document)),
    jsonPadding = aligned(json.length) - json.length,
    encodedJson = Buffer.concat([json, Buffer.alloc(jsonPadding, 32)]),
    header = Buffer.alloc(20),
    binaryHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + encodedJson.length + encodedBin.length, 8);
  header.writeUInt32LE(encodedJson.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binaryHeader.writeUInt32LE(encodedBin.length);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  const result = Buffer.concat([header, encodedJson, binaryHeader, encodedBin]);
  if (result.length > limit) throw new Error('Encoded Meshopt model exceeds 2 GiB.');
  return {
    bytes: result,
    report: {
      extension,
      lossless: true,
      filters: 'NONE',
      compressedViews,
      decodedBytes,
      compressedBytes,
      encodedBytesBefore: source.length,
      encodedBytesAfter: result.length,
    },
  };
}

export { MeshoptDecoder };
