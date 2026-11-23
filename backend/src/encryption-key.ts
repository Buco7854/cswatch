import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { HttpError } from './errors.js';

/** Encrypts saved credentials. Without ENCRYPTION_KEY, one private file beside the database protects copied databases. */
export function encryptionKey(c: Config, db: Store) {
  if (c.encryptionKey) return Buffer.from(c.encryptionKey, 'hex');
  const path = join(db.root, 'encryption.key');
  try {
    if (!existsSync(path)) {
      const staged = path + '.' + randomBytes(6).toString('hex');
      try {
        writeFileSync(staged, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
        linkSync(staged, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        rmSync(staged, { force: true });
      }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 65)
        throw new Error();
      const bytes = Buffer.alloc(66);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      const contents = bytes.toString('utf8', 0, length);
      if (!/^[a-fA-F0-9]{64}\n?$/.test(contents)) throw new Error();
      return Buffer.from(contents.trim(), 'hex');
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new HttpError(503, 'This instance cannot protect saved codes right now.');
  }
}
