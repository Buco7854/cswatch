import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from './db.js';
import { now } from './db.js';
import type { Config } from './config.js';
import { readUpstreamText } from './upstream.js';
import {
  HttpError,
  currentUser,
  digest,
  equal,
  hashPassword,
  newSession,
  rateLimit,
  requireUser,
  token,
  verifyPassword,
  safeReturnPath,
  sessionCookieName,
  steamStateCookie,
} from './security.js';
const steamNamespace = 'http://specs.openid.net/auth/2.0';
const steamEndpoint = 'https://steamcommunity.com/openid/login';
const steamStateLifetime = 600;
const credentials = z.object({
  username: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/),
  password: z.string().min(12).max(128),
});
export async function authRoutes(app: FastifyInstance, db: Store, c: Config) {
  app.get('/api/auth/me', async (r) => ({
    user: r.user
      ? {
          ...r.user,
          identities: db.all('SELECT provider,subject FROM identities WHERE user_id=?', r.user.id),
        }
      : null,
    guest_session: r.guest ? { csrf: r.guest.csrf, expires_at: r.guest.expires_at } : null,
  }));
  app.post('/api/auth/register', async (r, reply) => {
    if (!db.flag(c, 'registrations_enabled'))
      throw new HttpError(403, 'New registrations are disabled.');
    rateLimit(db, r, 'register', 5, 3600);
    const body = credentials.parse(r.body),
      id = token().slice(0, 32),
      hash = await hashPassword(body.password);
    try {
      db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, body.username, hash, 0, now());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new HttpError(409, 'That username is unavailable.');
      throw e;
    }
    const csrf = newSession(db, c, r, reply, id);
    db.audit(id, 'account.created');
    reply.code(201);
    return { user: { id, username: body.username, is_admin: false, csrf } };
  });
  app.post('/api/auth/login', async (r, reply) => {
    const b = credentials.parse(r.body);
    rateLimit(db, r, 'login-ip', 20);
    rateLimit(db, r, 'login-user', 10, 900, b.username.toLowerCase());
    const u = db.one(
      'SELECT * FROM users u WHERE username=? COLLATE NOCASE AND NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id)',
      b.username,
    );
    if (!(await verifyPassword(u?.password_hash, b.password)))
      throw new HttpError(401, 'Username or password is incorrect.');
    // Password verification yields. Revoked credentials cannot issue a session
    // afterward, and account details must come from the current immutable user.
    const current = db.one(
      'SELECT id,username,password_hash,is_admin FROM users u WHERE id=? AND NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id)',
      u!.id,
    );
    if (!current || current.password_hash !== u!.password_hash)
      throw new HttpError(401, 'Username or password is incorrect.');
    const csrf = newSession(db, c, r, reply, current.id);
    return {
      user: {
        id: current.id,
        username: current.username,
        is_admin: Boolean(current.is_admin),
        csrf,
      },
    };
  });
  app.post('/api/auth/logout', async (r, reply) => {
    const cookie = sessionCookieName(c);
    db.run('DELETE FROM sessions WHERE token_hash=?', digest(r.cookies[cookie] || ''));
    reply.clearCookie(cookie, {
      path: '/',
      secure: c.cookieSecure,
      httpOnly: true,
      sameSite: 'lax',
    });
    return { ok: true };
  });
  app.post('/api/auth/password', async (r, reply) => {
    const u = requireUser(r);
    rateLimit(db, r, 'password', 5, 900, u.id);
    const b = z
      .object({ current_password: z.string().max(128), new_password: z.string().min(12).max(128) })
      .parse(r.body);
    const old = db.one('SELECT password_hash FROM users WHERE id=?', u.id)!;
    if (old.password_hash && !(await verifyPassword(old.password_hash, b.current_password)))
      throw new HttpError(400, 'Current password is incorrect.');
    const hash = await hashPassword(b.new_password);
    db.transaction(() => {
      // Hashing yields to other requests. A logout, account switch or another
      // password change must revoke this captured mutation before it can
      // replace credentials or create a fresh session.
      const active = currentUser(db, r, c);
      if (!active || active.id !== u.id || active.csrf !== u.csrf)
        throw new HttpError(401, 'Session expired. Refresh the page and try again.');
      if (
        db.one('SELECT password_hash FROM users WHERE id=?', u.id)?.password_hash !==
        old.password_hash
      )
        throw new HttpError(409, 'Session expired. Refresh the page and try again.');
      db.run('UPDATE users SET password_hash=? WHERE id=?', hash, u.id);
      db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    });
    const csrf = newSession(db, c, r, reply, u.id);
    db.audit(u.id, 'password.changed');
    return { csrf };
  });
  function startSteam(r: FastifyRequest, reply: FastifyReply, returnTo: unknown) {
    if (!db.flag(c, 'steam_enabled')) throw new HttpError(403, 'Steam sign-in is disabled.');
    rateLimit(db, r, 'steam', 20);
    const state = token();
    db.run('DELETE FROM auth_states WHERE expires_at<?', now());
    db.run(
      'INSERT INTO auth_states(token_hash,user_id,session_hash,expires_at,return_to) VALUES(?,?,?,?,?)',
      digest(state),
      r.user?.id ?? null,
      r.user ? digest(r.cookies[sessionCookieName(c)]!) : null,
      now() + steamStateLifetime,
      safeReturnPath(returnTo, '/library'),
    );
    const params = new URLSearchParams({
      'openid.ns': steamNamespace,
      'openid.mode': 'checkid_setup',
      'openid.return_to': `${c.appUrl}/api/auth/steam/callback?state=${state}`,
      'openid.realm': c.appUrl,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    const stateCookie = steamStateCookie(c);
    reply.setCookie(stateCookie.name, state, {
      httpOnly: true,
      secure: c.cookieSecure,
      sameSite: 'lax',
      path: stateCookie.path,
      maxAge: steamStateLifetime,
    });
    return steamEndpoint + '?' + params;
  }
  app.get('/api/auth/steam', async (r, reply) => {
    if (r.user) throw new HttpError(409, 'Link Steam from Connected accounts.');
    return reply.redirect(startSteam(r, reply, (r.query as { returnTo?: string }).returnTo), 303);
  });
  app.post('/api/auth/steam/link', async (r, reply) => {
    requireUser(r);
    return { location: startSteam(r, reply, '/account/connections') };
  });
  app.get('/api/auth/steam/callback', async (r, reply) => {
    if (!db.flag(c, 'steam_enabled')) throw new HttpError(403, 'Steam sign-in is disabled.');
    const q = z.record(z.string(), z.string()).parse(r.query),
      state = q.state || '';
    if (!state || !equal(state, r.cookies[steamStateCookie(c).name] || ''))
      throw new HttpError(400, 'Invalid sign-in state. Start again.');
    const stored = db.transaction(() => {
      const s = db.one(
        'SELECT * FROM auth_states WHERE token_hash=? AND expires_at>?',
        digest(state),
        now(),
      );
      db.run('DELETE FROM auth_states WHERE token_hash=?', digest(state));
      return s;
    });
    if (!stored) throw new HttpError(400, 'Sign-in expired. Start again.');
    const stateCookie = steamStateCookie(c);
    reply.clearCookie(stateCookie.name, {
      path: stateCookie.path,
      secure: c.cookieSecure,
      httpOnly: true,
      sameSite: 'lax',
    });
    const checkSession = () => {
      const user = currentUser(db, r, c);
      if (
        (user?.id ?? null) !== stored.user_id ||
        (user && digest(r.cookies[sessionCookieName(c)]!) !== stored.session_hash)
      )
        throw new HttpError(400, 'The linking session changed. Start again.');
    };
    checkSession();
    if (q['openid.mode'] === 'cancel') {
      const destination = stored.user_id
        ? '/account/connections?steam=cancelled'
        : '/login?' +
          new URLSearchParams({
            steam: 'cancelled',
            returnTo: safeReturnPath(stored.return_to),
          });
      return reply.redirect(destination, 303);
    }
    const claimed = q['openid.claimed_id'] || '';
    const subject = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed)?.[1];
    const signed = new Set((q['openid.signed'] || '').split(','));
    const responseNonce = q['openid.response_nonce'] || '';
    const timestamp = responseNonce.slice(0, 20);
    const nonce = Date.parse(timestamp);
    const nonceHash = digest(responseNonce);
    if (
      q['openid.mode'] !== 'id_res' ||
      q['openid.ns'] !== steamNamespace ||
      q['openid.op_endpoint'] !== steamEndpoint ||
      q['openid.return_to'] !== `${c.appUrl}/api/auth/steam/callback?state=${state}` ||
      q['openid.identity'] !== claimed ||
      !subject ||
      !q['openid.assoc_handle'] ||
      !q['openid.sig'] ||
      ![
        'op_endpoint',
        'return_to',
        'response_nonce',
        'assoc_handle',
        'claimed_id',
        'identity',
      ].every((k) => signed.has(k)) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ[!-~]{0,235}$/.test(responseNonce) ||
      !Number.isFinite(nonce) ||
      new Date(nonce).toISOString().replace('.000Z', 'Z') !== timestamp ||
      Math.abs(Date.now() - nonce) >= steamStateLifetime * 1000 ||
      db.one('SELECT 1 FROM steam_nonces WHERE nonce_hash=? AND expires_at>?', nonceHash, now())
    )
      throw new HttpError(400, 'Steam returned an invalid identity.');
    const verification = new URLSearchParams(
      Object.entries(q).filter(([k]) => k.startsWith('openid.')),
    );
    verification.set('openid.mode', 'check_authentication');
    try {
      const result = await fetch(steamEndpoint, {
        method: 'POST',
        body: verification,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!result.ok) {
        await result.body?.cancel();
        throw new Error();
      }
      const fields = new Map<string, string>();
      for (const line of (await readUpstreamText(result, 16384)).split(/\r?\n/)) {
        if (!line) continue;
        const colon = line.indexOf(':');
        const key = line.slice(0, colon);
        if (colon < 1 || fields.has(key)) throw new Error();
        fields.set(key, line.slice(colon + 1));
      }
      if (fields.get('ns') !== steamNamespace || fields.get('is_valid') !== 'true')
        throw new Error();
    } catch {
      throw new HttpError(400, 'Steam could not verify this sign-in. Try again.');
    }
    const uid = db.transaction(() => {
      checkSession();
      if (!db.flag(c, 'steam_enabled')) throw new HttpError(403, 'Steam sign-in is disabled.');
      if (stored.expires_at <= now() || Math.abs(Date.now() - nonce) >= steamStateLifetime * 1000)
        throw new HttpError(400, 'Sign-in expired. Start again.');
      db.run('DELETE FROM steam_nonces WHERE expires_at<=?', now());
      if (
        !db.run(
          'INSERT OR IGNORE INTO steam_nonces VALUES(?,?)',
          nonceHash,
          nonce / 1000 + steamStateLifetime,
        ).changes
      )
        throw new HttpError(400, 'Steam returned an invalid identity.');
      const identity = db.one(
        "SELECT user_id FROM identities WHERE provider='steam' AND subject=?",
        subject,
      );
      if (identity && stored.user_id && identity.user_id !== stored.user_id)
        throw new HttpError(409, 'This Steam account is already linked to another account.');
      let id = stored.user_id || identity?.user_id;
      if (!id) {
        if (!db.flag(c, 'registrations_enabled'))
          throw new HttpError(403, 'New registrations are disabled.');
        id = token().slice(0, 32);
        const base = 'steam_' + subject;
        const username = db.one('SELECT id FROM users WHERE username=? COLLATE NOCASE', base)
          ? `${base}_${token().slice(0, 8)}`
          : base;
        db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, username, null, 0, now());
      }
      const linked = db.one(
        "SELECT subject FROM identities WHERE provider='steam' AND user_id=?",
        id,
      );
      if (linked && linked.subject !== subject)
        throw new HttpError(409, 'Your account has a different Steam identity.');
      db.run("INSERT OR IGNORE INTO identities VALUES('steam',?,?)", subject, id);
      return id as string;
    });
    newSession(db, c, r, reply, uid);
    db.audit(uid, 'steam.authenticated');
    return reply.redirect(safeReturnPath(stored.return_to), 303);
  });
}
