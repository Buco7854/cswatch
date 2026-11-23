import { demoWriteTimeoutMs, enqueueUserDemoDeletion } from './demo-deletion.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { Store, now } from './db.js';
import {
  chargeBudgets,
  currentSession,
  digest,
  hasGuestUploadGrant,
  HttpError,
  requireSession,
  reserveAnonymousTime,
  sendSession,
  token,
} from './security.js';
import { setupRequired } from './setup.js';

const guestDeliveryGrace = 15;
type GuestSession = {
  id: string;
  csrf: string;
  expires_at: number;
  delivery_retry_at: number | null;
};
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
  if (
    request.authSession &&
    (request.authSession.stage !== 'anonymous' ||
      currentSession(db, request, c)?.token_hash !== request.authSession.token_hash)
  )
    return null;
  return guestCapability(db, request, c);
}

export function currentReservedGuest(
  db: Store,
  request: FastifyRequest,
  c: Config,
  demoId: string,
) {
  return guestUploadsEnabled(db, c) && hasGuestUploadGrant(db, c, request, demoId)
    ? guestCapability(db, request, c)
    : null;
}

function guestCapability(db: Store, request: FastifyRequest, c: Config) {
  const raw = request.cookies[guestCookieName(c)];
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
  return (
    (db.one(
      'SELECT owner_id AS id,csrf,expires_at,delivery_retry_at FROM guest_sessions WHERE token_hash=? AND expires_at>?',
      digest(raw),
      now(),
    ) as GuestSession) || null
  );
}

export function confirmGuestDelivery(db: Store, guest: GuestSession) {
  if (guest.delivery_retry_at !== null)
    db.run('UPDATE guest_sessions SET delivery_retry_at=NULL WHERE owner_id=?', guest.id);
}

/** Temporary principals can own private files, but have no account, password,
 * identity or authenticated session. Only an expiring opaque capability reaches them. */
export async function guestRoutes(app: FastifyInstance, db: Store, c: Config) {
  app.post('/api/guest/session', async (request, reply) => {
    z.object({})
      .strict()
      .parse(request.body || {});
    const guest = db.transaction(() => {
      if (!guestUploadsEnabled(db, c)) throw new HttpError(403, 'Guest uploads are disabled.');
      if (request.user)
        throw new HttpError(409, 'You are already signed in. Upload from your library.');
      const reserveUploadTime = (browser: ReturnType<typeof requireSession<'anonymous'>>) =>
        reserveAnonymousTime(db, c, request, browser, now() + demoWriteTimeoutMs / 1000 + 30);
      if (request.guest) {
        const live = currentGuest(db, request, c);
        if (live?.id !== request.guest.id || live.csrf !== request.guest.csrf)
          throw new HttpError(401, 'Session expired. Refresh the page and try again.');
        confirmGuestDelivery(db, live);
        return {
          raw: null,
          csrf: live.csrf,
          expires_at: live.expires_at,
          browserGrant: request.authSession
            ? reserveUploadTime(requireSession(db, request, c, ['anonymous']))
            : null,
        };
      }
      const browser = requireSession(db, request, c, ['anonymous']);
      const time = now();
      const previous = db.one(
        'SELECT owner_id,expires_at,delivery_retry_at FROM guest_sessions WHERE browser_session_id=?',
        browser.id,
      );
      if (previous && previous.expires_at <= time) {
        // Normal guest expiry and file cleanup remain independent of issuance.
        db.run(
          'UPDATE guest_sessions SET browser_session_id=NULL WHERE owner_id=?',
          previous.owner_id,
        );
      } else if (previous) {
        // A browser grant cannot recover an old bearer. Replace an unconfirmed
        // empty capability once, after the original response has had time to arrive.
        if (
          previous.delivery_retry_at === null ||
          db.one('SELECT 1 FROM demos WHERE owner_id=? LIMIT 1', previous.owner_id)
        )
          throw new HttpError(
            429,
            'Too many requests. Try again later.',
            Math.max(1, browser.expires_at - time),
          );
        if (previous.delivery_retry_at > time)
          throw new HttpError(
            429,
            'Too many requests. Try again later.',
            previous.delivery_retry_at - time,
          );
        db.run('DELETE FROM users WHERE id=?', previous.owner_id);
      }
      chargeBudgets(db, request, [['guest-session', 10, 3600]]);
      if (
        db.one('SELECT count(*) AS count FROM guest_sessions')!.count >= 4096 &&
        !expireGuestBatch(db, c, 1)
      )
        return null;
      const raw = token(),
        id = token().slice(0, 32),
        csrf = token();
      const expires = time + c.guestRetentionHours * 3600;
      db.run('INSERT INTO users(id,username,created_at) VALUES(?,?,?)', id, '$guest_' + id, time);
      db.run(
        `INSERT INTO guest_sessions(owner_id,token_hash,csrf,expires_at,browser_session_id,delivery_retry_at)
         VALUES(?,?,?,?,?,?)`,
        id,
        digest(raw),
        csrf,
        expires,
        browser.id,
        previous && previous.expires_at > time ? null : time + guestDeliveryGrace,
      );
      return { raw, csrf, expires_at: expires, browserGrant: reserveUploadTime(browser) };
    });
    if (!guest)
      throw new HttpError(503, 'Guest upload capacity has been reached. Try again later.');
    const { raw, browserGrant, ...status } = guest;
    if (browserGrant) sendSession(c, reply, browserGrant);
    if (raw) {
      reply.setCookie(guestCookieName(c), raw, {
        httpOnly: true,
        secure: c.cookieSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: c.guestRetentionHours * 3600,
      });
      reply.code(201);
    }
    return status;
  });
}

/** Reclaim bounded batches during maintenance or one slot at the issuance ceiling. */
function expireGuestBatch(db: Store, c: Config, limit: number) {
  const expired = db.all(
    'SELECT owner_id FROM guest_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT ?',
    now(),
    limit,
  );
  for (const guest of expired) {
    enqueueUserDemoDeletion(db, c, guest.owner_id);
    db.run('DELETE FROM users WHERE id=?', guest.owner_id);
  }
  return expired.length;
}
export function cleanupExpiredGuests(db: Store, c: Config) {
  db.transaction(() => expireGuestBatch(db, c, 100));
}
