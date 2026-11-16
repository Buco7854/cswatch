import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Flag } from './config.js';
import { flagDefaults } from './config.js';
export type Row = Record<string, any>;
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    for (const p of [root, join(root, 'demos'), join(root, 'maps')])
      mkdirSync(p, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'replay.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT COLLATE NOCASE UNIQUE NOT NULL,password_hash TEXT,is_admin INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(provider,subject),UNIQUE(provider,user_id));
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS auth_states(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,return_to TEXT NOT NULL DEFAULT '/library');
  CREATE TABLE IF NOT EXISTS demos(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,public INTEGER NOT NULL DEFAULT 0,map TEXT,duration REAL,rounds INTEGER,error TEXT,metadata TEXT,faceit_match_id TEXT);
  CREATE INDEX IF NOT EXISTS demos_queue ON demos(status,created_at);
  CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY,demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,tick INTEGER NOT NULL,label TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
  INSERT OR IGNORE INTO schema_version VALUES(1);`);
    this.transaction(() => {
      const columns = this.all('PRAGMA table_info(auth_states)');
      if (!columns.some((column) => column.name === 'return_to'))
        this.db.exec(
          "ALTER TABLE auth_states ADD COLUMN return_to TEXT NOT NULL DEFAULT '/library'",
        );
      this.db.exec(
        'DELETE FROM schema_version WHERE version<2; INSERT OR IGNORE INTO schema_version VALUES(2);',
      );
    });
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
