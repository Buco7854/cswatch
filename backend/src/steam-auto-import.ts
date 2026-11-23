import { emailDeliveryEnabled, type Config } from './config.js';
import { now, type Store } from './db.js';
import { HttpError } from './errors.js';
import { token } from './security.js';

export type SteamImportBinding = { steamId: string; generation: string; grantId: string };
type ImportMatch = (
  userId: string,
  matchId: string,
  binding: SteamImportBinding,
  signal: AbortSignal,
) => Promise<{ id: string }>;
type SyncHistory = (
  userId: string,
  binding: SteamImportBinding,
  signal: AbortSignal,
) => Promise<unknown>;

export function prepareSteamImports(db: Store) {
  // Optional web-service state is additive. Workers never need to open these tables.
  db.transaction(() =>
    db.db.exec(`
    CREATE TABLE IF NOT EXISTS steam_auto_imports(
      user_id TEXT PRIMARY KEY REFERENCES steam_history(user_id) ON DELETE CASCADE,
      steam_id TEXT NOT NULL, generation TEXT NOT NULL, grant_id TEXT NOT NULL UNIQUE,
      next_sync INTEGER NOT NULL, last_import INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS steam_auto_jobs(
      user_id TEXT NOT NULL, match_id TEXT NOT NULL,
      grant_id TEXT NOT NULL REFERENCES steam_auto_imports(grant_id) ON DELETE CASCADE,
      retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,match_id),
      FOREIGN KEY(user_id,match_id) REFERENCES steam_matches(user_id,match_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS steam_auto_due ON steam_auto_jobs(retry_at);
    CREATE INDEX IF NOT EXISTS steam_auto_sync_due ON steam_auto_imports(next_sync);
  `),
  );
}

// Caller holds the same transaction as the user's consent or the discovered match.
export function queueSteamMatches(db: Store, userId: string, matchId?: string) {
  db.run(
    `INSERT OR IGNORE INTO steam_auto_jobs(user_id,match_id,grant_id)
    SELECT m.user_id,m.match_id,a.grant_id FROM steam_matches m
    JOIN steam_auto_imports a ON a.user_id=m.user_id
    JOIN steam_history h ON h.user_id=a.user_id AND h.generation=a.generation AND h.steam_id=a.steam_id
    WHERE m.user_id=? AND (? IS NULL OR m.match_id=?) AND h.needs_codes=0
    AND NOT EXISTS(SELECT 1 FROM demos d WHERE d.owner_id=m.user_id AND d.source_ref='steam:'||m.match_id AND d.status NOT IN ('failed','uploading'))`,
    userId,
    matchId ?? null,
    matchId ?? null,
  );
}

export function setSteamAutoImport(
  db: Store,
  userId: string,
  steamId: string,
  generation: string,
  enabled: boolean,
) {
  const grant = db.one('SELECT * FROM steam_auto_imports WHERE user_id=?', userId);
  if (enabled && grant?.generation === generation && grant.steam_id === steamId) return;
  db.run('DELETE FROM steam_auto_imports WHERE user_id=?', userId);
  if (enabled) {
    db.run(
      'INSERT INTO steam_auto_imports(user_id,steam_id,generation,grant_id,next_sync) VALUES(?,?,?,?,?)',
      userId,
      steamId,
      generation,
      token(),
      now(),
    );
    queueSteamMatches(db, userId);
  }
}

const currentGrant = `JOIN steam_history h ON h.user_id=a.user_id AND h.steam_id=a.steam_id AND h.generation=a.generation
  JOIN users u ON u.id=a.user_id AND u.profile_required=0 AND (u.email_verification_required=0 OR u.email_verified_at IS NOT NULL OR ?=0)
  JOIN identities i ON i.user_id=a.user_id AND i.provider='steam' AND i.subject=a.steam_id`;

export function activeSteamImportGrant(
  db: Store,
  c: Config,
  userId: string,
  binding: SteamImportBinding,
) {
  return (
    c.steamCoordinatorEnabled &&
    db.flag(c, 'steam_enabled') &&
    Boolean(
      db.one(
        `SELECT 1 FROM steam_auto_imports a ${currentGrant} WHERE a.user_id=? AND a.grant_id=? AND a.generation=? AND a.steam_id=? AND h.needs_codes=0`,
        Number(emailDeliveryEnabled(db, c)),
        userId,
        binding.grantId,
        binding.generation,
        binding.steamId,
      ),
    )
  );
}

/** A single web process owns the queue. Claims survive restart. Cancellation and grant
 * rotation prevent in-flight work from publishing after an opt-out or relink. */
export class SteamAutoImporter {
  private active?: { userId: string; controller: AbortController; binding: SteamImportBinding };
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private preferSync = true;

  constructor(
    private db: Store,
    private config: Config,
    private sync: SyncHistory,
    private download: ImportMatch,
  ) {}

  start(onError: () => void) {
    if (this.config.steamCoordinatorEnabled && !this.timer)
      this.timer = setInterval(() => {
        void this.tick().catch(onError);
      }, 10_000).unref();
  }
  cancel(userId: string) {
    if (this.active?.userId === userId) this.active.controller.abort();
  }
  async close() {
    clearInterval(this.timer);
    this.active?.controller.abort();
    await this.pending;
  }
  async tick() {
    const active = this.active;
    if (active && !activeSteamImportGrant(this.db, this.config, active.userId, active.binding))
      active.controller.abort();
    if (!this.pending)
      this.pending = this.step().finally(() => {
        this.pending = undefined;
        this.active = undefined;
      });
    return this.pending;
  }
  private async step() {
    const { db, config } = this;
    if (!config.steamCoordinatorEnabled || !db.flag(config, 'steam_enabled')) return;
    const time = now();
    const emailGate = Number(emailDeliveryEnabled(db, config));
    const sync = () =>
      db.one(
        `SELECT a.* FROM steam_auto_imports a ${currentGrant}
      WHERE h.needs_codes=0 AND a.next_sync<=? ORDER BY a.next_sync,a.user_id LIMIT 1`,
        emailGate,
        time,
      );
    const file = () =>
      db.one(
        `SELECT a.*,j.match_id,j.attempts FROM steam_auto_jobs j
      JOIN steam_auto_imports a ON a.grant_id=j.grant_id ${currentGrant}
      JOIN steam_matches m ON m.user_id=j.user_id AND m.match_id=j.match_id
      WHERE h.needs_codes=0 AND j.retry_at<=? ORDER BY a.last_import,m.seq DESC LIMIT 1`,
        emailGate,
        time,
      );
    const row = db.transaction(() => {
      const work = this.preferSync ? (sync() ?? file()) : (file() ?? sync());
      if (work?.match_id) {
        db.run(
          'UPDATE steam_auto_jobs SET retry_at=? WHERE grant_id=? AND match_id=?',
          time + 300,
          work.grant_id,
          work.match_id,
        );
        db.run('UPDATE steam_auto_imports SET last_import=? WHERE grant_id=?', time, work.grant_id);
      } else if (work) {
        db.run(
          'UPDATE steam_auto_imports SET next_sync=? WHERE grant_id=?',
          time + config.steamSyncIntervalMinutes * 60,
          work.grant_id,
        );
      }
      return work;
    });
    if (!row) return;
    this.preferSync = Boolean(row.match_id);
    const controller = new AbortController();
    const binding = { steamId: row.steam_id, generation: row.generation, grantId: row.grant_id };
    this.active = { userId: row.user_id, controller, binding };
    try {
      if (!row.match_id) {
        await this.sync(row.user_id, binding, controller.signal);
        return;
      }
      await this.download(row.user_id, row.match_id, binding, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!row.match_id) {
        if (error instanceof HttpError && error.retryAfter)
          db.run(
            'UPDATE steam_auto_imports SET next_sync=max(next_sync,?) WHERE grant_id=?',
            now() + error.retryAfter,
            row.grant_id,
          );
        return;
      }
      const http = error instanceof HttpError ? error : undefined;
      if (http?.code === 'steam_already_added') {
        const committed = db.one(
          "SELECT 1 FROM demos WHERE owner_id=? AND source_ref=? AND status NOT IN ('uploading','failed')",
          row.user_id,
          'steam:' + row.match_id,
        );
        if (!committed) {
          // A manual transfer has only reserved its slot. Keep the job until
          // the transfer actually publishes, or retry if it gets cancelled.
          db.run(
            'UPDATE steam_auto_jobs SET retry_at=? WHERE grant_id=? AND match_id=?',
            now() + 60,
            row.grant_id,
            row.match_id,
          );
          return;
        }
      }
      if (http?.code === 'steam_storage_limit') {
        db.run(
          'UPDATE steam_auto_jobs SET retry_at=max(retry_at,?) WHERE grant_id=?',
          now() + 3600,
          row.grant_id,
        );
        return;
      }
      const busy = http?.statusCode === 429 || http?.code === 'steam_coordinator_setup';
      const transient = !http || http.statusCode >= 500 || http.statusCode === 408;
      if (busy || (transient && row.attempts < 5)) {
        const delay = Math.max(
          http?.retryAfter ?? 0,
          http?.code === 'steam_coordinator_setup'
            ? 3600
            : busy
              ? 60
              : Math.min(3600, 60 * 2 ** row.attempts),
        );
        db.run(
          'UPDATE steam_auto_jobs SET retry_at=?,attempts=attempts+? WHERE grant_id=? AND match_id=?',
          now() + delay,
          busy ? 0 : 1,
          row.grant_id,
          row.match_id,
        );
        return;
      }
    }
    db.run(
      'DELETE FROM steam_auto_jobs WHERE grant_id=? AND match_id=?',
      row.grant_id,
      row.match_id,
    );
  }
}
