import { closeSync, openSync, readSync } from 'node:fs';
import { HttpError } from './errors.js';

/** Header checks do not import authentication, database, or native parser code. */
export function validateMagic(path: string, ext: string) {
  const fd = openSync(path, 'r'),
    magic = Buffer.alloc(8);
  try {
    readSync(fd, magic);
  } finally {
    closeSync(fd);
  }
  if (ext === '.dem' && !magic.equals(Buffer.from('PBDEMS2\0')))
    throw new HttpError(400, 'This is not a CS2 demo. CS:GO demos are not supported.');
  if (ext === '.zst' && !magic.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])))
    throw new HttpError(400, 'This is not a Zstandard-compressed demo.');
  if (
    ext === '.bz2' &&
    !(magic.subarray(0, 3).equals(Buffer.from('BZh')) && magic[3] >= 0x31 && magic[3] <= 0x39)
  )
    throw new HttpError(400, 'Invalid compressed demo.');
  if (ext === '.gz' && !(magic[0] === 0x1f && magic[1] === 0x8b))
    throw new HttpError(400, 'Invalid compressed demo.');
}
