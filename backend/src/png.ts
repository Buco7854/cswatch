import { crc32 } from 'node:zlib';

type PngLimits = { bytes: number; dimension: number; pixels: number; square?: boolean };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Bounded raster structure and CRC validation, not an SVG assertion or full decoder. */
export function validPng(data: Buffer, limits: PngLimits): boolean {
  if (data.length < 57 || data.length > limits.bytes || !data.subarray(0, 8).equals(signature))
    return false;
  let offset = 8,
    chunks = 0,
    idat = false;
  while (offset + 12 <= data.length && ++chunks <= 1024) {
    const size = data.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > data.length) return false;
    const kind = data.toString('latin1', offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(kind) ||
      crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)
    )
      return false;
    if (chunks === 1) {
      if (kind !== 'IHDR' || size !== 13) return false;
      const width = data.readUInt32BE(offset + 8),
        height = data.readUInt32BE(offset + 12);
      if (
        !width ||
        !height ||
        width > limits.dimension ||
        height > limits.dimension ||
        width * height > limits.pixels ||
        (limits.square && width !== height)
      )
        return false;
      const depth = data[offset + 16],
        color = data[offset + 17];
      if (
        !(
          { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<
            number,
            number[]
          >
        )[color]?.includes(depth) ||
        data[offset + 18] !== 0 ||
        data[offset + 19] !== 0 ||
        data[offset + 20] > 1
      )
        return false;
    } else if (kind === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(kind)) return false;
    else if (!['PLTE', 'IDAT', 'IEND'].includes(kind) && kind[0] === kind[0].toUpperCase())
      return false;
    if (kind === 'IDAT' && size) idat = true;
    if (kind === 'IEND') return size === 0 && idat && end === data.length;
    offset = end;
  }
  return false;
}
