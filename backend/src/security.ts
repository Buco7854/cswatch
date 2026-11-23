import { matchSources } from './match-library.js';
import { allowedAccountOnboarding } from './auth-routes.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalAddress } from './admin-network.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as argon2 from 'argon2';
import type { Store } from './db.js';
import { now } from './db.js';
import { emailDeliveryEnabled, type Config } from './config.js';
import { HttpError } from './errors.js';
import type { Role } from './roles.js';

export { HttpError } from './errors.js';
export const COOKIE = 'cswatch_session';
export const sessionCookieName = (config: Pick<Config, 'cookieSecure'>) =>
  config.cookieSecure ? '__Host-cswatch_session' : COOKIE;
export const browserCookieName = (config: Pick<Config, 'cookieSecure'>) =>
  config.cookieSecure ? '__Host-cswatch_browser' : 'cswatch_browser';
export const browserBindingCookieName = (config: Pick<Config, 'cookieSecure'>) =>
  config.cookieSecure ? '__Host-cswatch_browser_binding' : 'cswatch_browser_binding';
export function steamStateCookie(config: Pick<Config, 'cookieSecure'>, state: string) {
  const prefix = config.cookieSecure ? '__Host-cswatch_steam_state_' : 'steam_state_';
  return { name: prefix + digest(state).slice(0, 32), path: '/' };
}
export const token = () => randomBytes(32).toString('hex');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

type AccountSessionStage = 'challenge' | 'enroll' | 'full';
type SessionStage = 'anonymous' | AccountSessionStage;
type ProofKind = 'password' | 'steam' | 'passkey' | 'totp';
type SessionFields = {
  id: string;
  token_hash: string;
  browser_hash: string | null;
  csrf: string;
  generation: number;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  proof_at: number | null;
  proof_kind: ProofKind | null;
  address: string | null;
  device: string;
};
type AccountOnboardingFields = {
  email_verified_at: number | null;
  profile_required: number;
  email_verification_required: number;
};
type AccountFields = AccountOnboardingFields & {
  has_password: number;
  user_id: string;
  role: Role;
  username: string;
  display_name: string;
  email: string | null;
};
export type Session =
  | (SessionFields & {
      stage: 'anonymous';
      user_id: null;
      role: null;
      username: null;
      display_name: null;
    })
  | {
      [Stage in AccountSessionStage]: SessionFields & AccountFields & { stage: Stage };
    }[AccountSessionStage];
type SessionOf<Stage extends SessionStage> = Extract<Session, { stage: Stage }>;
type SessionGrant = {
  raw?: string;
  browserBinding?: string;
  session: Session;
  factors: SessionFactors | null;
  proofFresh: boolean;
  identities: SessionIdentity[];
  matchSources: ReturnType<typeof matchSources> | null;
  emailVerificationRequired: boolean;
};
type SessionIdentity = { provider: string; subject: string };
type SessionFactors = { passkey: boolean; totp: boolean; recovery: boolean };
export type SessionUser = {
  id: string;
  has_password: boolean;
  username: string;
  display_name: string;
  role: Role;
  csrf: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    authSession: Session | null;
    clientAddress: string | null;
  }
}

const idleLifetime = 86400;
const proofLifetime = 300;
const pendingLifetime = 600;
const anonymousLifetime = 900;
const anonymousAbsoluteLifetime = 2 * anonymousLifetime;
const anonymousDeliveryGrace = 60;
const sessionLimit = 32;
const passwordWorkLimit = 6;
const expiredMessage = 'Session expired. Refresh the page and try again.';
let passwordWork = 0;
let auxiliaryPasswordWork = 0;

async function runPasswordWork<T>(fn: () => Promise<T>, login = false): Promise<T> {
  if (
    passwordWork >= passwordWorkLimit ||
    (!login && auxiliaryPasswordWork >= passwordWorkLimit - 2)
  )
    throw new HttpError(429, 'Too many requests. Try again later.');
  passwordWork += 1;
  if (!login) auxiliaryPasswordWork++;
  try {
    return await fn();
  } finally {
    passwordWork -= 1;
    if (!login) auxiliaryPasswordWork--;
  }
}
export const hashPassword = (password: string, admit?: () => void) =>
  runPasswordWork(() => {
    admit?.();
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 2,
    });
  });
const dummy = hashPassword(token());
export async function verifyPassword(
  hash: string | null | undefined,
  password: string,
  admitLogin?: () => void,
) {
  const verifier = hash || (await dummy);
  return runPasswordWork(async () => {
    admitLogin?.();
    try {
      return (await argon2.verify(verifier, password)) && Boolean(hash);
    } catch {
      return false;
    }
  }, Boolean(admitLogin));
}

export function hasSecondFactor(db: Store, userId: string) {
  return Boolean(
    db.one(
      'SELECT 1 FROM auth_passkeys WHERE user_id=? UNION ALL SELECT 1 FROM auth_totp WHERE user_id=? LIMIT 1',
      userId,
      userId,
    ),
  );
}

export function canSignIn(db: Store, config: Config, userId: string) {
  return Boolean(
    db.one(
      `SELECT 1 FROM users u WHERE u.id=?
      AND NOT EXISTS (SELECT 1 FROM guest_sessions WHERE owner_id=u.id)
      AND (password_hash IS NOT NULL
        OR EXISTS (SELECT 1 FROM auth_passkeys WHERE user_id=u.id)
        OR (? AND EXISTS (SELECT 1 FROM identities WHERE provider='steam' AND user_id=u.id)))`,
      userId,
      Number(db.flag(config, 'steam_enabled')),
    ),
  );
}

export function hasSteamOnlyAccounts(db: Store) {
  return Boolean(
    db.one(
      `SELECT 1 FROM identities i JOIN users u ON u.id=i.user_id
       WHERE i.provider='steam' AND u.password_hash IS NULL
         AND NOT EXISTS (SELECT 1 FROM auth_passkeys WHERE user_id=u.id)
         AND NOT EXISTS (SELECT 1 FROM guest_sessions WHERE owner_id=u.id)
       LIMIT 1`,
    ),
  );
}

export function unlinkSteamIdentity(db: Store, id: string) {
  db.run("DELETE FROM identities WHERE provider IN ('steam','faceit') AND user_id=?", id);
  db.run('DELETE FROM steam_history WHERE user_id=?', id);
  db.run('DELETE FROM steam_matches WHERE user_id=?', id);
}

export function signableAdminExists(db: Store, config: Config) {
  const admins = db.all(
    `SELECT id,profile_required,email_verification_required,email_verified_at FROM users
     WHERE role='admin'`,
  ) as (AccountOnboardingFields & { id: string })[];
  return admins.some(
    (admin) => !requiresAccountSetup(db, config, admin) && canSignIn(db, config, admin.id),
  );
}

export function firstFactorStage(db: Store, config: Config, userId: string): AccountSessionStage {
  const user = db.one('SELECT role FROM users WHERE id=?', userId);
  if (!user) throw new HttpError(401, expiredMessage);
  if (hasSecondFactor(db, userId)) return 'challenge';
  return db.mfaRequiredRoles(config).includes(user.role) ? 'enroll' : 'full';
}

const sessionSelect = `SELECT s.*,b.browser_hash,u.role,u.username,(u.password_hash IS NOT NULL) AS has_password,coalesce(u.display_name,u.username) AS display_name,
  u.email,u.email_verified_at,u.profile_required,u.email_verification_required
  FROM sessions s LEFT JOIN users u ON u.id=s.user_id
  LEFT JOIN session_browser_bindings b ON b.session_hash=s.token_hash
  WHERE s.token_hash=?
  AND (s.user_id IS NULL OR
    (s.generation=u.auth_generation AND NOT EXISTS(SELECT 1 FROM guest_sessions WHERE owner_id=u.id)))`;

export function currentSession(db: Store, request: FastifyRequest, config: Config): Session | null {
  for (const [name, anonymous] of [
    [sessionCookieName(config), false],
    [browserCookieName(config), true],
  ] as const) {
    const raw = request.cookies[name];
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) continue;
    const session = db.one(sessionSelect, digest(raw)) as Session | undefined;
    if (
      session &&
      (session.stage === 'anonymous') === anonymous &&
      activeSession(db, config, session)
    )
      return session;
  }
  return null;
}
export function sessionDeadline(session: Session) {
  return Math.min(session.expires_at, session.last_used_at + idleLifetime);
}

function activeSession(db: Store, config: Config, session: Session) {
  if (sessionDeadline(session) <= now()) return false;
  if (
    session.stage === 'full' &&
    db.mfaRequiredRoles(config).includes(session.role) &&
    !hasSecondFactor(db, session.user_id)
  )
    return false;
  if (
    (session.stage === 'challenge' || session.stage === 'enroll') &&
    session.proof_kind === 'steam' &&
    (!db.flag(config, 'steam_enabled') ||
      !db.one("SELECT 1 FROM identities WHERE provider='steam' AND user_id=?", session.user_id))
  )
    return false;
  return true;
}

export function touchSession(db: Store, session: Session, config: Config) {
  if (session.stage !== 'full' || session.last_used_at > now() - 60) return;
  db.transaction(() => {
    const live = db.one(sessionSelect, session.token_hash) as Session | undefined;
    if (!live || !activeSession(db, config, live)) throw new HttpError(401, expiredMessage);
    const time = now();
    if (live.last_used_at <= time - 60) {
      db.run('UPDATE sessions SET last_used_at=? WHERE token_hash=?', time, session.token_hash);
      db.run('UPDATE users SET last_active=? WHERE id=?', time, session.user_id);
    }
  });
}

export function activeUserSessions(db: Store, userId: string) {
  const time = now();
  return db.all(
    `SELECT id,stage,created_at,last_used_at,expires_at,address,device FROM sessions
     WHERE user_id=? AND generation=(SELECT auth_generation FROM users WHERE id=?)
     AND expires_at>? AND last_used_at>? ORDER BY last_used_at DESC,id DESC`,
    userId,
    userId,
    time,
    time - idleLifetime,
  );
}

export function requireSession<Stage extends SessionStage>(
  db: Store,
  request: FastifyRequest,
  config: Config,
  stages: readonly Stage[],
): SessionOf<Stage> {
  const live = currentSession(db, request, config);
  if (
    !live ||
    live.token_hash !== request.authSession?.token_hash ||
    live.csrf !== request.authSession.csrf ||
    !stages.includes(live.stage as Stage)
  )
    throw new HttpError(401, expiredMessage);
  if (accountOnboardingRequired(db, config, live) && !allowedAccountOnboarding(request))
    throw accountOnboardingError();
  return live as SessionOf<Stage>;
}

/** Reserve time for an operation authorized by this anonymous grant in the same transaction. */
export function reserveAnonymousTime(
  db: Store,
  config: Config,
  request: FastifyRequest,
  live: SessionOf<'anonymous'>,
  until: number,
) {
  const time = now();
  if (live.expires_at <= time) throw new HttpError(401, expiredMessage);
  if (until <= live.expires_at) return null;
  if (until > live.created_at + anonymousAbsoluteLifetime)
    return rotateSession(
      db,
      config,
      request,
      {
        userId: null,
        stage: 'anonymous',
        preserveAnonymousOperations: live,
      },
      time,
    );
  // The browser already holds the cookie through the absolute deadline.
  db.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', until, live.token_hash);
  return null;
}

/** Only a reserved upload can use its original anonymous grant after maintenance rollover. */
export function hasGuestUploadGrant(
  db: Store,
  config: Config,
  request: FastifyRequest,
  demoId: string,
) {
  const original = request.authSession;
  if (original?.stage !== 'anonymous') return false;
  const current = currentSession(db, request, config);
  if (current && (current.token_hash !== original.token_hash || current.csrf !== original.csrf))
    return false;
  const admission = db.one(
    'SELECT session_hash FROM guest_upload_grants WHERE demo_id=? AND original_hash=? AND expires_at_ms>?',
    demoId,
    original.token_hash,
    Date.now(),
  );
  const live = admission && (db.one(sessionSelect, admission.session_hash) as Session | undefined);
  return live?.stage === 'anonymous' && activeSession(db, config, live);
}

export function currentUser(
  db: Store,
  request: FastifyRequest,
  config: Config,
): SessionUser | null {
  const session = currentSession(db, request, config);
  return session?.stage === 'full' && !accountOnboardingRequired(db, config, session)
    ? sessionUser(session)
    : null;
}
function signupEmailVerificationRequired(
  db: Store,
  config: Config,
  account: AccountOnboardingFields,
) {
  return (
    Boolean(account.email_verification_required && account.email_verified_at === null) &&
    emailDeliveryEnabled(db, config)
  );
}
function requiresAccountSetup(db: Store, config: Config, account: AccountOnboardingFields) {
  return Boolean(account.profile_required) || signupEmailVerificationRequired(db, config, account);
}
export function accountOnboardingRequired(db: Store, config: Config, session: Session | null) {
  return session?.stage === 'full' && requiresAccountSetup(db, config, session);
}
export function accountOnboardingError() {
  return new HttpError(
    403,
    'Complete your account setup to continue.',
    undefined,
    'account_onboarding_required',
  );
}
export function sessionUser(session: SessionOf<'full'>): SessionUser {
  return {
    id: session.user_id,
    has_password: Boolean(session.has_password),
    username: session.username,
    display_name: session.display_name,
    role: session.role,
    csrf: session.csrf,
  };
}
export function requireUser(request: FastifyRequest) {
  if (!request.user) throw new HttpError(401, 'Sign in to continue.');
  return request.user;
}
export function proofDeadline(session: SessionOf<'full' | 'enroll'>) {
  return session.proof_at === null ? 0 : session.proof_at + proofLifetime;
}
function recentProof(db: Store, config: Config, session: SessionOf<'full' | 'enroll'>) {
  if (proofDeadline(session) <= now()) return false;
  if (session.proof_kind === 'passkey' || session.proof_kind === 'totp') return true;
  if (hasSecondFactor(db, session.user_id)) return false;
  return (
    session.proof_kind === 'password' ||
    (session.proof_kind === 'steam' && db.flag(config, 'steam_enabled'))
  );
}
export function requireFreshProof(
  db: Store,
  config: Config,
  session: SessionOf<'full' | 'enroll'>,
) {
  if (!recentProof(db, config, session))
    throw new HttpError(403, 'Confirm your identity to continue.');
}
export function requireFreshSession(db: Store, request: FastifyRequest, config: Config) {
  const session = requireSession(db, request, config, ['full']);
  requireFreshProof(db, config, session);
  return session;
}
export function requireFactorEnrollmentSession(db: Store, request: FastifyRequest, config: Config) {
  const session = requireSession(db, request, config, ['enroll', 'full']);
  requireFreshProof(db, config, session);
  return session;
}

export function factorEnrollmentDeadline(session: SessionOf<'full' | 'enroll'>) {
  return Math.min(sessionDeadline(session), proofDeadline(session));
}

type Budget = [scope: string, max: number, seconds: number, identity?: string];
export function admitRequest(db: Store, request: FastifyRequest, budgets: Budget[]) {
  db.transaction(() => chargeBudgets(db, request, budgets));
}
/** Caller holds the write transaction that also reserves this request's work. */
export function chargeBudgets(db: Store, request: Pick<FastifyRequest, 'ip'>, budgets: Budget[]) {
  const time = now();
  db.run('DELETE FROM rate_limits WHERE expires_at<=?', time);
  for (const [scope, max, seconds, identity] of budgets) {
    const key = digest(scope + ':' + (identity ?? rateAddress(request.ip)));
    const current = db.one('SELECT count,expires_at FROM rate_limits WHERE key=?', key);
    if (current && current.count >= max)
      throw new HttpError(
        429,
        'Too many requests. Try again later.',
        Math.max(1, current.expires_at - time),
      );
    db.run(
      'INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
      key,
      1,
      time + seconds,
    );
  }
}

export function rateLimit(
  db: Store,
  request: FastifyRequest,
  scope: string,
  max: number,
  seconds = 900,
  identity?: string,
) {
  admitRequest(db, request, [[scope, max, seconds, identity]]);
}
export function revokeUserSessions(db: Store, userId: string) {
  db.run('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?', userId);
  db.run('DELETE FROM recovery_receipts WHERE user_id=?', userId);
  db.run('DELETE FROM sessions WHERE user_id=?', userId);
  db.run('DELETE FROM auth_states WHERE user_id=?', userId);
  db.run(
    'DELETE FROM password_resets WHERE user_id=? AND generation<>(SELECT auth_generation FROM users WHERE id=?)',
    userId,
    userId,
  );
}

function sessionFactors(db: Store, userId: string): SessionFactors {
  return {
    passkey: Boolean(db.one('SELECT 1 FROM auth_passkeys WHERE user_id=? LIMIT 1', userId)),
    totp: Boolean(db.one('SELECT 1 FROM auth_totp WHERE user_id=?', userId)),
    recovery: Boolean(db.one('SELECT 1 FROM auth_recovery_codes WHERE user_id=? LIMIT 1', userId)),
  };
}

/** Group IPv6 privacy addresses on the same /64 for admission budgets. */
export function rateAddress(ip: string) {
  const parsed = canonicalAddress(ip);
  if (!parsed) return 'unknown';
  if (parsed.family === 'ipv4') return parsed.ip;
  const [first, last] = parsed.ip.split('::');
  const left = first ? first.split(':') : [];
  const right = last ? last.split(':') : [];
  const groups =
    last === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.slice(0, 4).join(':') + '::/64';
}

function sessionAddress(ip: string) {
  const parsed = canonicalAddress(ip);
  if (!parsed) return null;
  return parsed.family === 'ipv4'
    ? parsed.ip.split('.').slice(0, 3).join('.') + '.0/24'
    : rateAddress(parsed.ip);
}

function deviceLabel(userAgent: string | undefined) {
  const value = (userAgent ?? '').slice(0, 512);
  const browser =
    [
      [/\bEdg[AiOS]*\//, 'Edge'],
      [/\b(Firefox|FxiOS)\//, 'Firefox'],
      [/\b(Chrome|Chromium|CriOS)\//, 'Chrome'],
      [/\bSafari\//, 'Safari'],
    ].find(([pattern]) => (pattern as RegExp).test(value))?.[1] ?? 'Browser';
  const os = [
    [/\bAndroid\b/, 'Android'],
    [/\b(iPhone|iPad)\b/, 'iOS'],
    [/\bWindows\b/, 'Windows'],
    [/\bMacintosh\b/, 'macOS'],
    [/\bLinux\b/, 'Linux'],
  ].find(([pattern]) => (pattern as RegExp).test(value))?.[1];
  return os ? browser + ' · ' + os : String(browser);
}

type SessionTransition =
  | {
      userId: null;
      stage: 'anonymous';
      proof?: never;
      preserveAnonymousOperations?: SessionOf<'anonymous'>;
    }
  | { userId: string; stage: AccountSessionStage; proof?: { kind: ProofKind; at?: number } };

function browserScope(session: Session) {
  return {
    hashes: session.browser_hash
      ? 'SELECT session_hash FROM session_browser_bindings WHERE browser_hash=?'
      : 'SELECT ?',
    scope: session.browser_hash ?? session.token_hash,
  };
}

function revokeBrowserGrants(db: Store, previous: Session, keepHash = '') {
  const { hashes, scope } = browserScope(previous);
  db.run(`DELETE FROM auth_states WHERE session_hash IN (${hashes})`, scope);
  db.run(`DELETE FROM sessions WHERE token_hash IN (${hashes}) AND token_hash<>?`, scope, keepHash);
}

/** Retire preceding account and login authority without discarding anonymous operations. */
export function confirmAnonymousSignOut(db: Store, config: Config, live: SessionOf<'anonymous'>) {
  revokeBrowserGrants(db, live, live.token_hash);
  db.run('DELETE FROM auth_passkey_challenges WHERE session_hash=?', live.token_hash);
  db.run('DELETE FROM guest_upload_grants WHERE session_hash=?', live.token_hash);
  const csrf = token();
  db.run('UPDATE sessions SET csrf=? WHERE token_hash=?', csrf, live.token_hash);
  return sessionDetails(db, config, { ...live, csrf });
}

function browserSecret(request: FastifyRequest, config: Config) {
  const raw = request.cookies[browserBindingCookieName(config)];
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : undefined;
}

function replacementBearer(binding: string, previous: string, id: string) {
  return createHmac('sha256', Buffer.from(binding, 'hex'))
    .update('cswatch-anonymous-renewal:' + previous + ':' + id)
    .digest('hex');
}

/** Retry only delivery of an existing anonymous successor, never use a retired
 * bearer for a route. Both original cookies must still identify the same browser. */
export function retryAnonymousDelivery(db: Store, config: Config, request: FastifyRequest) {
  const binding = browserSecret(request, config);
  const previous = request.cookies[browserCookieName(config)];
  if (!binding || !previous || !/^[a-f0-9]{64}$/.test(previous)) return null;
  const delivery = db.one(
    `SELECT d.session_hash FROM anonymous_grant_deliveries d
     JOIN session_browser_bindings b ON b.session_hash=d.session_hash
     WHERE d.previous_hash=? AND b.browser_hash=? AND d.expires_at>?`,
    digest(previous),
    digest(binding),
    now(),
  );
  if (!delivery) return null;
  const session = db.one(sessionSelect, delivery.session_hash) as Session | undefined;
  if (session?.stage !== 'anonymous' || !activeSession(db, config, session)) return null;
  const raw = replacementBearer(binding, previous, session.id);
  return equal(digest(raw), session.token_hash)
    ? { ...sessionDetails(db, config, session, raw), browserBinding: binding }
    : null;
}

function transferAnonymousOperations(
  db: Store,
  previous: SessionOf<'anonymous'>,
  id: string,
  hash: string,
  time: number,
) {
  db.run(
    `UPDATE password_resets SET claimed_by=? WHERE claimed_by=? AND expires_at>?
     AND generation=(SELECT auth_generation FROM users WHERE id=password_resets.user_id)`,
    id,
    previous.id,
    time,
  );
  db.run(
    `UPDATE recovery_receipts SET browser_id=? WHERE browser_id=? AND expires_at>?
     AND generation=(SELECT auth_generation FROM users WHERE id=recovery_receipts.user_id)`,
    id,
    previous.id,
    time,
  );
  db.run(
    'UPDATE guest_sessions SET browser_session_id=? WHERE browser_session_id=? AND expires_at>?',
    id,
    previous.id,
    time,
  );
  db.run(
    'UPDATE guest_upload_grants SET session_hash=? WHERE session_hash=? AND expires_at_ms>?',
    hash,
    previous.token_hash,
    Date.now(),
  );
}

/** Call inside the same transaction that verifies and spends the proof. */
export function rotateSession(
  db: Store,
  config: Config,
  request: FastifyRequest,
  transition: SessionTransition,
  time = now(),
): SessionGrant {
  const { userId, stage, proof } = transition;
  const preserve = stage === 'anonymous' ? transition.preserveAnonymousOperations : undefined;
  const old = preserve ?? request.authSession;
  const keepLifetime = old?.stage === 'full' && stage === 'full' && old.user_id === userId;
  const id = keepLifetime ? old.id : token().slice(0, 32);
  const supplied = browserSecret(request, config);
  const suppliedHash = supplied ? digest(supplied) : null;
  const previous = preserve ? request.cookies[browserCookieName(config)] : undefined;
  const replacement =
    previous && supplied && suppliedHash === preserve?.browser_hash
      ? replacementBearer(supplied, previous, id)
      : undefined;
  const raw = replacement ?? token();
  const hash = digest(raw);
  const csrf = token();
  const created = keepLifetime ? old.created_at : time;
  const expires = keepLifetime
    ? old.expires_at
    : time +
      (stage === 'full'
        ? config.sessionDays * 86400
        : stage === 'anonymous'
          ? anonymousLifetime
          : stage === 'enroll'
            ? proofLifetime
            : pendingLifetime);

  db.run('DELETE FROM sessions WHERE expires_at<=?', time);
  let browserHash = old?.browser_hash ?? null;
  let browserBinding: string | undefined;
  if (!old) {
    // A stale bearer can bootstrap within a previously established browser.
    // Only a server-issued binding can carry that scope into the new session.
    const recognized =
      suppliedHash &&
      db.one(
        `SELECT 1 FROM session_browser_bindings b JOIN sessions s ON s.token_hash=b.session_hash
         WHERE b.browser_hash=? AND s.last_used_at>? LIMIT 1`,
        suppliedHash,
        time - idleLifetime,
      );
    browserBinding = supplied && recognized ? supplied : token();
    browserHash = digest(browserBinding);
  } else {
    // Scope comes from the revalidated session. A different cookie cannot
    // redirect this mutation's revocations to another browser.
    if (!preserve) revokeBrowserGrants(db, old);
    if (stage === 'anonymous' && browserHash && suppliedHash === browserHash)
      browserBinding = supplied;
  }
  const user = userId
    ? db.one(
        `SELECT auth_generation FROM users u WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM guest_sessions WHERE owner_id=u.id)`,
        userId,
      )
    : null;
  if (userId && !user) throw new HttpError(401, expiredMessage);
  db.run(
    `INSERT INTO sessions(id,token_hash,user_id,csrf,stage,generation,created_at,last_used_at,expires_at,
      proof_at,proof_kind,address,device) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    hash,
    userId,
    csrf,
    stage,
    user?.auth_generation ?? 0,
    created,
    time,
    expires,
    proof ? (proof.at ?? time) : null,
    proof?.kind ?? null,
    request.clientAddress ? sessionAddress(request.clientAddress) : null,
    deviceLabel(request.headers['user-agent']),
  );
  if (browserHash) db.run('INSERT INTO session_browser_bindings VALUES(?,?)', hash, browserHash);
  if (preserve) {
    transferAnonymousOperations(db, preserve, id, hash, time);
    db.run('DELETE FROM auth_states WHERE session_hash=?', preserve.token_hash);
    db.run('DELETE FROM sessions WHERE token_hash=?', preserve.token_hash);
    if (replacement)
      db.run(
        'INSERT INTO anonymous_grant_deliveries VALUES(?,?,?)',
        preserve.token_hash,
        hash,
        Math.min(preserve.expires_at, time + anonymousDeliveryGrace),
      );
  }
  // Primary-only logins do not evict another browser's in-progress MFA.
  // Their issuance budgets and five/ten-minute TTL bound the pending pool.
  if (stage === 'full')
    db.run(
      "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id=? AND id<>? AND stage='full' ORDER BY last_used_at DESC,id DESC LIMIT -1 OFFSET ?)",
      userId,
      id,
      sessionLimit - 1,
    );
  if (stage === 'full') db.run('UPDATE users SET last_active=? WHERE id=?', time, userId);
  const session = db.one(sessionSelect, hash) as Session;
  return { ...sessionDetails(db, config, session, raw), browserBinding };
}

/** Caller has already rechecked fresh proof inside its credential-change transaction. */
export function renewAfterIdentityChange(
  db: Store,
  config: Config,
  r: FastifyRequest,
  live: ReturnType<typeof requireFreshSession>,
) {
  revokeUserSessions(db, live.user_id);
  return rotateSession(db, config, r, {
    userId: live.user_id,
    stage: 'full',
    proof: { kind: live.proof_kind!, at: live.proof_at! },
  });
}

function sessionDetails(db: Store, config: Config, session: Session, raw?: string): SessionGrant {
  return {
    raw,
    session,
    proofFresh:
      (session.stage === 'full' || session.stage === 'enroll') && recentProof(db, config, session),
    factors: session.user_id ? sessionFactors(db, session.user_id) : null,
    emailVerificationRequired:
      session.stage === 'full' && signupEmailVerificationRequired(db, config, session),
    matchSources:
      session.stage === 'full' && !accountOnboardingRequired(db, config, session)
        ? matchSources(db, config, session.user_id)
        : null,
    identities:
      session.stage === 'full'
        ? (db.all(
            'SELECT provider,subject FROM identities WHERE user_id=? ORDER BY provider',
            session.user_id,
          ) as SessionIdentity[])
        : [],
  };
}
function sessionStatus(grant: SessionGrant, guest: FastifyRequest['guest'] = null) {
  const { session, factors, identities } = grant;
  const { stage, csrf, expires_at, proof_at, proof_kind } = session;
  return {
    user:
      stage === 'full'
        ? {
            ...sessionUser(session),
            identities,
            match_sources: grant.matchSources,
            email: session.email,
            email_verified_at: session.email_verified_at,
            profile_required: Boolean(session.profile_required),
            email_verification_required: grant.emailVerificationRequired,
          }
        : null,
    session: {
      stage,
      csrf,
      anonymous_id: stage === 'anonymous' ? session.id : null,
      expires_at,
      proof_at,
      proof_kind,
      proof_fresh: grant.proofFresh,
      factors,
      username: stage === 'enroll' ? session.username : null,
      display_name: stage === 'enroll' ? session.display_name : null,
    },
    guest_session:
      stage === 'anonymous' && guest ? { csrf: guest.csrf, expires_at: guest.expires_at } : null,
  };
}

export function readSessionStatus(db: Store, config: Config, request: FastifyRequest) {
  const current = request.authSession && currentSession(db, request, config);
  return current && current.token_hash === request.authSession?.token_hash
    ? sessionStatus(sessionDetails(db, config, current), request.guest)
    : { user: null, session: null, guest_session: null };
}

export function sendSession(config: Config, reply: FastifyReply, grant: SessionGrant) {
  const anonymous = grant.session.stage === 'anonymous';
  const options = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  } as const;
  // Revocation already removed the previous hash. An anonymous response must
  // not overwrite an account cookie obtained in another tab after that commit.
  const omitCookie = anonymous && reply.request.headers['x-omit-anonymous-cookie'] === '1';
  if (grant.raw && !omitCookie) {
    const deadline = anonymous
      ? grant.session.created_at + anonymousAbsoluteLifetime
      : grant.session.expires_at;
    reply.setCookie(anonymous ? browserCookieName(config) : sessionCookieName(config), grant.raw, {
      ...options,
      maxAge: Math.max(0, deadline - now()),
    });
  }
  if (anonymous && grant.browserBinding && !omitCookie)
    reply.setCookie(browserBindingCookieName(config), grant.browserBinding, {
      ...options,
      // Cover the full session's lifetime even when preceded by sign-in and MFA.
      maxAge: config.sessionDays * 86400 + anonymousAbsoluteLifetime + pendingLifetime,
    });
  return sessionStatus(grant, reply.request.guest);
}

/** Source and compiled runtime share the browser's authentication route policy. */
const { safeAuthReturnPath } = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../shared/auth-navigation.mjs' : './auth-navigation.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/auth-navigation.mjs');
export const safeReturnPath = safeAuthReturnPath;
