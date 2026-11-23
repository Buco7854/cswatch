import { constants, lstatSync, mkdirSync, mkdtempSync, opendirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import { now, type Store } from './db.js';
import { syncDirectory } from './directory-sync.js';

export const demoWriteTimeoutMs = 600_000;
const writerGraceSeconds = 60;
const scratchRoots = ['jobs', 'transcription-jobs'] as const;
const demoId = /^[a-f0-9]{32}$/;
const scratchName = /^([a-f0-9]{32})-[A-Za-z0-9]{6}$/;

/** Store cleanup authority before cascading away the file owner's rows. */
export function enqueueUserDemoDeletion(
  db: Store,
  c: Config,
  userId: string,
  id: string | null = null,
) {
  db.run(
    `INSERT INTO pending_demo_deletions(id,size,ready_at)
     SELECT id,size,max(?,coalesce(started_at+?,0),coalesce(transcription_started_at+?,0),
       CASE WHEN status='uploading' THEN created_at+? ELSE 0 END)
     FROM demos WHERE owner_id=? AND (? IS NULL OR id=?)`,
    now(),
    c.parserTimeoutSeconds + 60,
    c.transcriptionTimeoutSeconds + 60,
    demoWriteTimeoutMs / 1000 + writerGraceSeconds,
    userId,
    id,
    id,
  );
}

/** Scratch allocation and account deletion share a write lock. A worker that
 * lost its lease cannot create a new directory after cleanup has begun. */
export function createDemoScratch(
  db: Store,
  id: string,
  root: (typeof scratchRoots)[number],
  stillOwned: () => boolean,
) {
  return db.transaction(() => {
    if (!stillOwned()) throw new Error('Demo job cancelled');
    const jobs = join(db.root, root);
    mkdirSync(jobs, { recursive: true, mode: 0o700 });
    return mkdtempSync(join(jobs, id + '-'));
  });
}

export function globalDemoStorage(db: Store) {
  return db.one(
    `SELECT (SELECT coalesce(sum(size),0) FROM demos)
          + (SELECT coalesce(sum(size),0) FROM pending_demo_deletions) AS bytes`,
  )!.bytes as number;
}

function removeScratch(root: string, pending: Set<string>, failures: Set<string>) {
  try {
    const info = lstatSync(root, { throwIfNoEntry: false });
    if (!info) {
      // Persist the absence of this optional directory in its parent.
      syncDirectory(dirname(root));
      return;
    }
    if (!info.isDirectory()) throw new Error('Invalid demo scratch root');
    const directory = opendirSync(root);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const id = scratchName.exec(entry.name)?.[1];
        if (!id || !pending.has(id)) continue;
        try {
          rmSync(join(root, entry.name), { recursive: true, force: true });
        } catch {
          failures.add(id);
        }
      }
    } finally {
      directory.closeSync();
    }
    // Sync even when no entry matches this batch. An earlier attempt may have
    // removed the entry and then failed to sync.
    syncDirectory(root, constants.O_NOFOLLOW);
  } catch {
    for (const id of pending) failures.add(id);
  }
}

/** Persist the removal even if a previous attempt already unlinked the demo. */
export function removeDemoFiles(db: Store, id: string) {
  const root = join(db.root, 'demos');
  if (!demoId.test(id) || !lstatSync(root).isDirectory()) throw new Error('Demo path unavailable');
  rmSync(join(root, id), { recursive: true, force: true });
  syncDirectory(root, constants.O_NOFOLLOW);
}

/** Keep the bounded disk reservation and retry until the removals are durable.
 * Multiple workers can safely repeat these removals after an interruption. */
export function cleanupDeletedDemos(db: Store, requestedId?: string) {
  const ready = requestedId
    ? db.all('SELECT id FROM pending_demo_deletions WHERE id=? AND ready_at<=?', requestedId, now())
    : db.all(
        'SELECT id FROM pending_demo_deletions WHERE ready_at<=? ORDER BY ready_at,id LIMIT 100',
        now(),
      );
  const pending = new Set<string>(ready.map((row) => row.id));
  if (!pending.size) return;
  const failures = new Set<string>();
  for (const root of scratchRoots) removeScratch(join(db.root, root), pending, failures);
  for (const id of pending) {
    try {
      if (failures.has(id)) throw new Error('Demo scratch path unavailable');
      removeDemoFiles(db, id);
      db.run('DELETE FROM pending_demo_deletions WHERE id=?', id);
    } catch {
      db.run('UPDATE pending_demo_deletions SET ready_at=? WHERE id=?', now() + 60, id);
      console.warn('Deleted demo files remain pending');
    }
  }
}
