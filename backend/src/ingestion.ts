import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.js';
import { now } from './db.js';
import type { Config } from './config.js';
import { HttpError, token } from './security.js';
export { validateMagic } from './demo-format.js';
export function reserve(
  db: Store,
  c: Config,
  owner: string,
  name: string,
  source: string,
  matchId: string | null = null,
) {
  const id = token().slice(0, 32),
    size = c.maxUploadMb * 1024 ** 2;
  db.transaction(() => {
    const u = db.one(
      'SELECT count(*) AS n,coalesce(sum(size),0) AS size FROM demos WHERE owner_id=?',
      owner,
    )!;
    const total = db.one('SELECT coalesce(sum(size),0) AS size FROM demos')!;
    if (u.n >= c.userDemoLimit || u.size + size > c.userStorageMb * 1024 ** 2)
      throw new HttpError(
        413,
        'Your storage limit has been reached. Delete a demo before uploading.',
      );
    if (total.size + size > c.globalStorageMb * 1024 ** 2)
      throw new HttpError(503, 'Demo storage is full. Contact the administrator.');
    db.run(
      'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,faceit_match_id) VALUES(?,?,?,?,?,?,?,?)',
      id,
      owner,
      name,
      source,
      'uploading',
      size,
      now(),
      matchId,
    );
  });
  const folder = join(db.root, 'demos', id);
  try {
    mkdirSync(folder, { mode: 0o700 });
  } catch {
    db.run('DELETE FROM demos WHERE id=?', id);
    throw new HttpError(503, 'Demo storage is unavailable.');
  }
  return { id, folder };
}
export function abandon(db: Store, id: string) {
  db.run('DELETE FROM demos WHERE id=?', id);
  rmSync(join(db.root, 'demos', id), { recursive: true, force: true });
}
export function accessDemo(db: Store, id: string, user: { id: string } | null, ownerOnly = false) {
  const d = db.one('SELECT * FROM demos WHERE id=?', id);
  if (!d || ((!user || user.id !== d.owner_id) && (ownerOnly || !d.public)))
    throw new HttpError(404, 'Demo not found.');
  return d;
}
export const credentialsSchema = { username: /^[A-Za-z0-9_-]{3,32}$/ };
