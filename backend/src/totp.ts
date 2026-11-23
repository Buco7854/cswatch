import { createHmac, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const period = 30;

export function base32(bytes: Uint8Array) {
  let encoded = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) encoded += alphabet[(value << (5 - bits)) & 31];
  return encoded;
}

function otp(secret: Uint8Array, step: number) {
  const movingFactor = Buffer.alloc(8);
  movingFactor.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', secret).update(movingFactor).digest();
  const offset = hash[hash.length - 1] & 15;
  const binary = hash.readUInt32BE(offset) & 0x7fffffff;
  return Buffer.from(String(binary % 1_000_000).padStart(6, '0'));
}

/** RFC 6238, tested across all three steps even when a code matches early. */
export function acceptedTotpStep(secret: Uint8Array, code: string, unixTime: number, last: number) {
  const provided = Buffer.from(code);
  if (provided.length !== 6) return null;
  const current = Math.floor(unixTime / period);
  let matched = null;
  for (const step of [current - 1, current, current + 1]) {
    const equal = timingSafeEqual(provided, otp(secret, Math.max(0, step)));
    if (equal && step >= 0 && step > last) matched = step;
  }
  return matched;
}
