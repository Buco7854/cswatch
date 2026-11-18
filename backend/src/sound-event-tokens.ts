/** Native sound-event MurmurHash2 and bounded packed public.position evidence.
 * Event-name seed is confirmed against 92 exact native bank names in recorded CS2 messages.
 * Generic parameter tokens use the distinct Source StringToken seed 0x31415926. */
export function soundTokenHash(value: string, seed = 0x53524332) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value))
    throw Error('Invalid fixed sound token');
  const bytes = Buffer.from(
    value.replace(/[A-Z]/g, (c) => c.toLowerCase()),
    'utf8',
  );
  let hash = (seed ^ bytes.length) >>> 0,
    offset = 0;
  for (; offset + 4 <= bytes.length; offset += 4) {
    let block = bytes.readUInt32LE(offset);
    block = Math.imul(block, 0x5bd1e995);
    block ^= block >>> 24;
    hash = (Math.imul(hash, 0x5bd1e995) ^ Math.imul(block, 0x5bd1e995)) >>> 0;
  }
  if (bytes.length - offset === 3) hash ^= bytes[offset + 2] << 16;
  if (bytes.length - offset >= 2) hash ^= bytes[offset + 1] << 8;
  if (bytes.length - offset >= 1) hash = Math.imul(hash ^ bytes[offset], 0x5bd1e995);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);
  hash ^= hash >>> 15;
  return hash >>> 0;
}
export function packedSoundPosition(bytes: unknown): {
  valid: boolean;
  position?: { x: number; y: number; z: number };
} {
  if (!(bytes instanceof Uint8Array) || bytes.length > 256) return { valid: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0,
    position;
  while (offset < bytes.length) {
    if (offset + 7 > bytes.length) return { valid: false };
    const hash = view.getUint32(offset, true),
      type = view.getUint8(offset + 4),
      size = view.getUint16(offset + 5, true);
    offset += 7;
    if (size > bytes.length - offset) return { valid: false };
    if (hash === 1518128717) {
      if (position || type !== 10 || size !== 12) return { valid: false };
      const [x, y, z] = [0, 4, 8].map((at) => view.getFloat32(offset + at, true));
      if (![x, y, z].every((v) => Number.isFinite(v) && Math.abs(v) <= 1e7))
        return { valid: false };
      position = { x, y, z };
    }
    offset += size;
  }
  return { valid: true, ...(position ? { position } : {}) };
}
