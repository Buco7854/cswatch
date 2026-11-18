import { statfs, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { steamAssetLimits } from './steam-assets-plan.mjs';

export function assertPreparedModelStorage(byteLength, availableBytes) {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 24 ||
    byteLength > steamAssetLimits.modelBytes
  )
    throw new Error('Prepared GLB must be at least 24 bytes and no larger than 2 GiB.');
  if (
    typeof availableBytes !== 'bigint' ||
    availableBytes < BigInt(byteLength) + BigInt(steamAssetLimits.reserveBytes)
  )
    throw new Error(
      `Insufficient free disk space for the encoded GLB and 512 MiB reserve. Required ${BigInt(byteLength) + BigInt(steamAssetLimits.reserveBytes)} bytes, available ${typeof availableBytes === 'bigint' ? availableBytes : 'unknown'} bytes.`,
    );
}

/** NodeIO already encodes a complete GLB in memory. Check that exact allocation,
 * rather than estimating compressed output from source PNG sizes. */
export async function writePreparedModel(path, bytes, { storage = statfs } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Prepared GLB must be encoded bytes.');
  const disk = await storage(dirname(path), { bigint: true });
  assertPreparedModelStorage(bytes.byteLength, disk.bavail * disk.bsize);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o644 });
  return bytes.byteLength;
}
