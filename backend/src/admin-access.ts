import { firstPartyRequest, requireMutationRequest } from './request-security.js';
import type { FastifyRequest } from 'fastify';
import { adminAccountReadAuditAction, type AuditOutcome, type Store } from './db.js';
import type { Config } from './config.js';
import { adminClientAddress, adminNetworkAllowed } from './admin-network.js';
import { hasPermission } from './roles.js';
import { HttpError, rateAddress, requireFreshProof, requireSession } from './security.js';

export function adminAccess(db: Store, c: Config, request: FastifyRequest, mutation: boolean) {
  const session = requireSession(db, request, c, ['full']);
  if (!hasPermission(session.role, 'admin'))
    throw new HttpError(403, 'Administrator access required.');
  if (!mutation && adminApi(request.routeOptions.url) && !firstPartyRequest(request, c))
    throw new HttpError(403, 'Request origin was rejected.');
  if (!adminNetworkAllowed(request, c))
    throw new HttpError(
      403,
      'Administration is unavailable from this network.',
      undefined,
      'admin_network_denied',
    );
  if (mutation) {
    requireMutationRequest(request, c, session.csrf, true);
    requireFreshProof(db, c, session);
  }
  return session;
}

export function recheckAdminAccessOnFailure(
  db: Store,
  c: Config,
  request: FastifyRequest,
  mutation: boolean,
) {
  return (error: unknown): never => {
    adminAccess(db, c, request, mutation);
    throw error;
  };
}

/** API checks follow Fastify's matched template. The browser router accepts case and encoded path segments. */
export const adminApi = (template: string | undefined) =>
  template === '/api/admin' || template?.startsWith('/api/admin/') === true;

export function adminPage(rawUrl: string) {
  try {
    const path = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname).toLowerCase();
    return /^\/admin(?:\/|$)/.test(path);
  } catch {
    return false;
  }
}

function sampleOperatorAudit() {
  let minute = -1;
  let count = 0;
  const seen = new Map<string, Set<string>>();
  return (actor: string, subject: string, record: () => void) => {
    const window = Math.floor(Date.now() / 60000);
    if (window === minute && count >= 120) return;
    const subjects = (window === minute ? seen.get(actor) : undefined) ?? new Set<string>();
    if (subjects.size >= 20 || subjects.has(subject)) return;
    record();
    // The caller advances the sampler only once the audit transaction commits.
    return () => {
      if (window !== minute) {
        minute = window;
        count = 0;
        seen.clear();
      }
      subjects.add(subject);
      seen.set(actor, subjects);
      count++;
    };
  };
}

export function adminAccountReadRecorder(db: Store, c: Config) {
  const sample = sampleOperatorAudit();
  return (request: FastifyRequest, target: string) => {
    if (request.user && firstPartyRequest(request, c))
      return sample(request.user.id, target, () => auditAdmin(db, c, request, 'success'));
  };
}

export function adminDenialRecorder(db: Store, c: Config) {
  let minute = -1;
  const seen = [new Set<string>(), new Set<string>()];
  const sampleOperator = sampleOperatorAudit();
  return (request: FastifyRequest) => {
    if (request.headers.host !== c.host) return;
    const trusted = firstPartyRequest(request, c);
    if (trusted && request.user && hasPermission(request.user.role, 'admin')) {
      sampleOperator(request.user.id, adminAuditAction(request), () =>
        auditAdmin(db, c, request, 'denied'),
      )?.();
    } else {
      const window = Math.floor(Date.now() / 60000);
      if (window !== minute) {
        minute = window;
        for (const bucket of seen) bucket.clear();
      }
      const id = trusted ? request.authSession?.user_id : null;
      const bucket = seen[id ? 1 : 0];
      const keys = ['peer:' + rateAddress(request.ip)];
      if (id) keys.push('user:' + id);
      if (bucket.size >= 120 || keys.some((key) => bucket.has(key))) return;
      auditAdmin(db, c, request, 'denied');
      for (const key of keys) bucket.add(key);
    }
  };
}

const auditAction = new WeakMap<FastifyRequest, string>();
const accountedPublication = new WeakSet<FastifyRequest>();
export const adminPublicationAccountedFor = (request: FastifyRequest) =>
  accountedPublication.has(request);
const auditRoutes: Readonly<Record<string, string>> = {
  'GET /api/admin': 'admin.read',
  'PATCH /api/admin': 'settings.updated',
  'PUT /api/admin/mfa-policy': 'admin.mfa-policy',
  'GET /api/admin/users': 'admin.users.read',
  'GET /api/admin/users/:id': adminAccountReadAuditAction,
  'POST /api/admin/users/:id/actions': 'admin.user.action',
  'GET /api/admin/audit': 'admin.audit.read',
  'GET /api/admin/maps': 'admin.maps.read',
  'DELETE /api/admin/maps/:packId': 'map.removal_requested',
  'POST /api/admin/assets/presentation/:kind/retry': 'assets.retry_requested',
};

export function setAdminAuditAction(request: FastifyRequest, action: string) {
  auditAction.set(request, action);
}

function adminAuditAction(request: FastifyRequest) {
  const route = request.routeOptions.url;
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  return (
    auditAction.get(request) ??
    auditRoutes[method + ' ' + route] ??
    (adminPage(request.url) ? 'admin.page' : 'admin.request')
  );
}

export function auditAdmin(
  db: Store,
  c: Config,
  request: FastifyRequest,
  outcome: AuditOutcome,
  intentId?: number,
) {
  const params = request.params as { id?: string; packId?: string; kind?: string } | undefined;
  const target =
    params?.id &&
    /^[a-f0-9]{32}$/.test(params.id) &&
    (outcome === 'success' ||
      db.one(
        'SELECT 1 FROM users u WHERE id=? AND NOT EXISTS (SELECT 1 FROM guest_sessions WHERE owner_id=u.id)',
        params.id,
      ))
      ? params.id
      : (outcome === 'authorized' || intentId !== undefined) &&
          params?.packId &&
          /^[a-f0-9]{64}$/.test(params.packId)
        ? params.packId
        : params?.kind &&
            ['agents', 'equipment', 'equipment-models', 'viewmodels'].includes(params.kind)
          ? params.kind
          : null;
  const trusted = outcome !== 'denied' || firstPartyRequest(request, c);
  return db.audit(
    trusted ? (request.authSession?.user_id ?? null) : null,
    adminAuditAction(request),
    {
      address: adminClientAddress(request, c)?.ip,
      outcome,
      target,
      intentId,
      administrative: Boolean(trusted && request.user && hasPermission(request.user.role, 'admin')),
    },
  );
}

/** Commit the authorization intent before touching the external queue. Then
 * revalidate and hold the database write lock across synchronous publication. */
export function adminPublication(db: Store, c: Config, request: FastifyRequest) {
  return (write: () => void) => {
    const intent = db.transaction(() => {
      adminAccess(db, c, request, true);
      return auditAdmin(db, c, request, 'authorized');
    });
    accountedPublication.add(request);

    function finish(outcome: AuditOutcome) {
      try {
        auditAdmin(db, c, request, outcome, intent);
      } catch {
        request.log.error('Administration publication outcome could not be recorded');
      }
    }

    let writeStarted = false;
    try {
      db.transaction(() => {
        adminAccess(db, c, request, true);
        writeStarted = true;
        write();
      });
    } catch (error) {
      finish(writeStarted ? 'unknown' : 'denied');
      throw error;
    }
    finish('success');
  };
}
