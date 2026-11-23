import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { now, Store } from '../src/db.js';
import {
  changeEncryptionKey,
  EncryptionKeyError,
  forgetUnreadableSecrets,
  openEncryptionKey,
  seal,
  steamCodeBinding,
  unseal,
} from '../src/encryption-key.js';
import { createApp } from '../src/server.js';

const first = 'ab'.repeat(32);
const second = 'cd'.repeat(32);
const code = 'ABCD-EFGHI-JKLM';
async function instance(run: (context: ReturnType<typeof context>) => Promise<void> | void) {
  const value = context();
  try {
    await run(value);
  } finally {
    value.db.close();
    rmSync(value.root, { recursive: true, force: true });
  }
}
function context() {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-key-'));
  const db = new Store(root);
  const config = (ENCRYPTION_KEY = '') =>
    loadConfig({
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      DATA_DIR: root,
      LOG_LEVEL: 'silent',
      ENCRYPTION_KEY,
    });
  return {
    root,
    db,
    config,
    path: join(root, 'encryption.key'),
    save(key: Buffer, user: string) {
      db.run('INSERT INTO users VALUES(?,?,?,?,?)', user, user, null, 0, now());
      db.run(
        'INSERT INTO steam_history(user_id,steam_id,encrypted_code,cursor,generation) VALUES(?,?,?,?,?)',
        user,
        '76561198000000001',
        seal(key, steamCodeBinding(user, '76561198000000001'), code),
        'cursor',
        'before',
      );
    },
    rows: () => db.all('SELECT * FROM steam_history ORDER BY user_id'),
    read(key: Buffer, user: string) {
      const row = db.one('SELECT * FROM steam_history WHERE user_id=?', user)!;
      return unseal(key, steamCodeBinding(user, row.steam_id), row.encrypted_code);
    },
  };
}

test('an instance creates one private key and keeps using it', () =>
  instance(({ root, db, config, path }) => {
    const key = openEncryptionKey(config(), db);
    assert.equal(readFileSync(path, 'utf8'), key.toString('hex') + '\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(openEncryptionKey(config(), db), key);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith('encryption')),
      ['encryption.key'],
    );
  }));

test('ENCRYPTION_KEY supplies the key without creating a file and rejects other values', () =>
  instance(({ db, config, path }) => {
    assert.equal(openEncryptionKey(config(first), db).toString('hex'), first);
    assert.equal(existsSync(path), false);
    for (const invalid of ['short', 'zz'.repeat(32), first + '00'])
      assert.throws(() => config(invalid));
  }));

test('a key that does not match saved data stops the instance before anything changes', () =>
  instance(async ({ db, config, path, save, rows }) => {
    const key = openEncryptionKey(config(), db);
    save(key, 'a');
    save(key, 'b');
    const before = [JSON.stringify(rows()), readFileSync(path, 'utf8')];
    await assert.rejects(createApp(config(first), db), EncryptionKeyError);
    assert.throws(
      () => openEncryptionKey(config(first), db),
      /does not match 2 of 2 saved secrets/,
    );
    assert.deepEqual([JSON.stringify(rows()), readFileSync(path, 'utf8')], before);

    rmSync(path);
    assert.throws(() => openEncryptionKey(config(), db), /is missing/);
    assert.equal(existsSync(path), false, 'A second key is never created beside saved data.');
    assert.equal(
      openEncryptionKey(config(key.toString('hex')), db).toString('hex'),
      key.toString('hex'),
    );
  }));

test('one secret under another key is enough to stop', () =>
  instance(({ db, config, save }) => {
    save(openEncryptionKey(config(), db), 'a');
    save(Buffer.from(first, 'hex'), 'b');
    assert.throws(() => openEncryptionKey(config(), db), /does not match 1 of 2 saved secrets/);
  }));

test('an unsafe key file is refused rather than replaced', () =>
  instance(({ root, db, config, path }) => {
    openEncryptionKey(config(), db);
    const valid = readFileSync(path);
    chmodSync(path, 0o644);
    assert.throws(() => openEncryptionKey(config(), db), EncryptionKeyError);
    chmodSync(path, 0o600);
    linkSync(path, join(root, 'second-link'));
    assert.throws(() => openEncryptionKey(config(), db), EncryptionKeyError);
    rmSync(join(root, 'second-link'));
    writeFileSync(path, 'not a key\n');
    assert.throws(() => openEncryptionKey(config(), db), EncryptionKeyError);
    assert.equal(readFileSync(path, 'utf8'), 'not a key\n');
    rmSync(path);
    const elsewhere = join(root, 'elsewhere');
    writeFileSync(elsewhere, valid, { mode: 0o600 });
    symlinkSync(elsewhere, path);
    assert.throws(() => openEncryptionKey(config(), db), EncryptionKeyError);
  }));

test('changing the key re-encrypts everything: file to variable, variable to variable, variable to file', () =>
  instance(({ db, config, path, save, read, rows }) => {
    const original = openEncryptionKey(config(), db);
    save(original, 'a');
    save(original, 'b');
    assert.equal(changeEncryptionKey(config(first), db), 2);
    assert.equal(existsSync(path), false, 'The replaced key file is removed.');
    assert.equal(openEncryptionKey(config(first), db).toString('hex'), first);
    assert.equal(read(Buffer.from(first, 'hex'), 'a'), code);
    assert.ok(
      rows().every((row) => row.generation !== 'before'),
      'Running syncs stop.',
    );

    assert.equal(changeEncryptionKey(config(second), db, Buffer.from(first, 'hex')), 2);
    assert.equal(read(Buffer.from(second, 'hex'), 'b'), code);
    assert.equal(changeEncryptionKey(config(second), db), 0, 'A matching key changes nothing.');

    assert.equal(changeEncryptionKey(config(), db, Buffer.from(second, 'hex')), 2);
    const created = openEncryptionKey(config(), db);
    assert.equal(readFileSync(path, 'utf8'), created.toString('hex') + '\n');
    assert.equal(read(created, 'a'), code);
  }));

test('a wrong previous key changes nothing and leaves no new key behind', () =>
  instance(({ db, config, path, save, rows }) => {
    save(Buffer.from(first, 'hex'), 'a');
    save(Buffer.from(second, 'hex'), 'b');
    const before = JSON.stringify(rows());
    assert.throws(
      () => changeEncryptionKey(config(), db, Buffer.from(first, 'hex')),
      /neither the previous nor the new key/,
    );
    assert.equal(JSON.stringify(rows()), before);
    assert.equal(existsSync(path), false);
  }));

test('a lost key can be given up explicitly, keeping readable secrets and match lists', () =>
  instance(({ db, config, save, rows }) => {
    save(Buffer.from(first, 'hex'), 'a');
    save(Buffer.from(second, 'hex'), 'b');
    db.run("INSERT INTO steam_matches(user_id,match_id,code) VALUES('b','1','fixture')");
    assert.equal(forgetUnreadableSecrets(config(first), db, false), 1);
    assert.equal(rows().length, 2, 'Counting removes nothing.');
    assert.equal(forgetUnreadableSecrets(config(first), db, true), 1);
    assert.deepEqual(
      rows().map((row) => row.user_id),
      ['a'],
    );
    assert.equal(db.all('SELECT * FROM steam_matches').length, 1);
    assert.equal(openEncryptionKey(config(first), db).toString('hex'), first);
  }));
