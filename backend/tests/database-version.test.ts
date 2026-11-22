import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { databaseVersion, DatabaseVersionError, Store } from '../src/db.js';

test('empty data directories get a complete versioned schema once', () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-schema-'));
  try {
    writeFileSync(join(root, 'replay.db'), '');
    const db = new Store(root);
    assert.equal(db.one('PRAGMA user_version')?.user_version, databaseVersion);
    assert.equal(db.one('PRAGMA journal_mode')?.journal_mode, 'wal');
    db.run('INSERT INTO settings VALUES(?,?)', 'public_access', 1);
    db.close();
    const reopened = new Store(root);
    try {
      assert.equal(
        reopened.one('SELECT value FROM settings WHERE key=?', 'public_access')?.value,
        1,
      );
      const columns = reopened.all('PRAGMA table_info(demos)').map(({ name }) => name);
      for (const field of [
        'source_ref',
        'transcription_status',
        'transcription_job_id',
        'transcription_started_at',
        'transcription_bytes',
        'transcription_artifact',
      ])
        assert.ok(columns.includes(field));
      assert.equal(
        reopened.one("SELECT name FROM sqlite_schema WHERE name='schema_version'"),
        undefined,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('incompatible databases, WAL and SHM are unchanged by both startup entry points', () => {
  for (const version of [0, databaseVersion - 1, databaseVersion + 1]) {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-schema-reject-'));
    const file = join(root, 'replay.db');
    const old = new DatabaseSync(file);
    try {
      old.exec(
        `CREATE TABLE sentinel(value TEXT); PRAGMA user_version=${version}; PRAGMA journal_mode=WAL; INSERT INTO sentinel VALUES('preserve');`,
      );
      const files = [file, file + '-wal', file + '-shm'];
      const oldBytes = files.map((path) => readFileSync(path));
      const oldStats = files.map((path) => statSync(path));
      assert.throws(() => new Store(root), DatabaseVersionError);
      for (const entry of ['server', 'worker']) {
        const script = resolve(`dist/${entry}.js`);
        if (!existsSync(script)) continue;
        const result = spawnSync(process.execPath, [script], {
          env: {
            ...process.env,
            APP_URL: 'https://localhost',
            DATA_DIR: root,
            NODE_NO_WARNINGS: '1',
          },
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stderr.trim(), new DatabaseVersionError().message);
      }
      for (const [index, path] of files.entries()) {
        assert.deepEqual(readFileSync(path), oldBytes[index]);
        assert.equal(statSync(path).mode, oldStats[index].mode);
        assert.equal(statSync(path).mtimeMs, oldStats[index].mtimeMs);
      }
      assert.equal(existsSync(join(root, 'demos')), false);
      assert.equal(existsSync(join(root, 'maps')), false);
    } finally {
      old.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
