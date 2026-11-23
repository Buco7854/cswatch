import type { Store } from './db.js';
import { HttpError } from './errors.js';

export function requireAvailableEmail(db: Store, email: string, currentId?: string) {
  const assigned = db.one('SELECT id FROM users WHERE email=?', email);
  if (assigned && assigned.id !== currentId)
    throw new HttpError(409, 'That email address is unavailable.', undefined, 'email_unavailable');
}

/** Caller holds the write transaction and must revoke the affected account's sessions. */
export function changeAccountEmail(db: Store, userId: string, email: string) {
  requireAvailableEmail(db, email, userId);
  return Boolean(
    db.run(
      `UPDATE users SET email=?,email_verified_at=NULL,email_revision=email_revision+1
       WHERE id=? AND email IS NOT ?`,
      email,
      userId,
      email,
    ).changes,
  );
}
