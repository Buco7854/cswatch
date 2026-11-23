import { createHmac } from 'node:crypto';

export function codeFor(secret: string, step: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const clock = Buffer.alloc(8);
  clock.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', key).update(clock).digest();
  return String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
