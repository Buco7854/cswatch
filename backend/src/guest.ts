import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { Store, now } from './db.js';
import { digest, HttpError, rateLimit, token } from './security.js';
import { setupRequired } from './setup.js';

type GuestSession = { id: string; csrf: string; expires_at: number };
declare module 'fastify' {
  interface FastifyRequest {
    guest: GuestSession | null;
  }
}
export const guestCookieName = (c: Pick<Config, 'cookieSecure'>) =>
  c.cookieSecure ? '__Host-cswatch_guest' : 'cswatch_guest';
export const guestUploadsEnabled = (db: Store, c: Config) =>
  db.flag(c, 'public_access') && db.flag(c, 'guest_uploads_enabled') && !setupRequired(db);
export function currentGuest(db: Store, request: FastifyRequest, c: Config): GuestSession | null {
  if (!guestUploadsEnabled(db, c)) return null;
  const raw = request.cookies[guestCookieName(c)];
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
  return (
    (db.one(
      'SELECT owner_id AS id,csrf,expires_at FROM guest_sessions WHERE token_hash=? AND expires_at>?',
      digest(raw),
      now(),
    ) as GuestSession) || null
  );
}

/** Temporary principals can own private files, but have no account, password,
 * identity or authenticated session. Only an expiring opaque capability reaches them. */
export async function guestRoutes(app: FastifyInstance, db: Store, c: Config) {
  app.post('/api/guest/session', async (request, reply) => {
    z.object({})
      .strict()
      .parse(request.body || {});
    if (!guestUploadsEnabled(db, c)) throw new HttpError(403, 'Guest uploads are disabled.');
    if (request.user)
      throw new HttpError(409, 'You are already signed in. Upload from your library.');
    if (request.guest) return { csrf: request.guest.csrf, expires_at: request.guest.expires_at };
    rateLimit(db, request, 'guest-session', 10, 3600);
    const raw = token(),
      id = token().slice(0, 32),
      csrf = token();
    const expires = now() + c.guestRetentionHours * 3600;
    db.transaction(() => {
      if (db.one('SELECT count(*) AS count FROM guest_sessions')!.count >= 4096)
        throw new HttpError(503, 'Guest upload capacity has been reached. Try again later.');
      db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, '$guest_' + id, null, 0, now());
      db.run(
        'INSERT INTO guest_sessions(owner_id,token_hash,csrf,expires_at) VALUES(?,?,?,?)',
        id,
        digest(raw),
        csrf,
        expires,
      );
    });
    reply.setCookie(guestCookieName(c), raw, {
      httpOnly: true,
      secure: c.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: c.guestRetentionHours * 3600,
    });
    reply.code(201);
    return { csrf, expires_at: expires };
  });
}

/** Worker maintenance owns removal. Expiry is already enforced on every read. */
export function cleanupExpiredGuests(db: Store) {
  const expired = db.all('SELECT owner_id FROM guest_sessions WHERE expires_at<=?', now());
  for (const guest of expired) {
    const demos = db.all('SELECT id FROM demos WHERE owner_id=?', guest.owner_id);
    // Remove the capability and rows first, so no concurrent request can reopen files.
    db.transaction(() => {
      db.run('DELETE FROM users WHERE id=?', guest.owner_id);
    });
    for (const demo of demos)
      rmSync(join(db.root, 'demos', demo.id), { recursive: true, force: true });
  }
}
