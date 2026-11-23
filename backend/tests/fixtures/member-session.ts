import type { Store } from '../../src/db.js';
import { now } from '../../src/db.js';
import { COOKIE, digest } from '../../src/security.js';

/** Real cookie shape with a stable opaque value for each isolated fixture browser. */
export function fixtureCookie(label: string) {
  return COOKIE + '=' + digest(label);
}

export function insertFixtureSession(
  db: Store,
  label: string,
  userId: string,
  csrf: string,
  expires: number,
) {
  db.run(
    `INSERT INTO sessions(id,token_hash,user_id,csrf,stage,generation,created_at,last_used_at,expires_at,proof_at,proof_kind,device)
     SELECT ?,?,id,?,'full',auth_generation,?,?,?,?,'password','Fixture browser' FROM users WHERE id=?`,
    digest('session-id:' + label),
    digest(digest(label)),
    csrf,
    now(),
    now(),
    expires,
    now(),
    userId,
  );
}
