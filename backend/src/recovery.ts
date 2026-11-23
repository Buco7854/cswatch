import { accountPassword } from './credentials.js';
import { accountEntry } from './auth-routes.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emailDeliveryEnabled, type Config } from './config.js';
import { now, type Store } from './db.js';
import {
  digest,
  equal,
  hashPassword,
  HttpError,
  chargeBudgets,
  requireSession,
  reserveAnonymousTime,
  revokeUserSessions,
  sendSession,
  token,
} from './security.js';

export const passwordResetLifetime = 600;
const claimId = z.string().regex(/^[a-f0-9]{32}$/);
const attemptId = z.string().regex(/^[a-f0-9]{64}$/);
// The browser can derive this receipt without retaining the code or its verifier.
const attemptReceipt = (verifier: string) => digest('cswatch/recovery-attempt/v1:' + verifier);
const invalidReset = () =>
  new HttpError(400, 'This recovery code has expired or was already used.');
const remainingLifetime = (expiry: number) => expiry * 1000 - Date.now();

/** Called in the transaction that authorizes recovery. Issuing a replacement supersedes any claim. */
export function issuePasswordReset(db: Store, userId: string) {
  const code = token();
  db.run('DELETE FROM password_resets WHERE expires_at<=? OR user_id=?', now(), userId);
  db.run('DELETE FROM recovery_receipts WHERE expires_at<=? OR user_id=?', now(), userId);
  db.run('DELETE FROM email_recovery_codes WHERE user_id=?', userId);
  db.run(
    `INSERT INTO password_resets(user_id,verifier,generation,expires_at)
     SELECT id,?,auth_generation,? FROM users WHERE id=?`,
    digest(code),
    now() + passwordResetLifetime,
    userId,
  );
  return code;
}

// Operator resets have no email revision and depend only on the account generation.
const liveEmailReset = `AND (p.email_revision IS NULL OR
  (? AND p.email_revision=u.email_revision AND u.email_verified_at IS NOT NULL))`;

function acceptEmailReset(db: Store, verifier: string) {
  const time = now();
  const candidate = db.one(
    `SELECT e.user_id,e.generation,e.email_revision,e.expires_at
     FROM email_recovery_codes e JOIN users u ON u.id=e.user_id
     WHERE e.verifier=? AND e.expires_at>? AND e.generation=u.auth_generation
     AND e.email_revision=u.email_revision AND u.email_verified_at IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM password_resets p WHERE p.user_id=e.user_id
       AND p.generation=e.generation AND p.expires_at>?)
     AND NOT EXISTS(SELECT 1 FROM recovery_receipts r WHERE r.user_id=e.user_id
       AND r.generation=e.generation AND r.expires_at>?)`,
    verifier,
    time,
    time,
    time,
  );
  if (!candidate) return;
  db.run('DELETE FROM password_resets WHERE user_id=?', candidate.user_id);
  db.run('DELETE FROM email_recovery_codes WHERE verifier=?', verifier);
  db.run(
    `INSERT INTO password_resets(user_id,verifier,generation,expires_at,email_revision)
     VALUES(?,?,?,?,?)`,
    candidate.user_id,
    verifier,
    candidate.generation,
    candidate.expires_at,
    candidate.email_revision,
  );
}

export function recoveryRoutes(app: FastifyInstance, db: Store, c: Config) {
  app.get('/api/auth/recover/status', accountEntry('anonymous'), (r) => {
    const browser = requireSession(db, r, c, ['anonymous']);
    const claim = claimId.safeParse(r.headers['x-recovery-claim']).data;
    const attempt = attemptId.safeParse(r.headers['x-recovery-attempt']).data;
    const proof = claim ?? attempt;
    if (!proof) return { claim_id: null };
    const receipt = db.one(
      `SELECT u.username,r.claim_hash,r.attempt_hash,r.expires_at FROM recovery_receipts r JOIN users u ON u.id=r.user_id
       WHERE r.browser_id=? AND r.generation=u.auth_generation AND r.expires_at>?`,
      browser.id,
      now(),
    );
    if (receipt && equal(digest(proof), claim ? receipt.claim_hash : receipt.attempt_hash)) {
      const remainingMs = remainingLifetime(receipt.expires_at);
      if (remainingMs > 0)
        return {
          claim_id: null,
          username: receipt.username,
          recovery_expires_in_ms: remainingMs,
        };
    }
    const row = db.one(
      `SELECT p.claim_id,p.verifier,p.expires_at FROM password_resets p JOIN users u ON p.user_id=u.id
       WHERE p.claimed_by=? AND p.expires_at>? AND p.generation=u.auth_generation ${liveEmailReset}`,
      browser.id,
      now(),
      Number(emailDeliveryEnabled(db, c)),
    );
    if (!row || !equal(proof, claim ? row.claim_id : attemptReceipt(row.verifier)))
      return { claim_id: null };
    const remainingMs = remainingLifetime(row.expires_at);
    return remainingMs > 0
      ? { claim_id: row.claim_id, recovery_expires_in_ms: remainingMs }
      : { claim_id: null };
  });

  app.post('/api/auth/recover/claim', accountEntry('anonymous'), async (r, reply) => {
    const { code } = z.strictObject({ code: z.string().regex(/^[0-9a-f]{64}$/) }).parse(r.body);
    const result = db.transaction(() => {
      const browser = requireSession(db, r, c, ['anonymous']);
      chargeBudgets(db, r, [['recovery-claim', 20, 300]]);
      const verifier = digest(code);
      const emailEnabled = emailDeliveryEnabled(db, c);
      if (emailEnabled) acceptEmailReset(db, verifier);
      const current = db.one(
        `SELECT p.claim_id,p.expires_at FROM password_resets p JOIN users u ON u.id=p.user_id
         WHERE p.verifier=? AND p.expires_at>? AND p.generation=u.auth_generation
         AND (p.claimed_by IS NULL OR p.claimed_by=?) ${liveEmailReset}`,
        verifier,
        now(),
        browser.id,
        Number(emailEnabled),
      );
      if (!current) return null;
      db.run('DELETE FROM recovery_receipts WHERE browser_id=?', browser.id);
      db.run(
        'DELETE FROM password_resets WHERE claimed_by=? AND verifier<>?',
        browser.id,
        verifier,
      );
      db.run('UPDATE password_resets SET claimed_by=? WHERE verifier=?', browser.id, verifier);
      const grant = reserveAnonymousTime(db, c, r, browser, current.expires_at);
      const remainingMs = remainingLifetime(current.expires_at);
      if (remainingMs <= 0) throw invalidReset();
      return { claim_id: current.claim_id, recovery_expires_in_ms: remainingMs, grant };
    });
    if (!result) throw invalidReset();
    const { grant, ...claim } = result;
    if (grant) sendSession(c, reply, grant);
    return claim;
  });

  app.post('/api/auth/recover/complete', accountEntry('anonymous'), async (r, reply) => {
    const { password, claim_id } = z
      .strictObject({ password: accountPassword, claim_id: claimId })
      .parse(r.body);
    let original: { verifier: string; user_id: string; generation: number } | undefined;
    const hash = await hashPassword(password, () => {
      original = db.transaction(() => {
        const browser = requireSession(db, r, c, ['anonymous']);
        const claim = db.one(
          `SELECT p.verifier,p.user_id,p.generation FROM password_resets p JOIN users u ON p.user_id=u.id
           WHERE p.claimed_by=? AND p.claim_id=? AND p.expires_at>? AND p.generation=u.auth_generation ${liveEmailReset}`,
          browser.id,
          claim_id,
          now(),
          Number(emailDeliveryEnabled(db, c)),
        );
        if (!claim) throw invalidReset();
        chargeBudgets(db, r, [['recovery-complete', 5, 300]]);
        return { verifier: claim.verifier, user_id: claim.user_id, generation: claim.generation };
      });
    });
    const claim = original;
    if (!claim) throw invalidReset();
    const result = db.transaction(() => {
      const live = requireSession(db, r, c, ['anonymous']);
      const target = db.one(
        `DELETE FROM password_resets AS p WHERE claim_id=? AND claimed_by=? AND expires_at>?
         AND verifier=? AND user_id=? AND generation=?
         AND EXISTS(SELECT 1 FROM users u WHERE u.id=p.user_id AND p.generation=u.auth_generation ${liveEmailReset})
         RETURNING user_id`,
        claim_id,
        live.id,
        now(),
        claim.verifier,
        claim.user_id,
        claim.generation,
        Number(emailDeliveryEnabled(db, c)),
      );
      if (!target) throw invalidReset();
      revokeUserSessions(db, target.user_id);
      db.run('UPDATE users SET password_hash=? WHERE id=?', hash, target.user_id);
      const receiptExpires = now() + passwordResetLifetime;
      db.run(
        `INSERT INTO recovery_receipts(browser_id,user_id,claim_hash,attempt_hash,generation,expires_at)
         SELECT ?,id,?,?,auth_generation,? FROM users WHERE id=?`,
        live.id,
        digest(claim_id),
        digest(attemptReceipt(claim.verifier)),
        receiptExpires,
        target.user_id,
      );
      db.audit(target.user_id, 'account.password_recovered', {
        target: target.user_id,
        address: r.clientAddress,
      });
      const username = db.one('SELECT username FROM users WHERE id=?', target.user_id)!.username;
      const grant = reserveAnonymousTime(db, c, r, live, receiptExpires);
      return { username, grant };
    });
    if (result.grant) sendSession(c, reply, result.grant);
    return { ok: true, username: result.username };
  });
}
