import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.js';
import { now } from './db.js';
import type { Config } from './config.js';
import { demoWriteTimeoutMs, globalDemoStorage, removeDemoFiles } from './demo-deletion.js';
import { HttpError, token } from './security.js';
export { validateMagic } from './demo-format.js';
export function reserve(
  db: Store,
  c: Config,
  owner: string,
  name: string,
  source: string,
  matchId: string | null = null,
  sourceRef: string | null = null,
  authorize?: (writeExpiresAt: number) => string | void,
) {
  const id = token().slice(0, 32),
    size = c.maxUploadMb * 1024 ** 2;
  const folder = join(db.root, 'demos', id);
  const writeExpiresAt = Date.now() + demoWriteTimeoutMs;
  let created = false;
  try {
    db.transaction(() => {
      const anonymousGrantHash = authorize?.(writeExpiresAt);
      if (db.one('SELECT 1 FROM pending_demo_deletions WHERE id=?', id))
        throw new HttpError(503, 'Demo storage is unavailable.');
      if (
        sourceRef &&
        db.one(
          "SELECT 1 FROM demos WHERE owner_id=? AND source_ref=? AND (status!='failed' OR source_ref NOT LIKE 'steam:%')",
          owner,
          sourceRef,
        )
      )
        throw sourceRef.startsWith('steam:')
          ? new HttpError(
              409,
              'This Steam demo has already been added.',
              undefined,
              'steam_already_added',
            )
          : new HttpError(409, 'This FACEIT demo has already been added.');

      const u = db.one(
        'SELECT count(*) AS n,coalesce(sum(size),0) AS size FROM demos WHERE owner_id=?',
        owner,
      )!;
      if (u.n >= c.userDemoLimit || u.size + size > c.userStorageMb * 1024 ** 2)
        throw new HttpError(
          413,
          'Your storage limit has been reached. Delete a demo before uploading.',
          undefined,
          sourceRef?.startsWith('steam:') ? 'steam_storage_limit' : undefined,
        );
      if (globalDemoStorage(db) + size > c.globalStorageMb * 1024 ** 2)
        throw new HttpError(503, 'Demo storage is full. Delete an older demo or try again later.');
      db.run(
        'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,faceit_match_id,source_ref) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        owner,
        name,
        source,
        'uploading',
        size,
        now(),
        matchId,
        sourceRef,
      );
      if (anonymousGrantHash)
        db.run(
          'INSERT INTO guest_upload_grants(demo_id,original_hash,session_hash,expires_at_ms) VALUES(?,?,?,?)',
          id,
          anonymousGrantHash,
          anonymousGrantHash,
          writeExpiresAt,
        );
      try {
        mkdirSync(folder, { mode: 0o700 });
        created = true;
      } catch {
        throw new HttpError(503, 'Demo storage is unavailable.');
      }
    });
  } catch (error) {
    if (created) rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return { id, folder, writeExpiresAt };
}
/** Upload and provider pipelines call this only after their file descriptor
 * closes, or when no file was opened. Keep the reservation on storage failure. */
export function abandonUpload(db: Store, id: string) {
  db.transaction(() => {
    const demo = db.one('SELECT status FROM demos WHERE id=?', id);
    if (demo && demo.status !== 'uploading') return;
    removeDemoFiles(db, id);
    db.run('DELETE FROM demos WHERE id=?', id);
    db.run('DELETE FROM pending_demo_deletions WHERE id=?', id);
  });
}

export function accessDemo(
  db: Store,
  id: string,
  user: { id: string } | null,
  ownerOnly = false,
  guest?: { id: string } | null,
) {
  const d = db.one('SELECT * FROM demos WHERE id=?', id);
  if (
    !d ||
    ((!user || user.id !== d.owner_id) && guest?.id !== d.owner_id && (ownerOnly || !d.public))
  )
    throw new HttpError(404, 'Demo not found.');
  return d;
}
