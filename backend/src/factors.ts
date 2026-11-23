import { connectionTimeoutMs } from './request-security.js';
import { accountEntry } from './auth-routes.js';
import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { now, type Store } from './db.js';
import { seal, totpBinding, totpEnrollmentBinding, unseal } from './encryption-key.js';
import { HttpError } from './errors.js';
import {
  canSignIn,
  digest,
  equal,
  factorEnrollmentDeadline,
  hasSecondFactor,
  chargeBudgets,
  proofDeadline,
  rateAddress,
  requireFreshProof,
  requireFactorEnrollmentSession,
  requireFreshSession,
  requireSession,
  revokeUserSessions,
  rotateSession,
  sendSession,
  sessionCookieName,
  sessionDeadline,
  type Session,
  token,
} from './security.js';
import { acceptedTotpStep, base32 } from './totp.js';
import {
  assertionBody,
  passkeyBodyLimit,
  passkeyCeremonies,
  passkeyId,
  passkeyName,
  registrationBody,
} from './webauthn.js';

const assertionStages = { login: 'anonymous', challenge: 'challenge', 'step-up': 'full' } as const;
type AssertionPurpose = keyof typeof assertionStages;
type CeremonyPurpose = AssertionPurpose | 'enrollment';
type CodePurpose = 'enroll' | 'challenge' | 'full' | 'recovery';
type CodeSession = Extract<Session, { stage: CodePurpose }>;
const assertionPaths: Record<AssertionPurpose, string> = {
  login: '/api/auth/passkeys/login',
  challenge: '/api/auth/mfa/passkey',
  'step-up': '/api/auth/step-up/passkey',
};
const passkeyLimit = 10;
const recoveryCount = 10;
const passkeyLifetime = 120;
const totpEnrollmentLifetime = 600;
const pendingError = () => new HttpError(400, 'Security verification expired. Start again.');
const expiredPasskeySetup = () =>
  new HttpError(
    400,
    'Security verification expired. Start again.',
    undefined,
    'passkey_setup_expired',
  );
const passkeyInProgress = () =>
  new HttpError(
    409,
    'A passkey setup is already in progress. Finish it where it started, or try again after it expires.',
  );
const wrongSetupPasskey = () =>
  new HttpError(
    400,
    'A different passkey was selected. Choose Continue setup and select the passkey you just created.',
    undefined,
    'passkey_setup_wrong_credential',
  );
const expiredTotpSetup = () =>
  new HttpError(
    400,
    'Security verification expired. Start again.',
    undefined,
    'totp_setup_expired',
  );
const passkeyError = () => new HttpError(401, 'Passkey verification failed. Try again.');
const codeError = () => new HttpError(401, 'Security code is incorrect or already used.');
const noBody = z.strictObject({});
const passkeyAttempt = z.strictObject({ attempt: z.string().regex(/^[a-f0-9]{32}$/) });
const passkeyRegistration = registrationBody.extend(passkeyAttempt.shape);
const passkeyPossession = assertionBody.extend(passkeyAttempt.shape);
const totpCode = z.string().regex(/^\d{6}$/);
const enrollmentToken = z.string().regex(/^[a-f0-9]{64}$/);
const recoveryCode = z
  .string()
  .max(42)
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-f0-9]{32}|[a-f0-9]{4}(?:-[a-f0-9]{4}){7})$/);
const passkeyOptions = { bodyLimit: passkeyBodyLimit };
const factorOptions = { bodyLimit: 2048 };

function passkeyOptionsResponse<T extends { timeout?: number }>(options: T, expiresAt: number) {
  const remaining = expiresAt * 1000 - Date.now();
  if (remaining <= 0) throw pendingError();
  return {
    options: { ...options, timeout: Math.min(options.timeout ?? remaining, remaining) },
    expires_in_ms: remaining,
  };
}

const passkeyList = (db: Store, userId: string) =>
  db.all(
    'SELECT id,name,device_type,backed_up,created_at,last_used_at FROM auth_passkeys WHERE user_id=? ORDER BY created_at,id',
    userId,
  );
const recoveryHash = (code: string) => digest(`cswatch:recovery:1:${code.replaceAll('-', '')}`);
const emptyRecoveryHash = digest('cswatch:recovery:1:empty');

/** Redeliver an existing pending setup only to the exact authenticated bearer. */
function totpEnrollmentHandle(r: FastifyRequest, c: Config, verifier: string) {
  const bearer = r.cookies[sessionCookieName(c)];
  if (!bearer) throw expiredTotpSetup();
  return createHmac('sha256', Buffer.from(bearer, 'hex'))
    .update('cswatch:totp-enrollment-delivery:1:' + verifier)
    .digest('hex');
}

const enrollmentAttemptHash = (attempt: string) => digest('cswatch:passkey-attempt:1:' + attempt);

function enrollmentChallenge(
  r: FastifyRequest,
  c: Config,
  nonce: string,
  phase: 'create' | 'possession',
) {
  const bearer = r.cookies[sessionCookieName(c)];
  if (!bearer) throw pendingError();
  // A server nonce makes each attempt unique. Keep only the challenge hash and
  // reconstruct the challenge for this phase with the exact grant's bearer.
  return createHmac('sha256', Buffer.from(bearer, 'hex'))
    .update(`cswatch:passkey-enrollment:1:${phase}:${nonce}`)
    .digest();
}

function issueRecoveryCodes(db: Store, userId: string) {
  db.run('DELETE FROM auth_recovery_codes WHERE user_id=?', userId);
  return Array.from({ length: recoveryCount }, () => {
    const code = randomBytes(16).toString('hex').match(/.{4}/g)!.join('-');
    db.run('INSERT INTO auth_recovery_codes VALUES(?,?,?)', userId, recoveryHash(code), now());
    return code;
  });
}

function spendRecoveryCode(db: Store, userId: string, code: string) {
  const hashes = db.all('SELECT code_hash FROM auth_recovery_codes WHERE user_id=?', userId);
  const submitted = recoveryHash(code);
  let match = false;
  for (let index = 0; index < recoveryCount; index++) {
    if (equal(submitted, hashes[index]?.code_hash ?? emptyRecoveryHash) && index < hashes.length)
      match = true;
  }
  return (
    match &&
    Boolean(
      db.run('DELETE FROM auth_recovery_codes WHERE user_id=? AND code_hash=?', userId, submitted)
        .changes,
    )
  );
}

function backoffKeys(r: FastifyRequest, userId: string) {
  return [
    digest(`factor-delay:address:${rateAddress(r.ip)}`),
    digest(`factor-delay:account:${userId}`),
  ];
}

async function verifyCodeAttempt<T>(
  db: Store,
  r: FastifyRequest,
  reply: FastifyReply,
  purpose: CodePurpose,
  requireEligible: () => CodeSession,
  verify: (source: CodeSession, admittedAt: number) => T,
) {
  if (purpose === 'recovery') {
    const outcome = db.transaction(() => {
      const source = requireEligible();
      chargeBudgets(db, r, [
        ['backup-code-address', 24, 60],
        ['backup-code-browser', 8, 60, source.id],
        ['backup-code-instance', 120, 60, 'instance'],
      ]);
      const grant = verify(source, now());
      if (!grant) {
        // Keep high-entropy backup access usable from an independently admitted
        // browser even when another source filled the shared failure allowance.
        try {
          chargeBudgets(db, r, [['backup-code-account', 12, 60, source.user_id]]);
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 429) return error;
          throw error;
        }
      }
      return grant;
    });
    if (outcome instanceof HttpError) throw outcome;
    return outcome;
  }
  const address = rateAddress(r.ip);
  const attemptId = token();
  const reservation = db.transaction(() => {
    const source = requireEligible();
    const { user_id: userId, token_hash: sessionHash } = source;
    // Separate shares protect sign-in from enrollment and step-up traffic.
    chargeBudgets(db, r, [
      ['factor-code-account', 12, 10, userId],
      ['factor-code-address', 24, 60],
      ['factor-code-browser', 8, 60, source.id],
      ['factor-code-account-address', 10, 60, userId + '\0' + address],
      ['factor-code-instance-' + purpose, purpose === 'challenge' ? 240 : 120, 60, 'instance'],
    ]);
    const time = Date.now();
    db.run('DELETE FROM auth_otp_pacing WHERE expires_at_ms<=?', time);
    const failures = Number(
      db.one(
        'SELECT max(count) AS n FROM rate_limits WHERE key IN (?,?) AND expires_at>?',
        ...backoffKeys(r, userId),
        now(),
      )?.n ?? 0,
    );
    // A saturated account has a ten-second admission window and, after
    // repeated errors, verifies at most one code every two seconds across
    // all sources. An admitted attempt keeps its slot. Recovery is independent.
    const addressHash = digest(address);
    const outstanding = db.one(
      'SELECT count(*) AS n FROM auth_otp_pacing WHERE user_id=? OR address_hash=?',
      userId,
      addressHash,
    )!.n;
    const multiplier = 2 ** Math.min(failures + outstanding, 4);
    const spacing = 125 * multiplier;
    const clock = db.one('SELECT next_at_ms FROM auth_otp_clock WHERE user_id=?', userId);
    const slot = Math.max(time + 125 * multiplier, clock?.next_at_ms ?? 0);
    if (slot - time + reply.elapsedTime > connectionTimeoutMs - 10_000)
      throw new HttpError(429, 'Too many requests. Try again later.', 1);
    const reservation = db.run(
      'INSERT INTO auth_otp_pacing VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
      sessionHash,
      userId,
      addressHash,
      attemptId,
      slot + 5_000,
    );
    if (!reservation.changes) throw new HttpError(429, 'Too many requests. Try again later.', 1);
    db.run(
      'INSERT INTO auth_otp_clock(user_id,next_at_ms) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET next_at_ms=excluded.next_at_ms',
      userId,
      slot + spacing,
    );
    return {
      source,
      wait: slot - time,
      admittedAt: Math.floor(time / 1000),
      deadline: performance.now() + connectionTimeoutMs - 5_000 - reply.elapsedTime,
      spacing,
    };
  });
  const { user_id: userId, token_hash: sessionHash } = reservation.source;
  try {
    let wait = reservation.wait;
    for (;;) {
      await delay(wait);
      const result = db.transaction<{ wait: number } | { value: T }>(() => {
        const time = Date.now();
        // Do not spend a code on a socket which closed or whose response window
        // has already passed while this request was queued for the write lock.
        if (
          r.raw.socket.destroyed ||
          reply.raw.destroyed ||
          performance.now() >= reservation.deadline
        )
          throw pendingError();
        const clock = db.one(
          'SELECT c.last_checked_ms FROM auth_otp_clock c JOIN auth_otp_pacing p USING(user_id) WHERE p.session_hash=? AND p.attempt_id=? AND p.expires_at_ms>?',
          sessionHash,
          attemptId,
          time,
        );
        if (!clock) throw pendingError();
        // A late timer can make multiple reserved slots due together. Preserve
        // spacing when the event loop or another SQLite writer has stalled.
        const remaining = clock.last_checked_ms + reservation.spacing - time;
        if (remaining > 0) return { wait: remaining };
        db.run(
          'DELETE FROM auth_otp_pacing WHERE session_hash=? AND attempt_id=?',
          sessionHash,
          attemptId,
        );
        const value = verify(reservation.source, reservation.admittedAt);
        db.run('UPDATE auth_otp_clock SET last_checked_ms=? WHERE user_id=?', Date.now(), userId);
        return { value };
      });
      if ('value' in result) return result.value;
      wait = result.wait;
    }
  } catch (error) {
    // Rollback also restores the reservation. Release only this request's row.
    db.run(
      'DELETE FROM auth_otp_pacing WHERE session_hash=? AND attempt_id=?',
      sessionHash,
      attemptId,
    );
    throw error;
  }
}

function clearAccountCodeFailures(db: Store, userId: string) {
  db.run('DELETE FROM rate_limits WHERE key=?', digest(`factor-delay:account:${userId}`));
}

function recordCodeFailure(db: Store, r: FastifyRequest, userId: string) {
  const time = now();
  for (const key of backoffKeys(r, userId)) {
    db.run(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
       count=CASE WHEN expires_at<=? THEN 1 ELSE min(count+1,5) END,expires_at=excluded.expires_at`,
      key,
      time + 120,
      time,
    );
  }
}

export function registerFactorRoutes(app: FastifyInstance, db: Store, c: Config, key: Buffer) {
  const webauthn = passkeyCeremonies(c.appUrl);
  function chargePasskeyBudgets(
    r: FastifyRequest,
    browser: string,
    phase: 'options' | 'verify' | 'cancel',
    purpose: CeremonyPurpose,
  ) {
    chargeBudgets(db, r, [
      [`passkey-${phase}-browser`, 12, 60, browser],
      [`passkey-${phase}-address`, 40, 60],
      [`passkey-${purpose}-${phase}-instance`, 150, 60, 'instance'],
    ]);
  }
  function audit(
    r: FastifyRequest,
    userId: string | null,
    action: string,
    outcome: 'success' | 'denied' = 'success',
  ) {
    db.audit(userId, action, { target: userId, address: r.clientAddress, outcome });
  }
  function putChallenge(
    source: string,
    purpose: AssertionPurpose,
    challenge: string,
    expiresAt: number,
  ) {
    db.run('DELETE FROM auth_passkey_challenges WHERE expires_at<=?', now());
    db.run(
      `INSERT INTO auth_passkey_challenges(session_hash,purpose,challenge_hash,expires_at) VALUES(?,?,?,?)
       ON CONFLICT(session_hash,purpose) DO UPDATE SET challenge_hash=excluded.challenge_hash,expires_at=excluded.expires_at`,
      source,
      purpose,
      digest(challenge),
      expiresAt,
    );
  }
  function readChallenge(source: string, purpose: AssertionPurpose) {
    const challenge = db.one(
      'SELECT challenge_hash FROM auth_passkey_challenges WHERE session_hash=? AND purpose=? AND expires_at>?',
      source,
      purpose,
      now(),
    );
    if (!challenge) throw pendingError();
    return challenge;
  }
  function consumeChallenge(source: string, purpose: AssertionPurpose, hash: string) {
    const removed = db.run(
      'DELETE FROM auth_passkey_challenges WHERE session_hash=? AND purpose=? AND challenge_hash=? AND expires_at>?',
      source,
      purpose,
      hash,
      now(),
    );
    if (!removed.changes) throw pendingError();
  }
  function credential(id: string) {
    return db.one(
      `SELECT p.*,u.webauthn_handle,u.auth_generation,u.role
      FROM auth_passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=?`,
      id,
    );
  }
  function requireMatchingSession(source: string, active: string) {
    if (source !== active) throw pendingError();
  }
  function enrollmentPasskeys(userId: string) {
    const passkeys = passkeyList(db, userId);
    if (passkeys.length >= passkeyLimit)
      throw new HttpError(409, 'This account has the maximum number of passkeys.');
    return passkeys;
  }
  function passkeyEnrollment(source: string, attemptHash: string) {
    return db.one(
      'SELECT * FROM auth_passkey_enrollments WHERE session_hash=? AND attempt_hash=?',
      source,
      attemptHash,
    );
  }
  function retirePasskeyEnrollment(source: string, attemptHash: string) {
    // Retain only the selector verifier until its original proof stops working.
    // A delayed options POST must not recreate a cancelled or consumed attempt.
    db.run(
      `UPDATE auth_passkey_enrollments
       SET nonce=NULL,challenge_hash=NULL,id=NULL,name=NULL,public_key=NULL,counter=NULL,device_type=NULL
       WHERE session_hash=? AND attempt_hash=?`,
      source,
      attemptHash,
    );
  }
  function requireNoTotp(userId: string) {
    if (db.one('SELECT 1 FROM auth_totp WHERE user_id=?', userId))
      throw new HttpError(409, 'This account already has an authenticator app.');
  }

  for (const purpose of Object.keys(assertionStages) as AssertionPurpose[]) {
    const path = assertionPaths[purpose];
    const stage = assertionStages[purpose];
    const entry = accountEntry(stage, purpose === 'step-up');
    const requireSource = (r: FastifyRequest) => requireSession(db, r, c, [stage]);
    app.post(`${path}/options`, { ...factorOptions, ...entry }, async (r) => {
      noBody.parse(r.body);
      const { source, known, deadline } = db.transaction(() => {
        const source = requireSource(r);
        const known = source.user_id
          ? passkeyList(db, source.user_id).map(({ id }) => ({ id }))
          : undefined;
        if (known?.length === 0) throw new HttpError(409, 'Add a passkey to this account first.');
        chargePasskeyBudgets(r, source.id, 'options', purpose);
        return {
          source,
          known,
          deadline: Math.min(sessionDeadline(source), now() + passkeyLifetime),
        };
      });
      const options = await webauthn.assertionOptions(known);
      return db.transaction(() => {
        const active = requireSource(r);
        requireMatchingSession(source.token_hash, active.token_hash);
        const expiresAt = Math.min(deadline, sessionDeadline(active));
        const bounded = passkeyOptionsResponse(options, expiresAt);
        putChallenge(source.token_hash, purpose, options.challenge, expiresAt);
        return bounded;
      });
    });
    app.post(`${path}/verify`, { ...passkeyOptions, ...entry }, async (r, reply) => {
      const { response } = assertionBody.parse(r.body);
      const { source, hash, passkey, policyRequired } = db.transaction(() => {
        const source = requireSource(r);
        const hash = readChallenge(source.token_hash, purpose).challenge_hash;
        chargePasskeyBudgets(r, source.id, 'verify', purpose);
        const row = credential(response.id);
        const passkey =
          row && (!source.user_id || row.user_id === source.user_id) ? row : undefined;
        const policyRequired = passkey && db.mfaRequiredRoles(c).includes(passkey.role);
        return { source, hash, passkey, policyRequired };
      });
      const info = await webauthn.verify(
        response,
        hash,
        passkey && {
          id: passkey.id,
          publicKey: Uint8Array.from(passkey.public_key),
          counter: passkey.counter,
          deviceType: passkey.device_type,
        },
      );
      const action = `auth.passkey.${purpose}`;
      const grant = db.transaction(() => {
        const active = requireSource(r);
        requireMatchingSession(source.token_hash, active.token_hash);
        const current = passkey && credential(passkey.id);
        const handle = response.response.userHandle;
        if (
          !info ||
          !passkey ||
          !current ||
          current.user_id !== passkey.user_id ||
          current.auth_generation !== passkey.auth_generation ||
          current.role !== passkey.role ||
          db.mfaRequiredRoles(c).includes(current.role) !== policyRequired ||
          current.counter !== passkey.counter ||
          current.device_type !== passkey.device_type ||
          !Buffer.from(current.public_key).equals(Buffer.from(passkey.public_key)) ||
          current.webauthn_handle !== passkey.webauthn_handle ||
          (handle
            ? !equal(handle, Buffer.from(current.webauthn_handle, 'hex').toString('base64url'))
            : purpose === 'login')
        ) {
          audit(r, source.user_id, action, 'denied');
          return null;
        }
        consumeChallenge(source.token_hash, purpose, hash);
        db.run(
          'UPDATE auth_passkeys SET counter=?,backed_up=?,last_used_at=? WHERE id=?',
          info.newCounter,
          Number(info.credentialBackedUp),
          now(),
          current.id,
        );
        audit(r, current.user_id, action);
        return rotateSession(db, c, r, {
          userId: current.user_id,
          stage: 'full',
          proof: { kind: 'passkey' },
        });
      });
      if (!grant) throw passkeyError();
      return sendSession(c, reply, grant);
    });
  }

  app.get('/api/auth/security', accountEntry('enroll'), (r) => {
    const { user_id } = requireSession(db, r, c, ['enroll', 'full']);
    return {
      passkeys: passkeyList(db, user_id!).map((passkey) => ({
        ...passkey,
        backed_up: Boolean(passkey.backed_up),
      })),
      totp: db.one('SELECT created_at FROM auth_totp WHERE user_id=?', user_id) ?? null,
      recovery_codes_remaining: db.one(
        'SELECT count(*) AS count FROM auth_recovery_codes WHERE user_id=?',
        user_id,
      )!.count,
    };
  });

  app.post(
    '/api/auth/factors/passkeys/options',
    { ...factorOptions, ...accountEntry('enroll') },
    async (r) => {
      const { attempt } = passkeyAttempt.parse(r.body);
      const attemptHash = enrollmentAttemptHash(attempt);
      const { source, passkeys, handle, challenge, phase } = db.transaction(() => {
        const source = requireFactorEnrollmentSession(db, r, c);
        const time = now();
        const pending = passkeyEnrollment(source.token_hash, attemptHash);
        if (pending && (!pending.nonce || pending.expires_at <= time)) throw expiredPasskeySetup();
        const passkeys = enrollmentPasskeys(source.user_id);
        chargePasskeyBudgets(r, source.id, 'options', 'enrollment');
        const phase = pending?.id ? 'possession' : 'create';
        const nonce = pending?.nonce ?? token();
        const challenge = enrollmentChallenge(r, c, nonce, phase);
        if (!pending) {
          if (
            db.one(
              'SELECT 1 FROM auth_passkey_enrollments WHERE session_hash=? AND nonce IS NOT NULL AND expires_at>?',
              source.token_hash,
              time,
            )
          )
            throw passkeyInProgress();
          db.run('DELETE FROM auth_passkey_enrollments WHERE retain_until<=?', time);
          db.run(
            `INSERT INTO auth_passkey_enrollments
             (session_hash,attempt_hash,expires_at,retain_until,nonce,challenge_hash) VALUES(?,?,?,?,?,?)`,
            source.token_hash,
            attemptHash,
            Math.min(factorEnrollmentDeadline(source), time + passkeyLifetime),
            proofDeadline(source),
            nonce,
            digest(challenge.toString('base64url')),
          );
        }
        const handle = db.one(
          'SELECT webauthn_handle FROM users WHERE id=?',
          source.user_id,
        )!.webauthn_handle;
        return { source, passkeys, handle, challenge, phase };
      });
      const options =
        phase === 'create'
          ? await webauthn.registrationOptions(
              source.username!,
              handle,
              passkeys.map(({ id }) => ({ id })),
              challenge,
            )
          : await webauthn.assertionOptions(undefined, challenge);
      return db.transaction(() => {
        const active = requireFactorEnrollmentSession(db, r, c);
        requireMatchingSession(source.token_hash, active.token_hash);
        enrollmentPasskeys(active.user_id);
        const current = passkeyEnrollment(active.token_hash, attemptHash);
        if (!current?.nonce || current.expires_at <= now()) throw expiredPasskeySetup();
        if (!equal(current.challenge_hash, digest(options.challenge))) throw pendingError();
        const expiresAt = Math.min(current.expires_at, factorEnrollmentDeadline(active));
        return { phase, ...passkeyOptionsResponse(options, expiresAt) };
      });
    },
  );
  app.post(
    '/api/auth/factors/passkeys/cancel',
    { ...factorOptions, ...accountEntry('enroll') },
    (r) => {
      const { attempt } = passkeyAttempt.parse(r.body);
      const attemptHash = enrollmentAttemptHash(attempt);
      return db.transaction(() => {
        const source = requireSession(db, r, c, ['enroll', 'full']);
        // A new proof rotates the grant. Nothing from this expired proof can resume.
        if (proofDeadline(source) <= now()) return { ok: true };
        requireFreshProof(db, c, source);
        const pending = passkeyEnrollment(source.token_hash, attemptHash);
        if (!pending || pending.nonce) {
          chargePasskeyBudgets(r, source.id, 'cancel', 'enrollment');
          if (pending) retirePasskeyEnrollment(source.token_hash, attemptHash);
          else {
            // Cancellation can overtake the initial options request.
            const time = now();
            db.run('DELETE FROM auth_passkey_enrollments WHERE retain_until<=?', time);
            db.run(
              'INSERT INTO auth_passkey_enrollments(session_hash,attempt_hash,expires_at,retain_until) VALUES(?,?,?,?)',
              source.token_hash,
              attemptHash,
              time,
              proofDeadline(source),
            );
          }
        }
        return { ok: true };
      });
    },
  );
  app.post(
    '/api/auth/factors/passkeys/verify',
    { ...passkeyOptions, ...accountEntry('enroll') },
    async (r) => {
      const { response, name, attempt } = passkeyRegistration.parse(r.body);
      const attemptHash = enrollmentAttemptHash(attempt);
      const { source, pending } = db.transaction(() => {
        const source = requireFactorEnrollmentSession(db, r, c);
        const pending = passkeyEnrollment(source.token_hash, attemptHash);
        if (!pending?.nonce || pending.id || pending.expires_at <= now()) throw pendingError();
        enrollmentPasskeys(source.user_id);
        chargePasskeyBudgets(r, source.id, 'verify', 'enrollment');
        return { source, pending };
      });
      const info = await webauthn.register(response, pending.challenge_hash);
      if (!info) throw passkeyError();
      // With none attestation, registration alone does not prove possession of the new key.
      // An assertion without allowCredentials also exercises discovery before activating it.
      const challenge = enrollmentChallenge(r, c, pending.nonce, 'possession');
      const options = await webauthn.assertionOptions(undefined, challenge);
      return db.transaction(() => {
        const active = requireFactorEnrollmentSession(db, r, c);
        requireMatchingSession(source.token_hash, active.token_hash);
        enrollmentPasskeys(active.user_id);
        const expiresAt = Math.min(pending.expires_at, factorEnrollmentDeadline(active));
        const bounded = passkeyOptionsResponse(options, expiresAt);
        const staged = db.run(
          `UPDATE auth_passkey_enrollments SET challenge_hash=?,expires_at=?,id=?,name=?,public_key=?,counter=?,device_type=?
           WHERE session_hash=? AND attempt_hash=? AND challenge_hash=? AND expires_at>?`,
          digest(options.challenge),
          expiresAt,
          info.credential.id,
          name,
          Buffer.from(info.credential.publicKey),
          info.credential.counter,
          info.credentialDeviceType,
          active.token_hash,
          attemptHash,
          pending.challenge_hash,
          now(),
        );
        if (!staged.changes) throw pendingError();
        return bounded;
      });
    },
  );

  app.post(
    '/api/auth/factors/passkeys/confirm',
    { ...passkeyOptions, ...accountEntry('enroll') },
    async (r, reply) => {
      const { response, attempt } = passkeyPossession.parse(r.body);
      const attemptHash = enrollmentAttemptHash(attempt);
      const setup = db.transaction(() => {
        const source = requireFactorEnrollmentSession(db, r, c);
        const pending = db.one(
          `SELECT p.*,u.webauthn_handle FROM auth_passkey_enrollments p
        JOIN sessions s ON s.token_hash=p.session_hash JOIN users u ON u.id=s.user_id
        WHERE p.session_hash=? AND p.attempt_hash=? AND p.id IS NOT NULL AND p.expires_at>?`,
          source.token_hash,
          attemptHash,
          now(),
        );
        if (!pending) throw pendingError();
        enrollmentPasskeys(source.user_id);
        chargePasskeyBudgets(r, source.id, 'verify', 'enrollment');
        if (pending.id !== response.id) return null;
        return { source, pending };
      });
      if (!setup) throw wrongSetupPasskey();
      const { source, pending } = setup;
      const proof = await webauthn.verify(response, pending.challenge_hash, {
        id: pending.id,
        publicKey: Uint8Array.from(pending.public_key),
        counter: pending.counter,
        deviceType: pending.device_type,
      });
      const result = db.transaction(() => {
        const active = requireFactorEnrollmentSession(db, r, c);
        requireMatchingSession(source.token_hash, active.token_hash);
        const current = passkeyEnrollment(source.token_hash, attemptHash);
        if (
          !current ||
          current.challenge_hash !== pending.challenge_hash ||
          current.expires_at <= now()
        )
          throw pendingError();
        retirePasskeyEnrollment(source.token_hash, attemptHash);
        const userId = active.user_id;
        if (
          !proof ||
          !equal(
            response.response.userHandle ?? '',
            Buffer.from(pending.webauthn_handle, 'hex').toString('base64url'),
          ) ||
          db.one('SELECT 1 FROM auth_passkeys WHERE id=?', pending.id)
        ) {
          audit(r, userId, 'security.passkey.added', 'denied');
          return null;
        }
        enrollmentPasskeys(userId);
        db.bindRelyingParty(c);
        const first = !hasSecondFactor(db, userId);
        db.run(
          `INSERT INTO auth_passkeys(id,user_id,name,public_key,counter,device_type,backed_up,created_at,last_used_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          pending.id,
          userId,
          pending.name,
          pending.public_key,
          proof.newCounter,
          pending.device_type,
          Number(proof.credentialBackedUp),
          now(),
          now(),
        );
        const recovery_codes = first ? issueRecoveryCodes(db, userId) : undefined;
        revokeUserSessions(db, userId);
        audit(r, userId, 'security.passkey.added');
        const grant = rotateSession(db, c, r, {
          userId,
          stage: 'full',
          proof: { kind: 'passkey' },
        });
        return { grant, recovery_codes };
      });
      if (!result) throw passkeyError();
      return { ...sendSession(c, reply, result.grant), recovery_codes: result.recovery_codes };
    },
  );

  app.post(
    '/api/auth/factors/totp/options',
    { ...factorOptions, ...accountEntry('enroll') },
    (r) => {
      noBody.parse(r.body);
      const { enrollment, secret, username, expiresAt } = db.transaction(() => {
        const source = requireFactorEnrollmentSession(db, r, c);
        const userId = source.user_id;
        requireNoTotp(userId);
        chargeBudgets(db, r, [['totp-enrollment-options-address', 24, 60]]);
        const time = now();
        const deadline = Math.min(factorEnrollmentDeadline(source), time + totpEnrollmentLifetime);
        if (deadline <= time) throw expiredTotpSetup();
        const binding = totpEnrollmentBinding(userId, source.token_hash);
        const pending = db.one(
          `SELECT enrollment_hash,encrypted_secret,expires_at FROM auth_totp_enrollments
           WHERE session_hash=? AND user_id=? AND expires_at>?`,
          source.token_hash,
          userId,
          time,
        );
        if (pending) {
          const expiresAt = Math.min(pending.expires_at, deadline);
          if (expiresAt !== pending.expires_at)
            db.run(
              'UPDATE auth_totp_enrollments SET expires_at=? WHERE session_hash=?',
              expiresAt,
              source.token_hash,
            );
          const seed = unseal(key, binding, pending.encrypted_secret);
          return {
            enrollment: totpEnrollmentHandle(r, c, pending.enrollment_hash),
            secret: base32(Buffer.from(seed, 'hex')),
            username: source.username,
            expiresAt,
          };
        }
        const bytes = randomBytes(20);
        const verifier = digest(token());
        db.run('DELETE FROM auth_totp_enrollments WHERE expires_at<=?', time);
        db.run(
          'INSERT INTO auth_totp_enrollments(session_hash,user_id,enrollment_hash,encrypted_secret,expires_at) VALUES(?,?,?,?,?)',
          source.token_hash,
          userId,
          verifier,
          seal(key, binding, bytes.toString('hex')),
          deadline,
        );
        return {
          enrollment: totpEnrollmentHandle(r, c, verifier),
          secret: base32(bytes),
          username: source.username,
          expiresAt: deadline,
        };
      });
      const issuer = `cswatch ${c.host.replaceAll(':', '-')}`;
      const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username.replaceAll(':', '∶'))}`;
      const parameters = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
      });
      return {
        secret,
        uri: `otpauth://totp/${label}?${parameters}`,
        enrollment,
        expires_in_ms: Math.max(0, expiresAt * 1000 - Date.now()),
      };
    },
  );
  app.post(
    '/api/auth/factors/totp/verify',
    { ...factorOptions, ...accountEntry('enroll') },
    async (r, reply) => {
      const { code, enrollment } = z
        .strictObject({ code: totpCode, enrollment: enrollmentToken })
        .parse(r.body);
      const enrollmentHash = digest(enrollment);
      const requireSource = () => requireFactorEnrollmentSession(db, r, c);
      const pendingEnrollment = (source: CodeSession) => {
        const pending = db.one(
          `SELECT enrollment_hash,encrypted_secret FROM auth_totp_enrollments
        WHERE session_hash=? AND user_id=? AND expires_at>?`,
          source.token_hash,
          source.user_id,
          now(),
        );
        if (
          !pending ||
          !equal(digest(totpEnrollmentHandle(r, c, pending.enrollment_hash)), enrollmentHash)
        )
          throw expiredTotpSetup();
        requireNoTotp(source.user_id);
        return pending;
      };
      const result = await verifyCodeAttempt(
        db,
        r,
        reply,
        'enroll',
        () => {
          const source = requireSource();
          pendingEnrollment(source);
          return source;
        },
        (source, admittedAt) => {
          requireMatchingSession(source.token_hash, requireSource().token_hash);
          const { user_id: userId } = source;
          const pending = pendingEnrollment(source);
          const seed = unseal(
            key,
            totpEnrollmentBinding(userId, source.token_hash),
            pending.encrypted_secret,
          );
          const step = acceptedTotpStep(Buffer.from(seed, 'hex'), code, admittedAt, -1);
          if (step === null) {
            recordCodeFailure(db, r, userId);
            audit(r, userId, 'security.totp.added', 'denied');
            return null;
          }
          clearAccountCodeFailures(db, userId);
          const first = !hasSecondFactor(db, userId);
          db.run('DELETE FROM auth_totp_enrollments WHERE session_hash=?', source.token_hash);
          db.run(
            'INSERT INTO auth_totp VALUES(?,?,?,?)',
            userId,
            seal(key, totpBinding(userId), seed),
            step,
            now(),
          );
          const recovery_codes = first ? issueRecoveryCodes(db, userId) : undefined;
          revokeUserSessions(db, userId);
          audit(r, userId, 'security.totp.added');
          const grant = rotateSession(db, c, r, { userId, stage: 'full', proof: { kind: 'totp' } });
          return { grant, recovery_codes };
        },
      );
      if (!result) throw codeError();
      return { ...sendSession(c, reply, result.grant), recovery_codes: result.recovery_codes };
    },
  );

  const codeRoutes = [
    { path: '/api/auth/mfa/totp', stage: 'challenge', method: 'totp' },
    { path: '/api/auth/step-up/totp', stage: 'full', method: 'totp' },
    { path: '/api/auth/mfa/recovery', stage: 'challenge', method: 'recovery' },
  ] as const;
  for (const { path, stage, method } of codeRoutes) {
    const entry = accountEntry(stage, stage === 'full');
    app.post(path, { ...factorOptions, ...entry }, async (r, reply) => {
      const { code } = z
        .strictObject({ code: method === 'totp' ? totpCode : recoveryCode })
        .parse(r.body);
      const action = `auth.${stage === 'challenge' ? 'challenge' : 'step-up'}.${method}`;
      const requireSource = () => requireSession(db, r, c, [stage]);
      const grant = await verifyCodeAttempt(
        db,
        r,
        reply,
        method === 'recovery' ? 'recovery' : stage,
        () => {
          const source = requireSource();
          const userId = source.user_id;
          if (method === 'totp' && !db.one('SELECT 1 FROM auth_totp WHERE user_id=?', userId))
            throw codeError();
          if (
            method === 'recovery' &&
            (!hasSecondFactor(db, userId) ||
              !db.one('SELECT 1 FROM auth_recovery_codes WHERE user_id=?', userId))
          )
            throw codeError();
          return source;
        },
        (source, admittedAt) => {
          requireMatchingSession(source.token_hash, requireSource().token_hash);
          const userId = source.user_id;
          let verified: boolean;
          if (method === 'recovery') {
            verified = hasSecondFactor(db, userId) && spendRecoveryCode(db, userId, code);
          } else {
            const row = db.one(
              'SELECT encrypted_secret,last_step FROM auth_totp WHERE user_id=?',
              userId,
            );
            const seed = row
              ? Buffer.from(unseal(key, totpBinding(userId), row.encrypted_secret), 'hex')
              : Buffer.alloc(20);
            const step = acceptedTotpStep(seed, code, admittedAt, row?.last_step ?? -1);
            verified = !!row && step !== null;
            if (verified) db.run('UPDATE auth_totp SET last_step=? WHERE user_id=?', step, userId);
          }
          if (!verified) {
            if (method === 'totp') recordCodeFailure(db, r, userId);
            audit(r, userId, action, 'denied');
            return null;
          }
          clearAccountCodeFailures(db, userId);
          audit(r, userId, action);
          return rotateSession(db, c, r, {
            userId,
            stage: 'full',
            proof: method === 'totp' ? { kind: 'totp' } : undefined,
          });
        },
      );
      if (!grant) throw codeError();
      return sendSession(c, reply, grant);
    });
  }

  app.patch('/api/auth/factors/passkeys/:id', factorOptions, (r) => {
    const { id } = z.object({ id: passkeyId }).parse(r.params);
    const { name } = z.strictObject({ name: passkeyName }).parse(r.body);
    return db.transaction(() => {
      const { user_id } = requireFreshSession(db, r, c);
      const changed = db.run(
        'UPDATE auth_passkeys SET name=? WHERE id=? AND user_id=?',
        name,
        id,
        user_id,
      );
      if (!changed.changes) throw new HttpError(404, 'Passkey not found.');
      audit(r, user_id, 'security.passkey.renamed');
      return { ok: true };
    });
  });

  for (const factor of ['passkey', 'totp'] as const) {
    app.delete(
      factor === 'passkey' ? '/api/auth/factors/passkeys/:id' : '/api/auth/factors/totp',
      factorOptions,
      (r, reply) => {
        const grant = db.transaction(() => {
          const source = requireFreshSession(db, r, c);
          const userId = source.user_id!;
          const removed =
            factor === 'passkey'
              ? db.run(
                  'DELETE FROM auth_passkeys WHERE id=? AND user_id=?',
                  z.object({ id: passkeyId }).parse(r.params).id,
                  userId,
                )
              : db.run('DELETE FROM auth_totp WHERE user_id=?', userId);
          if (!removed.changes) throw new HttpError(404, 'Security method not found.');
          if (!canSignIn(db, c, userId))
            throw new HttpError(409, 'Add another sign-in method before removing this one.');
          if (!hasSecondFactor(db, userId)) {
            if (db.mfaRequiredRoles(c).includes(source.role!))
              throw new HttpError(409, 'Add another second factor before removing this one.');
            db.run('DELETE FROM auth_recovery_codes WHERE user_id=?', userId);
          }
          revokeUserSessions(db, userId);
          audit(r, userId, `security.${factor}.removed`);
          return rotateSession(db, c, r, { userId, stage: 'full' });
        });
        return sendSession(c, reply, grant);
      },
    );
  }

  app.post('/api/auth/factors/recovery/regenerate', factorOptions, (r, reply) => {
    noBody.parse(r.body);
    const result = db.transaction(() => {
      const source = requireFreshSession(db, r, c);
      const userId = source.user_id!;
      if (!hasSecondFactor(db, userId))
        throw new HttpError(409, 'Add a second factor to create recovery codes.');
      const recovery_codes = issueRecoveryCodes(db, userId);
      revokeUserSessions(db, userId);
      audit(r, userId, 'security.recovery.regenerated');
      const proof =
        source.proof_kind && source.proof_at
          ? { kind: source.proof_kind, at: source.proof_at }
          : undefined;
      const grant = rotateSession(db, c, r, { userId, stage: 'full', proof });
      return { grant, recovery_codes };
    });
    return { ...sendSession(c, reply, result.grant), recovery_codes: result.recovery_codes };
  });
}
