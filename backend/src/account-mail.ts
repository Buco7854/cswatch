import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountEntry } from './auth-routes.js';
import { emailDeliveryEnabled, type Config } from './config.js';
import { accountEmail } from './credentials.js';
import { now, type Store } from './db.js';
import { passwordResetLifetime } from './recovery.js';
import {
  chargeBudgets,
  digest,
  HttpError,
  requireSession,
  revokeUserSessions,
  rotateSession,
  sendSession,
  token,
} from './security.js';
import { submitAccountMessage } from './smtp.js';

const verificationLifetime = 30 * 60;
const queueCapacity = 8;
const concurrency = 2;
const maximumWaitMs = 30_000;
type Purpose = 'verification' | 'recovery';
const tables = { verification: 'email_verifications', recovery: 'email_recovery_codes' } as const;
type Address = { id: string; email: string; email_revision: number; auth_generation: number };
type MailRequest = { language: 'en' | 'fr'; queuedAt: number } & (
  { purpose: 'verification'; address: Address } | { purpose: 'recovery'; email: string }
);
type Delivery = { address: Address; code: string };

const languageFor = (locale?: string) =>
  /^fr(?:[-;,\s]|$)/i.test(locale?.trim() ?? '') ? 'fr' : 'en';

function addressForVerification(db: Store, userId: string): Address | undefined {
  return db.one(
    `SELECT id,email,email_revision,auth_generation FROM users u
     WHERE id=? AND email IS NOT NULL AND email_verified_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id)`,
    userId,
  ) as Address | undefined;
}

function addressForRecovery(db: Store, email: string): Address | undefined {
  return db.one(
    `SELECT id,email,email_revision,auth_generation FROM users u
     WHERE email=? COLLATE NOCASE AND email_verified_at IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id)
     AND NOT EXISTS(SELECT 1 FROM password_resets p WHERE p.user_id=u.id
       AND p.generation=u.auth_generation AND p.expires_at>?)
     AND NOT EXISTS(SELECT 1 FROM recovery_receipts r WHERE r.user_id=u.id
       AND r.generation=u.auth_generation AND r.expires_at>?)`,
    email,
    now(),
    now(),
  ) as Address | undefined;
}

function sameAddress(expected: Address, current: Address | undefined) {
  return (
    current?.id === expected.id &&
    current?.email === expected.email &&
    current?.email_revision === expected.email_revision
  );
}

function messageFor(c: Config, job: MailRequest, delivery: Delivery) {
  const verifying = job.purpose === 'verification';
  const link = `${c.appUrl}/${verifying ? 'verify-email' : 'recover'}#${delivery.code}`;
  const copy =
    job.language === 'fr'
      ? verifying
        ? [
            'Vérifiez votre adresse e-mail cswatch',
            'Ouvrez ce lien dans un navigateur où vous êtes connecté à votre compte cswatch pour confirmer votre adresse. Le lien expire dans 30 minutes.',
            'Si vous n’avez pas demandé cette vérification, vous pouvez ignorer ce message.',
          ]
        : [
            'Réinitialisez votre mot de passe cswatch',
            'Ouvrez ce lien pour choisir un nouveau mot de passe cswatch. Le lien expire dans 10 minutes.',
            'Si vous n’avez pas demandé cette réinitialisation, vous pouvez ignorer ce message.',
          ]
      : verifying
        ? [
            'Verify your cswatch email address',
            'Open this link in a browser signed in to your cswatch account to confirm your email address. The link expires in 30 minutes.',
            'If you did not request this verification, you can ignore this message.',
          ]
        : [
            'Reset your cswatch password',
            'Open this link to choose a new cswatch password. The link expires in 10 minutes.',
            'If you did not request a password reset, you can ignore this message.',
          ];
  const [subject, instructions, unsolicited] = copy;
  return {
    to: delivery.address.email,
    subject,
    body: `${instructions}\n\n${link}\n\n${unsolicited}`,
  };
}

/** Called in the same write transaction as an operator disable. */
export function retireAccountMail(db: Store) {
  db.run(`DELETE FROM sessions WHERE user_id IN (
    SELECT id FROM users WHERE email_verification_required=1 AND email_verified_at IS NULL
  )`);
  db.run('UPDATE users SET email_verification_required=0 WHERE email_verification_required=1');
  db.run('DELETE FROM email_verifications');
  db.run('DELETE FROM email_recovery_codes');
  db.run('DELETE FROM password_resets WHERE email_revision IS NOT NULL');
}

export class AccountMail {
  private readonly pending: MailRequest[] = [];
  private readonly active = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private scheduled = false;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly warn: () => void,
  ) {}

  queueVerification(userId: string, locale?: string) {
    try {
      if (!emailDeliveryEnabled(this.db, this.config)) return;
      const address = addressForVerification(this.db, userId);
      if (address)
        this.enqueue({
          purpose: 'verification',
          address,
          language: languageFor(locale),
          queuedAt: Date.now(),
        });
    } catch {
      this.warn();
    }
  }

  queueRecovery(email: string, locale?: string) {
    this.enqueue({
      purpose: 'recovery',
      email,
      language: languageFor(locale),
      queuedAt: Date.now(),
    });
  }

  clearPending() {
    this.pending.length = 0;
  }

  async close() {
    this.abort.abort();
    this.clearPending();
    await Promise.all(this.active);
  }

  private enqueue(job: MailRequest) {
    if (this.abort.signal.aborted || this.pending.length + this.active.size >= queueCapacity)
      return;
    this.pending.push(job);
    this.schedule();
  }

  private schedule() {
    if (this.scheduled || !this.pending.length || this.active.size >= concurrency) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      while (this.pending.length && this.active.size < concurrency) {
        const job = this.pending.shift()!;
        if (Date.now() - job.queuedAt > maximumWaitMs) continue;
        const task = this.deliver(job)
          .catch(() => {
            if (!this.abort.signal.aborted) this.warn();
          })
          .finally(() => {
            this.active.delete(task);
            this.schedule();
          });
        this.active.add(task);
      }
    });
  }

  private prepare(job: MailRequest) {
    const { db, config } = this;
    const table = tables[job.purpose];
    return db.transaction(() => {
      if (!emailDeliveryEnabled(db, config)) return;
      const time = now();
      const verifying = job.purpose === 'verification';
      const address = verifying
        ? addressForVerification(db, job.address.id)
        : addressForRecovery(db, job.email);
      if (!address || (verifying && !sameAddress(job.address, address))) return;
      db.run(`DELETE FROM ${table} WHERE expires_at<=?`, time);
      const prior = db.one(
        `SELECT 1 FROM ${table} WHERE user_id=? AND email_revision=? AND ${verifying ? 'created_at>?' : 'generation=?'}`,
        address.id,
        address.email_revision,
        verifying ? time - 60 : address.auth_generation,
      );
      if (prior) return;
      chargeBudgets(db, { ip: 'unknown' }, [
        ['account-mail-delivery', 60, 3600, 'instance'],
        ['account-mail-recipient', 5, 3600, address.email],
      ]);
      const code = token();
      if (verifying)
        db.run(
          `INSERT INTO email_verifications(user_id,verifier,email_revision,created_at,expires_at)
           VALUES(?,?,?,?,?)`,
          address.id,
          digest(code),
          address.email_revision,
          time,
          time + verificationLifetime,
        );
      else
        db.run(
          `INSERT INTO email_recovery_codes(user_id,verifier,generation,email_revision,expires_at)
           VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET verifier=excluded.verifier,
           generation=excluded.generation,email_revision=excluded.email_revision,expires_at=excluded.expires_at`,
          address.id,
          digest(code),
          address.auth_generation,
          address.email_revision,
          time + passwordResetLifetime,
        );
      return { address, code };
    });
  }

  private async deliver(job: MailRequest) {
    const { db, config } = this;
    const smtp = config.smtp;
    if (!smtp || this.abort.signal.aborted) return;
    let delivery: Delivery | undefined;
    try {
      delivery = this.prepare(job);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 429) return;
      throw error;
    }
    if (!delivery) return;
    const { address, code } = delivery;
    const table = tables[job.purpose];
    const verifier = digest(code);
    const current = () => {
      if (!emailDeliveryEnabled(db, config)) return false;
      const live =
        job.purpose === 'verification'
          ? addressForVerification(db, address.id)
          : addressForRecovery(db, address.email);
      return (
        sameAddress(address, live) &&
        (job.purpose === 'verification' || live?.auth_generation === address.auth_generation) &&
        Boolean(db.one(`SELECT 1 FROM ${table} WHERE verifier=? AND expires_at>?`, verifier, now()))
      );
    };
    let mayHaveDelivered = false;
    try {
      await submitAccountMessage(
        smtp,
        messageFor(config, job, delivery),
        this.abort.signal,
        current,
        (possible) => {
          mayHaveDelivered = possible;
        },
      );
    } finally {
      // Once DATA began, an acknowledgement can be lost after relay acceptance.
      if (!mayHaveDelivered) db.run(`DELETE FROM ${table} WHERE verifier=?`, verifier);
    }
  }
}

export function accountMailRoutes(app: FastifyInstance, db: Store, c: Config, mail: AccountMail) {
  const enabled = () => {
    if (!emailDeliveryEnabled(db, c))
      throw new HttpError(
        409,
        'Email delivery is unavailable.',
        undefined,
        'email_delivery_unavailable',
      );
  };
  app.post('/api/account/email/verification/request', accountEntry('full', true), (r) => {
    z.strictObject({}).parse(r.body);
    const userId = db.transaction(() => {
      const session = requireSession(db, r, c, ['full']);
      enabled();
      chargeBudgets(db, r, [['account-mail-verify-request', 10, 600, session.user_id]]);
      return session.user_id;
    });
    mail.queueVerification(userId, r.headers['accept-language']);
    return { ok: true };
  });

  app.post('/api/auth/email/verify', accountEntry('full', true), (r, reply) => {
    const { code } = z.strictObject({ code: z.string().regex(/^[0-9a-f]{64}$/) }).parse(r.body);
    const verified = db.transaction(() => {
      const session = requireSession(db, r, c, ['full']);
      enabled();
      chargeBudgets(db, r, [
        ['account-mail-verify', 20, 300],
        ['account-mail-verify-user', 20, 300, session.user_id],
      ]);
      const verification = db.one(
        `DELETE FROM email_verifications AS v WHERE user_id=? AND verifier=? AND expires_at>?
         AND EXISTS(SELECT 1 FROM users u WHERE u.id=v.user_id AND u.email IS NOT NULL
           AND u.email_verified_at IS NULL AND u.email_revision=v.email_revision)
         RETURNING user_id`,
        session.user_id,
        digest(code),
        now(),
      );
      if (!verification) return null;
      db.run('DELETE FROM email_verifications WHERE user_id=?', session.user_id);
      db.run(
        'UPDATE users SET email_verified_at=?,email_verification_required=0 WHERE id=?',
        now(),
        session.user_id,
      );
      db.audit(session.user_id, 'account.email_verified', {
        target: session.user_id,
        address: r.clientAddress,
      });
      if (!session.email_verification_required) return {};
      // Only the browser that supplied the link can inherit an existing timed grant.
      revokeUserSessions(db, session.user_id);
      const proof =
        session.proof_kind && session.proof_at !== null
          ? { kind: session.proof_kind, at: session.proof_at }
          : undefined;
      return { grant: rotateSession(db, c, r, { userId: session.user_id, stage: 'full', proof }) };
    });
    if (!verified)
      throw new HttpError(
        400,
        'This verification link has expired or was already used.',
        undefined,
        'email_verification_invalid',
      );
    return verified.grant ? { ok: true, ...sendSession(c, reply, verified.grant) } : { ok: true };
  });

  app.post('/api/auth/recover/request', accountEntry('anonymous'), (r) => {
    const { email } = z.strictObject({ email: accountEmail }).parse(r.body);
    let admitted = false;
    try {
      admitted = db.transaction(() => {
        requireSession(db, r, c, ['anonymous']);
        if (!emailDeliveryEnabled(db, c)) return false;
        chargeBudgets(db, r, [
          ['account-mail-recovery-request', 10, 600],
          ['account-mail-recovery-request-global', 240, 600, 'instance'],
        ]);
        return true;
      });
    } catch (error) {
      if (!(error instanceof HttpError && error.statusCode === 429)) throw error;
    }
    if (admitted) mail.queueRecovery(email, r.headers['accept-language']);
    return { ok: true };
  });
}
