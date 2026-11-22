// The CS2 match container uses 25 little-endian base-57 digits. The decoded
// 18 bytes contain two little-endian uint64s followed by a uint16.
const alphabet = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
const format = new RegExp(`^CSGO(?:-[${alphabet}]{5}){5}$`);

export function decodeSteamShareCode(code: string) {
  if (code.length !== 34 || !format.test(code)) return null;
  let value = 0n;
  for (const digit of [...code.slice(5).replaceAll('-', '')].reverse())
    value = value * BigInt(alphabet.length) + BigInt(alphabet.indexOf(digit));
  if (value >= 1n << 144n) return null;
  const bytes = Buffer.from(value.toString(16).padStart(36, '0'), 'hex');
  const matchId = bytes.readBigUInt64LE(0);
  if (matchId === 0n) return null;
  return {
    match_id: matchId.toString(),
    outcome_id: bytes.readBigUInt64LE(8).toString(),
    token: bytes.readUInt16LE(16),
  };
}
