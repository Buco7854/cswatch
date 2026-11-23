import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adminAccess,
  adminAccountReadRecorder,
  auditAdmin,
  setAdminAuditAction,
} from './admin-access.js';
import type { Config } from './config.js';
import { auditOutcomes, now, type Store } from './db.js';
import { enqueueUserDemoDeletion } from './demo-deletion.js';
import { issuePasswordReset } from './recovery.js';
import { roles } from './roles.js';
import {
  activeUserSessions,
  canSignIn,
  unlinkSteamIdentity,
  signableAdminExists,
  hasSecondFactor,
  HttpError,
  rateLimit,
  revokeUserSessions,
  rotateSession,
  sendSession,
} from './security.js';

const pageSize = 25;
const offset = z.coerce.number().int().min(0).max(100000).default(0);
const accountId = z.string().regex(/^[a-f0-9]{32}$/);
const role = z.enum(roles);
const accountProjection = 'id, username, display_name, role, created_at';
const accountScope = 'NOT EXISTS (SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id)';
const actions = [
  'change-role',
  'sign-out',
  'reset-password',
  'reset-totp',
  'reset-passkeys',
  'reset-recovery',
  'unlink-steam',
  'unlink-faceit',
  'delete',
] as const;
const actionBody = z
  .object({ action: z.enum(actions), role: role.optional() })
  .strict()
  .refine((body) => (body.action === 'change-role') === (body.role !== undefined));

function account(db: Store, id: string) {
  const user = db.one(
    `SELECT ${accountProjection},last_active FROM users u WHERE id=? AND ${accountScope}`,
    id,
  );
  if (!user) throw new HttpError(404, 'This account no longer exists.');
  return user;
}

/** Check the effective result under the same write lock as a credential, role or policy change. */
export function requireSignableAdmin(db: Store, config: Config) {
  if (!signableAdminExists(db, config))
    throw new HttpError(409, 'Keep at least one administrator who can sign in.');
}

function applyAccountAction(db: Store, c: Config, id: string, body: z.infer<typeof actionBody>) {
  const prior = account(db, id);
  if (body.action === 'change-role' && body.role === prior.role) return { ok: true };

  let recoveryCode: string | undefined;
  switch (body.action) {
    case 'change-role':
      db.run('UPDATE users SET role=? WHERE id=?', body.role, id);
      break;
    case 'reset-password':
      db.run('UPDATE users SET password_hash=NULL WHERE id=?', id);
      break;
    case 'reset-totp':
      db.run('DELETE FROM auth_totp WHERE user_id=?', id);
      break;
    case 'reset-passkeys':
      db.run('DELETE FROM auth_passkeys WHERE user_id=?', id);
      break;
    case 'reset-recovery':
      db.run('DELETE FROM auth_recovery_codes WHERE user_id=?', id);
      break;
    case 'unlink-steam':
      unlinkSteamIdentity(db, id);
      break;
    case 'unlink-faceit':
      db.run("DELETE FROM identities WHERE provider='faceit' AND user_id=?", id);
      break;
    case 'delete':
      enqueueUserDemoDeletion(db, c, id);
      db.run('DELETE FROM users WHERE id=?', id);
      break;
  }
  if (prior.role === 'admin' || body.role === 'admin') requireSignableAdmin(db, c);
  if (body.action !== 'delete') {
    // Session revocation keeps a valid recovery exchange for an already
    // stranded account. Explicit reset always replaces the exchange.
    const keepRecovery = body.action === 'sign-out';
    if (keepRecovery)
      db.run(
        'UPDATE password_resets SET generation=generation+1 WHERE user_id=? AND generation=(SELECT auth_generation FROM users WHERE id=?) AND expires_at>?',
        id,
        id,
        now(),
      );
    revokeUserSessions(db, id);
    if (
      (body.action === 'reset-totp' || body.action === 'reset-passkeys') &&
      !hasSecondFactor(db, id)
    )
      db.run('DELETE FROM auth_recovery_codes WHERE user_id=?', id);
    if (body.action === 'reset-password' || (!keepRecovery && !canSignIn(db, c, id)))
      recoveryCode = issuePasswordReset(db, id);
  }
  return {
    ok: true,
    recovery_code: recoveryCode,
    recovery_expires_in_ms: recoveryCode
      ? Math.max(
          0,
          db.one('SELECT expires_at FROM password_resets WHERE user_id=?', id)!.expires_at * 1000 -
            Date.now(),
        )
      : undefined,
  };
}

export function adminUserRoutes(app: FastifyInstance, db: Store, c: Config) {
  const recordAccountRead = adminAccountReadRecorder(db, c);

  app.get('/api/admin/users', (r) => {
    return db.transaction(() => {
      adminAccess(db, c, r, false);
      const query = z
        .object({ q: z.string().trim().max(120).default(''), role: role.optional(), offset })
        .strict()
        .parse(r.query);
      const clauses = [accountScope];
      const args: string[] = [];
      if (query.role) {
        clauses.push('role=?');
        args.push(query.role);
      }
      if (query.q) {
        const term = '%' + query.q.replace(/[\\%_]/g, '\\$&') + '%';
        clauses.push("(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')");
        args.push(term, term);
      }
      const where = clauses.join(' AND ');
      return {
        users: db.all(
          `SELECT ${accountProjection} FROM users u WHERE ${where}
           ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
          ...args,
          pageSize,
          query.offset,
        ),
        total: db.one(`SELECT count(*) AS total FROM users u WHERE ${where}`, ...args)!.total,
      };
    });
  });

  app.get<{ Params: { id: string } }>('/api/admin/users/:id', (r) => {
    const { details, commitAuditSample } = db.transaction(() => {
      adminAccess(db, c, r, false);
      const id = accountId.parse(r.params.id);
      const user = account(db, id);
      const details = {
        user,
        identities: db.all(
          'SELECT provider,subject FROM identities WHERE user_id=? ORDER BY provider',
          id,
        ),
        factors: {
          passkeys: db.one('SELECT count(*) AS count FROM auth_passkeys WHERE user_id=?', id)!
            .count,
          totp: Boolean(db.one('SELECT 1 FROM auth_totp WHERE user_id=?', id)),
          recovery_codes: db.one(
            'SELECT count(*) AS count FROM auth_recovery_codes WHERE user_id=?',
            id,
          )!.count,
        },
        sessions: activeUserSessions(db, id).map(({ id, device, address, last_used_at }) => ({
          id,
          device,
          address,
          last_used_at,
        })),
        storage: db.one(
          'SELECT count(*) AS demos,coalesce(sum(size),0) AS bytes FROM demos WHERE owner_id=?',
          id,
        ),
      };
      return { details, commitAuditSample: recordAccountRead(r, id) };
    });
    commitAuditSample?.();
    return details;
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/actions', (r, reply) => {
    const id = accountId.parse(r.params.id);
    const body = actionBody.parse(r.body);
    setAdminAuditAction(r, 'admin.user.' + body.action);
    const actor = adminAccess(db, c, r, true);
    rateLimit(db, r, 'admin-user-action', 60, 60, actor.user_id);
    const { result, anonymous } = db.transaction(() => {
      adminAccess(db, c, r, true);
      const result = applyAccountAction(db, c, id, body);
      auditAdmin(db, c, r, 'success');
      const endedOwnSession =
        id === actor.user_id &&
        !db.one('SELECT 1 FROM sessions WHERE token_hash=?', actor.token_hash);
      const anonymous = endedOwnSession
        ? rotateSession(db, c, r, { userId: null, stage: 'anonymous' })
        : null;
      return { result, anonymous };
    });
    return anonymous ? { ...result, ...sendSession(c, reply, anonymous) } : result;
  });

  app.get('/api/admin/audit', (r) => {
    return db.transaction(() => {
      adminAccess(db, c, r, false);
      const { offset: start, ...filters } = z
        .object({
          offset,
          action: z
            .string()
            .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
            .optional(),
          outcome: z.enum(auditOutcomes).optional(),
          target: z
            .string()
            .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
            .optional(),
        })
        .strict()
        .parse(r.query);
      const where = Object.entries(filters)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key + '=?')
        .join(' AND ');
      const args = Object.values(filters).filter((value) => value !== undefined);
      const scope = where ? 'WHERE ' + where : '';
      return {
        events: db.all(
          `SELECT id,actor,action,target,address,outcome,created_at,intent_id FROM audit ${scope}
           ORDER BY id DESC LIMIT ? OFFSET ?`,
          ...args,
          pageSize,
          start,
        ),
        total: db.one(`SELECT count(*) AS total FROM audit ${scope}`, ...args)!.total,
      };
    });
  });
}
