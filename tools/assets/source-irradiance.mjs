import { inflateSync } from 'node:zlib';
import { regularFile } from './toolchain-security.mjs';

const maxBytes = 512 * 1024 ** 2;
const rowsPerBlock = 16;

async function readExactly(file, buffer, offset) {
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await file.read(buffer, read, buffer.length - read, offset + read);
    if (!bytesRead) throw Error('Incomplete Source irradiance EXR.');
    read += bytesRead;
  }
  return buffer;
}

function readHeader(buffer) {
  if (buffer.readUInt32LE(0) !== 20000630 || buffer.readUInt32LE(4) !== 2)
    throw Error('Expected a scanline Source irradiance EXR.');
  let offset = 8;
  function name() {
    const end = buffer.indexOf(0, offset);
    if (end < offset || end - offset > 64) throw Error('Invalid EXR attribute name.');
    const result = buffer.toString('ascii', offset, end);
    offset = end + 1;
    return result;
  }
  const fields = new Map();
  for (let field = name(); field; field = name()) {
    const type = name();
    if (fields.size >= 32 || fields.has(field) || offset + 4 > buffer.length)
      throw Error('Invalid EXR attribute list.');
    const bytes = buffer.readUInt32LE(offset);
    offset += 4;
    if (bytes > 256 || offset + bytes >= buffer.length)
      throw Error('EXR attribute exceeds its limit.');
    fields.set(field, { type, data: buffer.subarray(offset, offset + bytes) });
    offset += bytes;
  }
  function required(field, type, bytes) {
    const entry = fields.get(field);
    if (entry?.type !== type || entry.data.length !== bytes)
      throw Error('Unsupported Source irradiance EXR header.');
    return entry.data;
  }
  const bounds = required('dataWindow', 'box2i', 16),
    width = bounds.readInt32LE(8) + 1,
    height = bounds.readInt32LE(12) + 1;
  if (
    bounds.readInt32LE(0) !== 0 ||
    bounds.readInt32LE(4) !== 0 ||
    ![1024, 2048, 4096, 8192].includes(width) ||
    height !== width ||
    required('compression', 'compression', 1)[0] !== 3 ||
    required('lineOrder', 'lineOrder', 1)[0] !== 0
  )
    throw Error('Unsupported Source irradiance EXR dimensions or compression.');
  const channels = required('channels', 'chlist', 73);
  const order = 'ABGR';
  for (let index = 0; index < order.length; index++) {
    const at = index * 18;
    if (
      channels[at] !== order.charCodeAt(index) ||
      channels[at + 1] !== 0 ||
      channels.readUInt32LE(at + 2) !== 2 ||
      channels.readUInt32LE(at + 10) !== 1 ||
      channels.readUInt32LE(at + 14) !== 1 ||
      channels[72] !== 0
    )
      throw Error('Unsupported Source irradiance EXR channels.');
  }
  return { offset, width, height };
}

function decodeZipBlock(compressed, raw) {
  const predicted = inflateSync(compressed, { maxOutputLength: raw.length });
  if (predicted.length !== raw.length) throw Error('Source irradiance scanline length mismatch.');
  for (let index = 1; index < predicted.length; index++)
    predicted[index] = predicted[index] + predicted[index - 1] - 128;
  const half = raw.length / 2;
  for (let index = 0; index < half; index++) {
    raw[index * 2] = predicted[index];
    raw[index * 2 + 1] = predicted[half + index];
  }
  return raw;
}

/** Read only the bounded ZIP16, float ABGR, square scanline form emitted by S2V for this atlas.
 * Center-point reduction keeps texels within their source charts before browser interpolation. */
export async function sampleSourceIrradiance(path, edge) {
  if (![1024, 2048].includes(edge)) throw Error('Unsupported prepared irradiance dimensions.');
  const { handle, stat } = await regularFile(path, maxBytes);
  try {
    const { width, height, offset } = readHeader(await readExactly(handle, Buffer.alloc(8192), 0));
    if (edge > width) throw Error('Prepared irradiance cannot oversample the source.');
    const blocks = height / rowsPerBlock;
    const table = await readExactly(handle, Buffer.alloc(blocks * 8), offset);
    const rawBytes = width * rowsPerBlock * 16;
    const raw = Buffer.alloc(rawBytes);
    const output = new Float32Array(edge * edge * 3);
    const step = width / edge;
    const middle = Math.floor(step / 2);
    let position = offset + table.length;
    for (let block = 0; block < blocks; block++) {
      if (table.readBigUInt64LE(block * 8) !== BigInt(position) || position + 8 > stat.size)
        throw Error('Unexpected Source irradiance block offset.');
      const prefix = await readExactly(handle, Buffer.alloc(8), position);
      const row = prefix.readInt32LE(0),
        bytes = prefix.readUInt32LE(4);
      position += 8;
      if (
        row !== block * rowsPerBlock ||
        bytes < 1 ||
        bytes > rawBytes ||
        position + bytes > stat.size
      )
        throw Error('Unexpected Source irradiance scanline range.');
      const source = await readExactly(handle, Buffer.alloc(bytes), position);
      const scanlines = bytes === rawBytes ? source : decodeZipBlock(source, raw);
      position += bytes;
      for (let y = middle; y < rowsPerBlock; y += step)
        for (let x = middle; x < width; x += step) {
          const from = (y * width * 4 + x) * 4;
          const into = (Math.floor((row + y) / step) * edge + Math.floor(x / step)) * 3;
          for (let channel = 0; channel < 3; channel++) {
            const irradiance = scanlines.readFloatLE(from + (3 - channel) * width * 4);
            if (!Number.isFinite(irradiance) || irradiance < 0 || irradiance > 65504)
              throw Error('Invalid Source irradiance sample.');
            output[into + channel] = irradiance;
          }
        }
    }
    if (position !== stat.size) throw Error('Unexpected Source irradiance EXR trailing data.');
    return output;
  } finally {
    await handle.close();
  }
}
