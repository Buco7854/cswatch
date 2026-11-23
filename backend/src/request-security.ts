import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { equal, HttpError } from './security.js';

export const connectionTimeoutMs = 30_000;

export function acceptsHtml(r: FastifyRequest) {
  return r.headers.accept?.split(',').some((value) => value.split(';')[0].trim() === 'text/html');
}

const validated = new WeakSet<FastifyRequest>();
export function firstPartyRequest(r: FastifyRequest, c: Config) {
  if (r.method !== 'GET' && r.method !== 'HEAD') return validated.has(r);
  const site = r.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  if (r.headers.origin !== undefined) return r.headers.origin === c.appUrl;
  if (site === 'same-origin') return true;
  const context = r.headers['x-session-context'];
  return typeof context === 'string' && !!r.authSession && equal(context, r.authSession.csrf);
}
export function requireMutationRequest(
  request: FastifyRequest,
  config: Config,
  csrf: string | undefined,
  json: boolean,
) {
  if (
    request.headers.origin !== config.appUrl ||
    ['same-site', 'cross-site'].includes(request.headers['sec-fetch-site'] ?? '')
  )
    throw new HttpError(403, 'Request origin was rejected.');
  if (!csrf || !equal(String(request.headers['x-csrf-token'] || ''), csrf))
    throw new HttpError(403, 'Session expired. Refresh the page and try again.');
  if (
    json &&
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
  )
    throw new HttpError(415, 'Use a JSON request.');
  validated.add(request);
}
