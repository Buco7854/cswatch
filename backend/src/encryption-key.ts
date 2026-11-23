import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  readdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Config } from './config.js';
import { now, type Store } from './db.js';
import { syncDirectory } from './directory-sync.js';
import { hasSecondFactor, revokeUserSessions, token } from './security.js';

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
export const totpBinding = (userId: string) => `cswatch:totp:1:${userId}`;
export const totpEnrollmentBinding = (userId: string, sessionHash: string) =>
  `cswatch:totp-enrollment:1:${userId}:${sessionHash}`;

type Saved = { userId: string; binding: string; sealed: Uint8Array } & (
  { kind: 'steam' | 'totp' } | { kind: 'totp-enrollment'; sessionHash: string }
);
/** Everything this key protects. A new kind of secret has to be listed here. */
function savedSecrets(db: Store): Saved[] {
  return [
    ...db
      .all('SELECT user_id,steam_id,encrypted_code FROM steam_history')
      .map(({ user_id, steam_id, encrypted_code }) => ({
        kind: 'steam' as const,
        userId: user_id,
        binding: steamCodeBinding(user_id, steam_id),
        sealed: encrypted_code,
      })),
    ...db
      .all('SELECT user_id,encrypted_secret FROM auth_totp')
      .map(({ user_id, encrypted_secret }) => ({
        kind: 'totp' as const,
        userId: user_id,
        binding: totpBinding(user_id),
        sealed: encrypted_secret,
      })),
    ...db
      .all(
        'SELECT user_id,session_hash,encrypted_secret FROM auth_totp_enrollments WHERE expires_at>?',
        now(),
      )
      .map(({ user_id, session_hash, encrypted_secret }) => ({
        kind: 'totp-enrollment' as const,
        userId: user_id,
        sessionHash: session_hash,
        binding: totpEnrollmentBinding(user_id, session_hash),
        sealed: encrypted_secret,
      })),
  ];
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
    let info = fstatSync(fd);
    // A crash after publishing the key can leave the creator's temporary link.
    // Discard only that private link to this same open inode.
    if (info.isFile() && (info.mode & 0o7777) === 0o600 && info.nlink === 2) {
      const prefix = basename(path) + '.';
      for (const name of readdirSync(dirname(path))) {
        if (!name.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(name.slice(prefix.length))) continue;
        const staged = join(dirname(path), name);
        const candidate = lstatSync(staged, { throwIfNoEntry: false });
        if (candidate?.dev === info.dev && candidate.ino === info.ino) {
          rmSync(staged, { force: true });
          break;
        }
      }
      info = fstatSync(fd);
    }
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
    // A concurrent publisher may have linked the key but not yet synced its directory.
    syncDirectory(dirname(path));
    return Buffer.from(contents.trim(), 'hex');
  } finally {
    closeSync(fd);
  }
}
function createKeyFile(path: string) {
  const key = randomBytes(32);
  const staged = path + '.' + randomBytes(6).toString('hex');
  try {
    writeFileSync(staged, key.toString('hex') + '\n', { flag: 'wx', mode: 0o600, flush: true });
    linkSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
  syncDirectory(dirname(path));
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
        const encrypted = seal(next, secret.binding, unseal(old, secret.binding, secret.sealed));
        if (secret.kind === 'steam')
          db.run(
            'UPDATE steam_history SET encrypted_code=?,generation=? WHERE user_id=?',
            encrypted,
            token(),
            secret.userId,
          );
        else if (secret.kind === 'totp')
          db.run(
            'UPDATE auth_totp SET encrypted_secret=? WHERE user_id=?',
            encrypted,
            secret.userId,
          );
        else if (secret.kind === 'totp-enrollment')
          db.run(
            'UPDATE auth_totp_enrollments SET encrypted_secret=? WHERE session_hash=?',
            encrypted,
            secret.sessionHash,
          );
        count++;
      }
      if (count) db.audit(null, 'encryption-key.changed', { administrative: true });
      return count;
    });
    if (c.encryptionKey && file) {
      rmSync(path);
      syncDirectory(dirname(path));
    }
    return changed;
  } catch (error) {
    if (!c.encryptionKey && !file) {
      rmSync(path, { force: true });
      syncDirectory(dirname(path));
    }
    throw error;
  }
}

/** For a lost key: unreadable secrets can be removed by the operator. */
export function forgetUnreadableSecrets(c: Config, db: Store, confirmed: boolean) {
  const key = c.encryptionKey ? Buffer.from(c.encryptionKey, 'hex') : readKeyFile(keyPath(db));
  return db.transaction(() => {
    const unreadable = savedSecrets(db).filter((secret) => !key || !opens(key, secret));
    if (!confirmed) return unreadable.length;
    for (const secret of unreadable) {
      if (secret.kind === 'steam')
        db.run('DELETE FROM steam_history WHERE user_id=?', secret.userId);
      else if (secret.kind === 'totp-enrollment')
        db.run('DELETE FROM auth_totp_enrollments WHERE session_hash=?', secret.sessionHash);
      else {
        db.run('DELETE FROM auth_totp WHERE user_id=?', secret.userId);
        db.audit(null, 'cli.unreadable_totp_removed', { target: secret.userId });
        if (!hasSecondFactor(db, secret.userId))
          db.run('DELETE FROM auth_recovery_codes WHERE user_id=?', secret.userId);
        revokeUserSessions(db, secret.userId);
      }
    }
    if (unreadable.length) db.audit(null, 'encryption-key.forgot', { administrative: true });
    return unreadable.length;
  });
}
