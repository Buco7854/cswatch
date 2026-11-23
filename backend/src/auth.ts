import { accountDisplayName, accountEmail, accountPassword } from './credentials.js';
import { accountEntry } from './auth-routes.js';
import type { AccountMail } from './account-mail.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from './db.js';
import { now } from './db.js';
import { emailDeliveryEnabled, type Config } from './config.js';
import { changeAccountEmail, requireAvailableEmail } from './email-identity.js';
import { acceptsHtml } from './request-security.js';
import { fetchSteamName } from './steam-name.js';
import { readUpstreamText } from './upstream.js';
import {
  activeUserSessions,
  canSignIn,
  confirmAnonymousSignOut,
  unlinkSteamIdentity,
  digest,
  equal,
  firstFactorStage,
  hasSecondFactor,
  hashPassword,
  HttpError,
  rateLimit,
  admitRequest,
  chargeBudgets,
  rateAddress,
  readSessionStatus,
  requireFreshSession,
  requireSession,
  retryAnonymousDelivery,
  revokeUserSessions,
  renewAfterIdentityChange,
  rotateSession,
  safeReturnPath,
  sendSession,
  steamStateCookie,
  token,
  verifyPassword,
} from './security.js';

const steamNamespace = 'http://specs.openid.net/auth/2.0';
const steamEndpoint = 'https://steamcommunity.com/openid/login';
const steamStateLifetime = 600;
const badCredentials = 'Username or password is incorrect.';
const changed = 'Session expired. Refresh the page and try again.';
const steamExpired = 'Sign-in expired. Start again.';
const login = z.strictObject({
  username: z.string().trim().min(1).max(254),
  password: accountPassword,
});
const registration = z.strictObject({
  email: accountEmail,
  display_name: accountDisplayName,
  password: accountPassword,
});
const profile = z.strictObject({
  email: accountEmail,
  display_name: accountDisplayName.optional(),
});
const empty = z.object({}).strict();

function registeredUsername(displayName: string) {
  const stem = displayName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return (stem || 'member') + '-' + token().slice(0, 16);
}

type SteamPurpose = 'login' | 'link' | 'step-up';
type SteamCallbackResult =
  | 'cancelled'
  | 'verification-cancelled'
  | 'verification-failed'
  | 'link-verification-failed'
  | 'registration-closed'
  | 'link-conflict';

class SteamCallbackError extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly result: 'registration-closed' | 'link-conflict',
  ) {
    super(status, message);
  }
}

export async function authRoutes(
  app: FastifyInstance,
  db: Store,
  c: Config,
  invalidateProviderCache: (userId: string) => void,
  mail?: AccountMail,
) {
  const policy = () => db.mfaRequiredRoles(c).join(',');
  app.get('/api/auth/me', accountEntry('status'), async (r, reply) => {
    if (r.authSession || r.method === 'HEAD') return readSessionStatus(db, c, r);
    if (['same-site', 'cross-site'].includes(r.headers['sec-fetch-site'] ?? ''))
      throw new HttpError(403, 'Request origin was rejected.');
    if (r.headers['x-browser-session-probe'] === '1') {
      return reply.code(204).header('X-Browser-Bootstrap-Required', '1').send();
    }
    admitRequest(db, r, [
      ['browser-bootstrap', 120, 60],
      ['browser-bootstrap-budget', 12000, 900, 'instance'],
    ]);
    const grant = db.transaction(
      () =>
        retryAnonymousDelivery(db, c, r) ??
        rotateSession(db, c, r, { userId: null, stage: 'anonymous' }),
    );
    return sendSession(c, reply, grant);
  });
  let registering = 0;
  app.post('/api/auth/register', accountEntry('anonymous'), async (r, reply) => {
    requireSession(db, r, c, ['anonymous']);
    if (!db.flag(c, 'registrations_enabled'))
      throw new HttpError(403, 'New registrations are disabled.');
    const body = registration.parse(r.body);
    if (registering >= 2) throw new HttpError(429, 'Too many requests. Try again later.', 1);
    admitRequest(db, r, [
      ['register', 5, 3600],
      ['registration-instance', 30, 60, 'instance'],
    ]);
    let hash: string;
    registering++;
    try {
      hash = await hashPassword(body.password);
    } finally {
      registering--;
    }
    const grant = db.transaction(() => {
      requireSession(db, r, c, ['anonymous']);
      if (!db.flag(c, 'registrations_enabled'))
        throw new HttpError(403, 'New registrations are disabled.');
      requireAvailableEmail(db, body.email);
      const id = token().slice(0, 32);
      db.run(
        `INSERT INTO users(id,username,password_hash,role,created_at,display_name,email,email_verification_required)
         VALUES(?,?,?,?,?,?,?,?)`,
        id,
        registeredUsername(body.display_name),
        hash,
        'member',
        now(),
        body.display_name,
        body.email,
        Number(emailDeliveryEnabled(db, c)),
      );
      db.audit(id, 'account.created', { target: id, address: r.clientAddress });
      return rotateSession(db, c, r, {
        userId: id,
        stage: firstFactorStage(db, c, id),
        proof: { kind: 'password' },
      });
    });
    mail?.queueVerification(grant.session.user_id!, r.headers['accept-language']);
    reply.code(201);
    return sendSession(c, reply, grant);
  });
  const passwordUser = (name: string) =>
    db.one(
      `SELECT id,username,role,password_hash,auth_generation FROM users u
     WHERE ${name.includes('@') ? 'email' : 'username'}=?
       AND NOT EXISTS(SELECT 1 FROM guest_sessions WHERE owner_id=u.id)`,
      name,
    );
  app.post('/api/auth/login', accountEntry('anonymous'), async (r, reply) => {
    requireSession(db, r, c, ['anonymous']);
    const b = login.parse(r.body);
    const before = passwordUser(b.username);
    const loginKey = before ? digest('account\0' + before.id) : digest(b.username.toLowerCase());
    const admitLogin = () =>
      admitRequest(db, r, [
        ['login-ip', 20, 900],
        ['login-user-address', 10, 900, digest(rateAddress(r.ip) + '\0' + loginKey)],
        ['login-username', 8, 5, loginKey],
        ['login-budget', 300, 60, 'instance'],
      ]);
    const oldPolicy = policy();
    if (!(await verifyPassword(before?.password_hash, b.password, admitLogin))) {
      db.audit(null, 'password.sign_in', { address: r.clientAddress, outcome: 'denied' });
      throw new HttpError(401, badCredentials);
    }
    const grant = db.transaction(() => {
      requireSession(db, r, c, ['anonymous']);
      const current = passwordUser(b.username);
      if (
        !before ||
        !current ||
        current.id !== before.id ||
        current.role !== before.role ||
        current.password_hash !== before.password_hash ||
        current.auth_generation !== before.auth_generation ||
        policy() !== oldPolicy
      )
        throw new HttpError(401, badCredentials);
      db.audit(current.id, 'password.sign_in', { target: current.id, address: r.clientAddress });
      return rotateSession(db, c, r, {
        userId: current.id,
        stage: firstFactorStage(db, c, current.id),
        proof: { kind: 'password' },
      });
    });
    return sendSession(c, reply, grant);
  });
  app.post('/api/auth/logout', accountEntry('logout'), async (r, reply) => {
    const { preserve_anonymous_operations } = empty
      .extend({ preserve_anonymous_operations: z.literal(true).optional() })
      .parse(r.body);
    const grant = db.transaction(() => {
      const current = requireSession(db, r, c, ['anonymous', 'challenge', 'enroll', 'full']);
      if (preserve_anonymous_operations) {
        if (current.stage !== 'anonymous') throw new HttpError(401, changed);
        return confirmAnonymousSignOut(db, c, current);
      }
      if (current.user_id)
        db.audit(current.user_id, 'session.signed_out', {
          target: current.user_id,
          address: r.clientAddress,
        });
      return rotateSession(db, c, r, { userId: null, stage: 'anonymous' });
    });
    if (r.user) invalidateProviderCache(r.user.id);
    return sendSession(c, reply, grant);
  });
  app.post('/api/auth/step-up/password', accountEntry('full', true), async (r, reply) => {
    const active = requireSession(db, r, c, ['full']);
    if (hasSecondFactor(db, active.user_id))
      throw new HttpError(403, 'Confirm using a second factor.');
    const body = z
      .object({ password: z.string().max(128) })
      .strict()
      .parse(r.body);
    admitRequest(db, r, [
      ['password-step-up-ip', 15, 900],
      ['password-step-up', 5, 900, active.user_id],
    ]);
    const old = db.one('SELECT password_hash FROM users WHERE id=?', active.user_id)?.password_hash;
    const previousPolicy = policy();
    if (!(await verifyPassword(old, body.password))) {
      db.audit(active.user_id, 'password.step_up', {
        target: active.user_id,
        address: r.clientAddress,
        outcome: 'denied',
      });
      throw new HttpError(401, 'Current password is incorrect.');
    }
    const grant = db.transaction(() => {
      const live = requireSession(db, r, c, ['full']);
      if (
        live.role !== active.role ||
        policy() !== previousPolicy ||
        hasSecondFactor(db, live.user_id) ||
        db.one('SELECT password_hash FROM users WHERE id=?', live.user_id)?.password_hash !== old
      )
        throw new HttpError(401, changed);
      db.audit(live.user_id, 'password.step_up', {
        target: live.user_id,
        address: r.clientAddress,
      });
      return rotateSession(db, c, r, {
        userId: live.user_id,
        stage: 'full',
        proof: { kind: 'password' },
      });
    });
    return sendSession(c, reply, grant);
  });
  app.post('/api/auth/password', async (r, reply) => {
    const active = requireFreshSession(db, r, c);
    rateLimit(db, r, 'password', 5, 900, active.user_id);
    const body = z.object({ new_password: accountPassword }).strict().parse(r.body);
    const old = db.one('SELECT password_hash FROM users WHERE id=?', active.user_id)?.password_hash;
    const previousPolicy = policy();
    const hash = await hashPassword(body.new_password);
    const grant = db.transaction(() => {
      const live = requireFreshSession(db, r, c);
      if (
        live.role !== active.role ||
        policy() !== previousPolicy ||
        db.one('SELECT password_hash FROM users WHERE id=?', live.user_id)?.password_hash !== old
      )
        throw new HttpError(409, changed);
      db.run('UPDATE users SET password_hash=? WHERE id=?', hash, live.user_id);
      revokeUserSessions(db, live.user_id);
      db.audit(live.user_id, 'password.changed', {
        target: live.user_id,
        address: r.clientAddress,
      });
      return rotateSession(db, c, r, {
        userId: live.user_id,
        stage: 'full',
        proof: { kind: live.proof_kind!, at: live.proof_at! },
      });
    });
    return sendSession(c, reply, grant);
  });

  app.post('/api/auth/profile', accountEntry('full', true), async (r, reply) => {
    const active = requireFreshSession(db, r, c);
    const body = profile.parse(r.body);
    rateLimit(db, r, 'account-profile', 10, 900, active.user_id);
    const result = db.transaction(() => {
      const live = requireFreshSession(db, r, c);
      if (Boolean(live.profile_required) !== (body.display_name !== undefined))
        throw new HttpError(400, 'Check the form fields and try again.');
      const emailChanged = changeAccountEmail(db, live.user_id, body.email);
      if (!emailChanged && !live.profile_required) return null;
      if (live.profile_required)
        db.run(
          'UPDATE users SET display_name=?,profile_required=0 WHERE id=?',
          body.display_name,
          live.user_id,
        );
      db.audit(
        live.user_id,
        live.profile_required ? 'account.profile_completed' : 'account.email_changed',
        {
          target: live.user_id,
          address: r.clientAddress,
        },
      );
      return { emailChanged, grant: renewAfterIdentityChange(db, c, r, live) };
    });
    if (!result) return readSessionStatus(db, c, r);
    if (result.emailChanged) mail?.queueVerification(active.user_id, r.headers['accept-language']);
    return sendSession(c, reply, result.grant);
  });

  app.get('/api/auth/sessions', async (r) => {
    const active = requireSession(db, r, c, ['full']);
    return {
      sessions: activeUserSessions(db, active.user_id).map((row) => ({
        ...row,
        current: row.id === active.id,
      })),
    };
  });
  app.delete('/api/auth/sessions/:id', async (r, reply) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse((r.params as { id: string }).id);
    const grant = db.transaction(() => {
      const live = requireSession(db, r, c, ['full']);
      if (id !== live.id) requireFreshSession(db, r, c);
      if (!db.run('DELETE FROM sessions WHERE id=? AND user_id=?', id, live.user_id).changes)
        throw new HttpError(404, 'Session not found.');
      db.audit(live.user_id, 'session.revoked', { target: live.user_id, address: r.clientAddress });
      return id === live.id ? rotateSession(db, c, r, { userId: null, stage: 'anonymous' }) : null;
    });
    return grant ? sendSession(c, reply, grant) : { ok: true };
  });
  app.post('/api/auth/sessions/revoke-all', async (r, reply) => {
    empty.parse(r.body);
    const grant = db.transaction(() => {
      const live = requireFreshSession(db, r, c);
      revokeUserSessions(db, live.user_id);
      db.audit(live.user_id, 'session.revoked_all', {
        target: live.user_id,
        address: r.clientAddress,
      });
      return rotateSession(db, c, r, { userId: null, stage: 'anonymous' });
    });
    return sendSession(c, reply, grant);
  });

  const steamSubject = (userId: string) =>
    db.one("SELECT subject FROM identities WHERE provider='steam' AND user_id=?", userId)
      ?.subject ?? null;
  const steamAccount = (subject: string) =>
    db.one(
      `SELECT u.id,u.role,u.password_hash,u.auth_generation FROM identities i JOIN users u ON u.id=i.user_id
      WHERE i.provider='steam' AND i.subject=?
      AND NOT EXISTS (SELECT 1 FROM guest_sessions WHERE owner_id=u.id)`,
      subject,
    );
  function requireSteam() {
    if (!db.flag(c, 'steam_enabled')) throw new HttpError(403, 'Steam sign-in is disabled.');
  }
  let steamVerifications = 0;
  function startSteam(
    r: FastifyRequest,
    reply: FastifyReply,
    purpose: SteamPurpose,
    returnTo: unknown,
  ) {
    const state = token();
    db.transaction(() => {
      requireSteam();
      const session =
        purpose === 'link'
          ? requireFreshSession(db, r, c)
          : purpose === 'step-up'
            ? requireSession(db, r, c, ['full'])
            : requireSession(db, r, c, ['anonymous']);
      const subject = session.user_id ? steamSubject(session.user_id) : null;
      if (purpose === 'step-up' && (!subject || hasSecondFactor(db, session.user_id!)))
        throw new HttpError(403, 'Confirm your identity with another sign-in method.');
      chargeBudgets(db, r, [
        ['steam', 20, 900],
        ['steam-browser-start', 12, steamStateLifetime, session.id],
        ['steam-instance', 150, 60, 'instance'],
      ]);
      db.run(
        'DELETE FROM auth_states WHERE expires_at<=? OR session_hash=?',
        now(),
        session.token_hash,
      );
      db.run(
        'INSERT INTO auth_states(token_hash,user_id,session_hash,expires_at,return_to,purpose,subject,policy) VALUES(?,?,?,?,?,?,?,?)',
        digest(state),
        session.user_id,
        session.token_hash,
        now() + steamStateLifetime,
        safeReturnPath(returnTo),
        purpose,
        subject,
        policy(),
      );
    });
    const params = new URLSearchParams({
      'openid.ns': steamNamespace,
      'openid.mode': 'checkid_setup',
      'openid.return_to': `${c.appUrl}/api/auth/steam/callback?state=${state}`,
      'openid.realm': c.appUrl,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    const stateCookie = steamStateCookie(c, state);
    reply.setCookie(stateCookie.name, state, {
      httpOnly: true,
      secure: c.cookieSecure,
      sameSite: 'lax',
      path: stateCookie.path,
      maxAge: steamStateLifetime,
    });
    return { location: steamEndpoint + '?' + params };
  }

  app.post('/api/auth/steam', accountEntry('anonymous'), async (r, reply) => {
    const body = z
      .object({ return_to: z.string().max(1024).optional() })
      .strict()
      .parse(r.body);
    return startSteam(r, reply, 'login', body.return_to);
  });
  app.post('/api/auth/steam/link', async (r, reply) => {
    empty.parse(r.body);
    return startSteam(r, reply, 'link', '/account/connections');
  });
  app.post('/api/auth/step-up/steam', accountEntry('full', true), async (r, reply) => {
    const body = z
      .object({ return_to: z.string().max(1024).optional() })
      .strict()
      .parse(r.body);
    return startSteam(r, reply, 'step-up', body.return_to ?? '/account');
  });
  app.delete('/api/auth/steam/link', async (r, reply) => {
    const grant = db.transaction(() => {
      const live = requireFreshSession(db, r, c);
      unlinkSteamIdentity(db, live.user_id);
      if (!canSignIn(db, c, live.user_id))
        throw new HttpError(409, 'Add a password or passkey before disconnecting Steam.');
      db.audit(live.user_id, 'steam.unlinked', { target: live.user_id, address: r.clientAddress });
      revokeUserSessions(db, live.user_id);
      return rotateSession(db, c, r, {
        userId: live.user_id,
        stage: 'full',
        proof:
          live.proof_kind === 'steam' ? undefined : { kind: live.proof_kind!, at: live.proof_at! },
      });
    });
    return sendSession(c, reply, grant);
  });
  app.get(
    '/api/auth/steam/callback',
    { ...accountEntry('anonymous', true), exposeHeadRoute: false },
    async (r, reply) => {
      requireSteam();
      const q = z.record(z.string(), z.string()).parse(r.query),
        state = q.state || '';
      const stateCookie = steamStateCookie(c, state);
      if (!/^[a-f0-9]{64}$/.test(state) || !equal(state, r.cookies[stateCookie.name] || ''))
        throw new HttpError(400, 'Invalid sign-in state. Start again.');
      const stateHash = digest(state);
      const checkState = () => {
        const stored = db.one(
          'SELECT * FROM auth_states WHERE token_hash=? AND expires_at>?',
          stateHash,
          now(),
        );
        if (!stored || stored.policy !== policy()) throw new HttpError(400, steamExpired);
        const live =
          stored.purpose === 'link'
            ? requireFreshSession(db, r, c)
            : stored.purpose === 'step-up'
              ? requireSession(db, r, c, ['full'])
              : requireSession(db, r, c, ['anonymous']);
        if (
          live.token_hash !== stored.session_hash ||
          live.user_id !== stored.user_id ||
          (live.user_id && stored.subject !== steamSubject(live.user_id)) ||
          (stored.purpose === 'step-up' && hasSecondFactor(db, live.user_id!))
        )
          throw new HttpError(400, steamExpired);
        return { stored, live };
      };
      const initial = db.transaction(() => {
        const checked = checkState();
        if (
          !db.run('UPDATE auth_states SET claimed=1 WHERE token_hash=? AND claimed=0', stateHash)
            .changes
        )
          throw new HttpError(400, steamExpired);
        if (q['openid.mode'] === 'cancel')
          db.run('DELETE FROM auth_states WHERE token_hash=?', stateHash);
        return checked;
      });
      const resultPath = (result: SteamCallbackResult) => {
        const returnTo = safeReturnPath(initial.stored.return_to);
        if (initial.stored.purpose === 'login')
          return '/login?' + new URLSearchParams({ steam: result, returnTo });
        const url = new URL(returnTo, c.appUrl);
        url.searchParams.set('steam', result);
        return url.pathname + url.search + url.hash;
      };
      // The claim has already spent the state. Let the cookie expire so this
      // callback's response cannot clear a newer attempt's cookie.
      if (q['openid.mode'] === 'cancel') {
        const result =
          initial.stored.purpose === 'step-up' ? 'verification-cancelled' : 'cancelled';
        return reply.redirect(resultPath(result), 303);
      }

      try {
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
          ].every((key) => signed.has(key)) ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ[!-~]{0,235}$/.test(responseNonce) ||
          !Number.isFinite(nonce) ||
          new Date(nonce).toISOString().replace('.000Z', 'Z') !== timestamp ||
          Math.abs(Date.now() - nonce) >= steamStateLifetime * 1000 ||
          db.one('SELECT 1 FROM steam_nonces WHERE nonce_hash=? AND expires_at>?', nonceHash, now())
        )
          throw new HttpError(400, 'Steam returned an invalid identity.');

        const identity = steamAccount(subject);
        if (steamVerifications >= 8)
          throw new HttpError(429, 'Too many requests. Try again later.', 5);
        let steamName: string | null = null;
        steamVerifications++;
        try {
          await verifySteam(q);
          if (
            initial.stored.purpose === 'login' &&
            !identity &&
            db.flag(c, 'registrations_enabled')
          ) {
            requireSteam();
            checkState();
            steamName = await fetchSteamName(subject, c.steamApiKey);
          }
        } finally {
          steamVerifications--;
        }
        const grant = db.transaction(() => {
          requireSteam();
          const { stored, live } = checkState();
          if (Math.abs(Date.now() - nonce) >= steamStateLifetime * 1000)
            throw new HttpError(400, steamExpired);
          const current = steamAccount(subject);
          if (
            identity?.id !== current?.id ||
            identity?.role !== current?.role ||
            identity?.auth_generation !== current?.auth_generation ||
            identity?.password_hash !== current?.password_hash
          )
            throw new HttpError(400, steamExpired);
          db.run('DELETE FROM auth_states WHERE token_hash=?', stateHash);
          db.run('DELETE FROM steam_nonces WHERE expires_at<=?', now());
          if (
            !db.run(
              'INSERT OR IGNORE INTO steam_nonces VALUES(?,?)',
              nonceHash,
              nonce / 1000 + steamStateLifetime,
            ).changes
          )
            throw new HttpError(400, 'Steam returned an invalid identity.');
          if (stored.purpose === 'step-up') {
            if (stored.subject !== subject || current?.id !== live.user_id) {
              db.audit(live.user_id, 'steam.step_up', {
                target: live.user_id,
                address: r.clientAddress,
                outcome: 'denied',
              });
              return null;
            }
            db.audit(live.user_id, 'steam.step_up', {
              target: live.user_id,
              address: r.clientAddress,
            });
            return rotateSession(db, c, r, {
              userId: live.user_id!,
              stage: 'full',
              proof: { kind: 'steam' },
            });
          }
          if (stored.purpose === 'link') {
            if (current && current.id !== live.user_id)
              throw new SteamCallbackError(
                409,
                'This Steam account is already linked to another account.',
                'link-conflict',
              );
            if (stored.subject && stored.subject !== subject)
              throw new SteamCallbackError(
                409,
                'Your account has a different Steam identity.',
                'link-conflict',
              );
            db.run("INSERT OR IGNORE INTO identities VALUES('steam',?,?)", subject, live.user_id);
            db.audit(live.user_id, 'steam.linked', {
              target: live.user_id,
              address: r.clientAddress,
            });
            return renewAfterIdentityChange(db, c, r, requireFreshSession(db, r, c));
          }
          const id = current?.id ?? token().slice(0, 32);
          if (!current) {
            if (!db.flag(c, 'registrations_enabled'))
              throw new SteamCallbackError(
                403,
                'New registrations are disabled.',
                'registration-closed',
              );
            db.run(
              `INSERT INTO users(id,username,role,created_at,display_name,profile_required,email_verification_required)
               VALUES(?,?,?,?,?,1,?)`,
              id,
              'steam_' + subject + '-' + token().slice(0, 16),
              'member',
              now(),
              steamName,
              Number(emailDeliveryEnabled(db, c)),
            );
            db.run("INSERT INTO identities VALUES('steam',?,?)", subject, id);
          }
          db.audit(id, 'steam.authenticated', { target: id, address: r.clientAddress });
          return rotateSession(db, c, r, {
            userId: id,
            stage: firstFactorStage(db, c, id),
            proof: { kind: 'steam' },
          });
        });
        const returnTo = safeReturnPath(initial.stored.return_to);
        if (!grant) return reply.redirect(resultPath('verification-failed'), 303);
        const status = sendSession(c, reply, grant);
        return reply.redirect(
          status.session.stage === 'challenge'
            ? '/login?' + new URLSearchParams({ returnTo })
            : status.session.stage === 'enroll' ||
                status.user?.profile_required ||
                status.user?.email_verification_required
              ? '/account?' + new URLSearchParams({ returnTo })
              : returnTo,
          303,
        );
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          (initial.stored.purpose !== 'step-up' && !acceptsHtml(r))
        )
          throw error;
        const result = db.transaction(() => {
          // An upstream reply can arrive after the browser replaced this attempt.
          requireSteam();
          const { stored, live } = checkState();
          db.run('DELETE FROM auth_states WHERE token_hash=?', stateHash);
          if (stored.purpose === 'step-up') {
            db.audit(live.user_id, 'steam.step_up', {
              target: live.user_id,
              address: r.clientAddress,
              outcome: 'denied',
            });
          }
          return error instanceof SteamCallbackError
            ? error.result
            : stored.purpose === 'link'
              ? 'link-verification-failed'
              : 'verification-failed';
        });
        return reply.redirect(resultPath(result), 303);
      }
    },
  );
}

async function verifySteam(q: Record<string, string>) {
  const verification = new URLSearchParams(
    Object.entries(q).filter(([key]) => key.startsWith('openid.')),
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
    if (fields.get('ns') !== steamNamespace || fields.get('is_valid') !== 'true') throw new Error();
  } catch {
    throw new HttpError(400, 'Steam could not verify this sign-in. Try again.');
  }
}
