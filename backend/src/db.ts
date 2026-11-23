import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import type { Config, Flag } from './config.js';
import { defaultMfaRequiredRoles, flagDefaults } from './config.js';
import { roles, type Role } from './roles.js';
import { factorsSchema } from './factor-schema.js';
import { recoverySchema } from './recovery-schema.js';
import { emailMailSchema } from './email-mail-schema.js';
export type Row = Record<string, any>;
export const auditOutcomes = ['success', 'denied', 'authorized', 'unknown'] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];
export const adminAccountReadAuditAction = 'admin.user.read';
// A linked publication outcome belongs with durable changes even when denied.
const accountRead = `action='${adminAccountReadAuditAction}' AND intent_id IS NULL`;
const auditLimits = [
  ['success', 'operator', 15000, `AND NOT (${accountRead})`],
  ['success', 'operator', 3000, `AND ${accountRead}`],
  ['denied', 'operator', 5000, 'AND intent_id IS NOT NULL'],
  ['denied', 'operator', 5000, 'AND intent_id IS NULL'],
  ['authorized', 'operator', 4500, ''],
  ['unknown', 'operator', 500, ''],
  ['success', 'account', 18000, ''],
  ['denied', 'account', 3000, ''],
  ['authorized', 'account', 0, ''],
  ['unknown', 'account', 0, ''],
  ['success', 'public', 2000, ''],
  ['denied', 'public', 2000, ''],
  ['authorized', 'public', 0, ''],
  ['unknown', 'public', 0, ''],
] as const;
export const databaseVersion = 9;
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
        this.db.exec(`  CREATE TABLE users(
    id TEXT PRIMARY KEY,username TEXT COLLATE NOCASE UNIQUE NOT NULL,password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN (${roles.map((role) => `'${role}'`).join(',')})),
    created_at INTEGER NOT NULL,auth_generation INTEGER NOT NULL DEFAULT 0,
    webauthn_handle TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(32)))),display_name TEXT,last_active INTEGER,
    email TEXT COLLATE NOCASE,email_verified_at INTEGER,email_revision INTEGER NOT NULL DEFAULT 0,
    profile_required INTEGER NOT NULL DEFAULT 0 CHECK(profile_required IN (0,1)),
    email_verification_required INTEGER NOT NULL DEFAULT 0 CHECK(email_verification_required IN (0,1)),
    CHECK(email_verified_at IS NULL OR email IS NOT NULL)
  );
  CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
  CREATE TABLE identities(provider TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(provider,subject),UNIQUE(provider,user_id));
  CREATE TABLE sessions(
    id TEXT NOT NULL UNIQUE,token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('anonymous','challenge','enroll','full')),
    generation INTEGER NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    proof_at INTEGER,proof_kind TEXT CHECK(proof_kind IN ('password','steam','passkey','totp')),
    address TEXT,device TEXT NOT NULL,
    CHECK((stage='anonymous')=(user_id IS NULL)),CHECK((proof_at IS NULL)=(proof_kind IS NULL))
  );
  CREATE INDEX sessions_user ON sessions(user_id,last_used_at);
  CREATE INDEX sessions_expiry ON sessions(expires_at);
  CREATE TABLE session_browser_bindings(
    session_hash TEXT PRIMARY KEY NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    browser_hash TEXT NOT NULL
  );
  CREATE INDEX session_browser_scope ON session_browser_bindings(browser_hash,session_hash);
  CREATE TABLE anonymous_grant_deliveries(
    previous_hash TEXT PRIMARY KEY NOT NULL,
    session_hash TEXT NOT NULL UNIQUE REFERENCES sessions(token_hash) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE guest_sessions(
    owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,
    csrf TEXT NOT NULL,expires_at INTEGER NOT NULL,
    browser_session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,delivery_retry_at INTEGER
  );
  CREATE INDEX guest_sessions_expiry ON guest_sessions(expires_at);
  CREATE TABLE instance_setup(id INTEGER PRIMARY KEY CHECK(id=1),token_hash TEXT NOT NULL);
  CREATE TABLE auth_states(
    token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,return_to TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('login','link','step-up')),subject TEXT,policy TEXT NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1))
  );
  CREATE INDEX auth_states_session ON auth_states(session_hash);
  CREATE TABLE steam_nonces(nonce_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
  CREATE TABLE steam_history(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,steam_id TEXT NOT NULL,encrypted_code BLOB NOT NULL,cursor TEXT NOT NULL,generation TEXT NOT NULL,needs_codes INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE steam_matches(seq INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,match_id TEXT NOT NULL,code TEXT NOT NULL,UNIQUE(user_id,match_id),UNIQUE(user_id,code));
  CREATE INDEX steam_matches_user_seq ON steam_matches(user_id,seq);
  CREATE TABLE demos(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,public INTEGER NOT NULL DEFAULT 0,map TEXT,duration REAL,rounds INTEGER,error TEXT,metadata TEXT,faceit_match_id TEXT,source_ref TEXT,transcription_status TEXT NOT NULL DEFAULT 'disabled',transcription_started_at INTEGER,transcription_job_id TEXT,transcription_bytes INTEGER NOT NULL DEFAULT 0,transcription_artifact TEXT);
  CREATE INDEX demos_transcription_queue ON demos(transcription_status,created_at);
  CREATE INDEX demos_owner_source ON demos(owner_id,source_ref);
  CREATE INDEX demos_queue ON demos(status,created_at);
  CREATE TABLE guest_upload_grants(
    demo_id TEXT PRIMARY KEY NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
    original_hash TEXT NOT NULL,
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    expires_at_ms INTEGER NOT NULL
  );
  CREATE INDEX guest_upload_grants_session ON guest_upload_grants(session_hash);
  CREATE TABLE pending_demo_deletions(id TEXT PRIMARY KEY,size INTEGER NOT NULL,ready_at INTEGER NOT NULL);
  CREATE INDEX pending_demo_deletions_ready ON pending_demo_deletions(ready_at,id);
  CREATE TABLE bookmarks(id TEXT PRIMARY KEY,demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,tick INTEGER NOT NULL,label TEXT NOT NULL);
  CREATE TABLE auth_relying_party(id INTEGER PRIMARY KEY CHECK(id=1),hostname TEXT NOT NULL);
  CREATE TABLE settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
  CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
  CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
  CREATE TABLE audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT NOT NULL,created_at INTEGER NOT NULL,target TEXT,address TEXT,outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','authorized','unknown')),intent_id INTEGER REFERENCES audit(id) ON DELETE CASCADE,scope TEXT NOT NULL CHECK(scope IN ('operator','account','public')));
  CREATE INDEX audit_intent ON audit(intent_id) WHERE intent_id IS NOT NULL;
  CREATE TRIGGER audit_retire_intent AFTER DELETE ON audit WHEN OLD.intent_id IS NOT NULL BEGIN
    DELETE FROM audit WHERE id=OLD.intent_id AND outcome='authorized';
  END;
  CREATE INDEX audit_expiry ON audit(created_at);
  CREATE INDEX audit_outcome ON audit(outcome,scope,id);
  ${factorsSchema}
  ${recoverySchema}
  ${emailMailSchema}
  PRAGMA user_version=${databaseVersion};`);
      });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
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
  mfaRequiredRoles(config: Config): readonly Role[] {
    if (config.mfaRequiredRoles !== undefined) return config.mfaRequiredRoles;
    const setting = this.one("SELECT value FROM settings WHERE key='mfa_required_roles'");
    return setting
      ? roles.filter((_, index) => (setting.value & (1 << index)) !== 0)
      : defaultMfaRequiredRoles;
  }
  setMfaRequiredRoles(config: Config, required: readonly Role[]) {
    if (config.mfaRequiredRoles !== undefined) throw new Error('MFA role policy is locked.');
    const previous = this.mfaRequiredRoles(config);
    const mask = roles.reduce(
      (bits, role, index) => bits | (required.includes(role) ? 1 << index : 0),
      0,
    );
    this.run(
      "INSERT INTO settings VALUES('mfa_required_roles',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      mask,
    );
    if (previous.length === required.length && previous.every((role) => required.includes(role)))
      return;
    this.run('DELETE FROM auth_states');
    this.retireIneligibleSessions(config);
  }
  bindRelyingParty(config: Config) {
    const host = new URL(config.appUrl).hostname;
    const current = this.one('SELECT hostname FROM auth_relying_party WHERE id=1');
    if (current?.hostname === host) return;
    if (this.one('SELECT 1 FROM auth_passkeys LIMIT 1'))
      throw new Error(
        'The configured APP_URL hostname differs from the enrolled passkey relying party. Restore the previous hostname or use the local account CLI to reset factors before moving.',
      );
    this.run(
      'INSERT INTO auth_relying_party VALUES(1,?) ON CONFLICT(id) DO UPDATE SET hostname=excluded.hostname',
      host,
    );
  }
  retireSteamAttempts() {
    this.run('DELETE FROM auth_states');
    this.run("DELETE FROM sessions WHERE stage IN ('challenge','enroll') AND proof_kind='steam'");
  }
  retireIneligibleSessions(config: Config) {
    const required = this.mfaRequiredRoles(config);
    if (!this.flag(config, 'steam_enabled')) this.retireSteamAttempts();
    else this.run('DELETE FROM auth_states WHERE policy<>?', required.join(','));
    for (const role of required)
      this.run(
        `DELETE FROM sessions WHERE stage='full' AND user_id IN (
        SELECT id FROM users u WHERE role=?
        AND NOT EXISTS (SELECT 1 FROM auth_passkeys WHERE user_id=u.id)
        AND NOT EXISTS (SELECT 1 FROM auth_totp WHERE user_id=u.id))`,
        role,
      );
  }
  audit(
    actor: string | null,
    action: string,
    details: {
      target?: string | null;
      address?: string | null;
      outcome?: AuditOutcome;
      intentId?: number;
      administrative?: boolean;
    } = {},
  ) {
    const append = () => {
      const outcome = details.outcome ?? 'success';
      const result = this.run(
        'INSERT INTO audit(actor,action,created_at,target,address,outcome,intent_id,scope) VALUES(?,?,?,?,?,?,(SELECT id FROM audit WHERE id=?),?)',
        actor,
        action,
        now(),
        details.target ?? null,
        details.address && isIP(details.address) ? details.address : null,
        outcome,
        details.intentId ?? null,
        details.administrative || action.startsWith('cli.')
          ? 'operator'
          : actor
            ? 'account'
            : 'public',
      );
      const id = Number(result.lastInsertRowid);
      if (id % 128 === 0) {
        for (const [kind, scope, limit, filter] of auditLimits)
          this.run(
            `DELETE FROM audit WHERE outcome=? AND scope=? ${filter} AND id<=(
            SELECT id FROM audit WHERE outcome=? AND scope=? ${filter} ORDER BY id DESC LIMIT 1 OFFSET ?
          )`,
            kind,
            scope,
            kind,
            scope,
            limit,
          );
      }

      return id;
    };
    return this.db.isTransaction ? append() : this.transaction(append);
  }
  close() {
    this.db.close();
  }
}
export const now = () => Math.floor(Date.now() / 1000);
