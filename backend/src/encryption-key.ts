import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
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
import { token } from './security.js';

export class EncryptionKeyError extends Error {}
const help = 'See “Encryption key” in docs/ACCESS-SETUP.md.';
const keyPath = (db: Store) => join(db.root, 'encryption.key');

export function seal(key: Buffer, binding: string, text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
}
export function unseal(key: Buffer, binding: string, sealed: Uint8Array) {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(binding));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
}
export const steamCodeBinding = (userId: string, steamId: string) =>
  `cswatch:steam-history:1:${userId}:${steamId}`;

type Saved = { user_id: string; binding: string; sealed: Uint8Array };
/** Everything this key protects. A new kind of secret has to be listed here. */
function savedSecrets(db: Store): Saved[] {
  return db
    .all('SELECT user_id,steam_id,encrypted_code FROM steam_history')
    .map(({ user_id, steam_id, encrypted_code }) => ({
      user_id,
      binding: steamCodeBinding(user_id, steam_id),
      sealed: encrypted_code,
    }));
}
function opens(key: Buffer, { binding, sealed }: Saved) {
  try {
    unseal(key, binding, sealed);
    return true;
  } catch {
    return false;
  }
}

function readKeyFile(path: string) {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new EncryptionKeyError(`${path} cannot be read. ${help}`);
  }
  try {
    const info = fstatSync(fd);
    const bytes = Buffer.alloc(66);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const contents = bytes.toString('utf8', 0, length);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== 0o600 ||
      !/^[a-fA-F0-9]{64}\n?$/.test(contents)
    )
      throw new EncryptionKeyError(
        `${path} must be one private file (mode 0600) with 64 hexadecimal characters. ${help}`,
      );
    return Buffer.from(contents.trim(), 'hex');
  } finally {
    closeSync(fd);
  }
}
function createKeyFile(path: string) {
  const key = randomBytes(32);
  const staged = path + '.' + randomBytes(6).toString('hex');
  try {
    writeFileSync(staged, key.toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    linkSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
  return key;
}

/** The instance always has exactly one key. A key that does not match saved data never starts. */
export function openEncryptionKey(c: Config, db: Store) {
  const path = keyPath(db);
  const key = c.encryptionKey ? Buffer.from(c.encryptionKey, 'hex') : readKeyFile(path);
  const saved = savedSecrets(db);
  if (!key) {
    if (saved.length)
      throw new EncryptionKeyError(
        `Saved data is encrypted, but ${path} is missing and ENCRYPTION_KEY is not set. Restore the key. ${help}`,
      );
    return createKeyFile(path);
  }
  const unreadable = saved.filter((secret) => !opens(key, secret)).length;
  if (unreadable)
    throw new EncryptionKeyError(
      `The encryption key does not match ${unreadable} of ${saved.length} saved secrets. ` +
        `Nothing was changed. Use the key that encrypted them, or change the key. ${help}`,
    );
  return key;
}
export function openEncryptionKeyForStartup(c: Config, db: Store) {
  try {
    return openEncryptionKey(c, db);
  } catch (error) {
    if (!(error instanceof EncryptionKeyError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

/** Re-encrypts everything in one transaction, or nothing. */
export function changeEncryptionKey(c: Config, db: Store, previous?: Buffer) {
  const path = keyPath(db);
  const file = readKeyFile(path);
  const next = c.encryptionKey
    ? Buffer.from(c.encryptionKey, 'hex')
    : (file ?? createKeyFile(path));
  const known = [previous, file].filter((key): key is Buffer => Boolean(key));
  try {
    const changed = db.transaction(() => {
      let count = 0;
      for (const secret of savedSecrets(db)) {
        if (opens(next, secret)) continue;
        const old = known.find((key) => opens(key, secret));
        if (!old)
          throw new EncryptionKeyError(
            'A saved secret opens with neither the previous nor the new key. Nothing was changed.',
          );
        db.run(
          'UPDATE steam_history SET encrypted_code=?,generation=? WHERE user_id=?',
          seal(next, secret.binding, unseal(old, secret.binding, secret.sealed)),
          token(),
          secret.user_id,
        );
        count++;
      }
      return count;
    });
    if (c.encryptionKey && file) rmSync(path);
    return changed;
  } catch (error) {
    if (!c.encryptionKey && !file) rmSync(path, { force: true });
    throw error;
  }
}

/** For a lost key: members save their codes again. Readable secrets and match lists stay. */
export function forgetUnreadableSecrets(c: Config, db: Store, confirmed: boolean) {
  const key = c.encryptionKey ? Buffer.from(c.encryptionKey, 'hex') : readKeyFile(keyPath(db));
  return db.transaction(() => {
    const unreadable = savedSecrets(db).filter((secret) => !key || !opens(key, secret));
    if (confirmed)
      for (const { user_id } of unreadable)
        db.run('DELETE FROM steam_history WHERE user_id=?', user_id);
    return unreadable.length;
  });
}
