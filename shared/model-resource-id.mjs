// The CS2 resource string table uses MurmurHash64B, with two little-endian uint32 lanes.
// Keep the full handle as a decimal string throughout JSON and replay comparisons.
export function modelResourceId(path) {
  const bytes = new TextEncoder().encode(path);
  const view = new DataView(bytes.buffer);
  const multiplier = 0x5bd1e995;
  const mixWord = (hash, word) => {
    const scaled = Math.imul(word, multiplier);
    return Math.imul(hash, multiplier) ^ Math.imul(scaled ^ (scaled >>> 24), multiplier);
  };
  let high = 0xedabcdef ^ bytes.length;
  let low = 0;
  let at = 0;
  for (; at + 8 <= bytes.length; at += 8) {
    high = mixWord(high, view.getUint32(at, true));
    low = mixWord(low, view.getUint32(at + 4, true));
  }
  if (at + 4 <= bytes.length) {
    high = mixWord(high, view.getUint32(at, true));
    at += 4;
  }
  if (at < bytes.length) {
    let tail = 0;
    for (let i = at; i < bytes.length; i++) tail |= bytes[i] << ((i - at) * 8);
    low = Math.imul(low ^ tail, multiplier);
  }
  high = Math.imul(high ^ (low >>> 18), multiplier);
  low = Math.imul(low ^ (high >>> 22), multiplier);
  high = Math.imul(high ^ (low >>> 17), multiplier);
  low = Math.imul(low ^ (high >>> 19), multiplier);
  return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)).toString();
}
