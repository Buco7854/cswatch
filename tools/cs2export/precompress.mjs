import { brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function precompress(directory, file) {
  const raw = readFileSync(join(directory, file));
  const compressed = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
  if (compressed.length + 32 >= raw.length) return undefined;
  const disk = statfsSync(directory);
  if (disk.bavail * disk.bsize - compressed.length < 4 * 1024 ** 3)
    throw Error('Disk reserve reached');
  writeFileSync(join(directory, file + '.br'), compressed, { flag: 'wx' });
  return { size: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex') };
}
