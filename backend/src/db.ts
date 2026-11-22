import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Flag } from './config.js';
import { flagDefaults } from './config.js';
export type Row = Record<string, any>;
export const databaseVersion = 6;
export class DatabaseVersionError extends Error {
  constructor() {
    super('Unsupported database schema. Start cswatch with an empty data directory.');
  }
}

/** Read the SQLite header without opening SQLite, so a rejected database and
 * its WAL/SHM files never undergo recovery, checkpointing or permission changes. */
function checkDatabaseHeader(path: string) {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    if (fstatSync(fd).size === 0) return;
    const header = Buffer.alloc(64);
    if (
      readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
      header.readUInt32BE(60) !== databaseVersion
    )
      throw new DatabaseVersionError();
  } finally {
    closeSync(fd);
  }
}

export function openStoreForStartup(root: string) {
  try {
    return new Store(root);
  } catch (error) {
    if (!(error instanceof DatabaseVersionError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    const path = join(root, 'replay.db');
    checkDatabaseHeader(path);
    for (const p of [root, join(root, 'demos')]) {
      mkdirSync(p, { recursive: true, mode: 0o700 });
      chmodSync(p, 0o700);
    }
    // Existing operator assets may be mounted read-only independently of private data.
    mkdirSync(join(root, 'maps'), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;');
      this.transaction(() => {
        const version = this.one('PRAGMA user_version')?.user_version;
        if (version === databaseVersion) return;
        if (version !== 0 || this.one('SELECT 1 FROM sqlite_schema LIMIT 1'))
          throw new DatabaseVersionError();
        this.db
          .exec(`  CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT COLLATE NOCASE UNIQUE NOT NULL,password_hash TEXT,is_admin INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
  CREATE TABLE identities(provider TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(provider,subject),UNIQUE(provider,user_id));
  CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE guest_sessions(owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE INDEX guest_sessions_expiry ON guest_sessions(expires_at);
  CREATE TABLE instance_setup(id INTEGER PRIMARY KEY CHECK(id=1),token_hash TEXT NOT NULL);
  CREATE TABLE auth_states(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,return_to TEXT NOT NULL DEFAULT '/library');
  CREATE TABLE demos(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,public INTEGER NOT NULL DEFAULT 0,map TEXT,duration REAL,rounds INTEGER,error TEXT,metadata TEXT,faceit_match_id TEXT,source_ref TEXT,transcription_status TEXT NOT NULL DEFAULT 'disabled',transcription_started_at INTEGER,transcription_job_id TEXT,transcription_bytes INTEGER NOT NULL DEFAULT 0,transcription_artifact TEXT);
  CREATE INDEX demos_transcription_queue ON demos(transcription_status,created_at);
  CREATE INDEX demos_queue ON demos(status,created_at);
  CREATE TABLE bookmarks(id TEXT PRIMARY KEY,demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,tick INTEGER NOT NULL,label TEXT NOT NULL);
  CREATE TABLE settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
  CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT NOT NULL,created_at INTEGER NOT NULL);
  PRAGMA user_version=${databaseVersion};`);
      });
      this.db.exec('PRAGMA journal_mode=WAL;');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  one(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  flag(config: Config, key: Flag) {
    return (
      config.flags[key] ??
      Boolean(this.one('SELECT value FROM settings WHERE key=?', key)?.value ?? flagDefaults[key])
    );
  }
  audit(actor: string | null, action: string) {
    this.run('INSERT INTO audit(actor,action,created_at) VALUES(?,?,?)', actor, action, now());
  }
  close() {
    this.db.close();
  }
}
export const now = () => Math.floor(Date.now() / 1000);
