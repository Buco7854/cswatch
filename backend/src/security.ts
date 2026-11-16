import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as argon2 from 'argon2';
import type { Store } from './db.js';
import { now } from './db.js';
import type { Config } from './config.js';
export const COOKIE = 'cswatch_session';
export const token = () => randomBytes(32).toString('hex');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export type SessionUser = { id: string; username: string; is_admin: number; csrf: string };
declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}
export const hashPassword = (password: string) =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2 });
const dummy = hashPassword(token());
export async function verifyPassword(hash: string | null | undefined, password: string) {
  try {
    const valid = await argon2.verify(hash || (await dummy), password);
    return valid && Boolean(hash);
  } catch {
    return false;
  }
}
export function currentUser(db: Store, request: FastifyRequest): SessionUser | null {
  const raw = request.cookies[COOKIE];
  if (!raw || raw.length > 100) return null;
  return (
    (db.one(
      'SELECT u.id,u.username,u.is_admin,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
      digest(raw),
      now(),
    ) as SessionUser) ?? null
  );
}
export function requireUser(request: FastifyRequest) {
  if (!request.user) throw new HttpError(401, 'Sign in to continue.');
  return request.user;
}
export function requireAdmin(request: FastifyRequest) {
  const u = requireUser(request);
  if (!u.is_admin) throw new HttpError(403, 'Administrator access required.');
  return u;
}
export function rateLimit(
  db: Store,
  request: FastifyRequest,
  scope: string,
  max: number,
  seconds = 900,
  identity?: string,
) {
  const key = digest(scope + ':' + (identity || request.ip));
  db.transaction(() => {
    db.run('DELETE FROM rate_limits WHERE expires_at<?', now());
    const r = db.one('SELECT count FROM rate_limits WHERE key=?', key);
    if (r && r.count >= max) throw new HttpError(429, 'Too many requests. Try again later.');
    db.run(
      'INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
      key,
      1,
      now() + seconds,
    );
  });
}
export function newSession(
  db: Store,
  config: Config,
  request: FastifyRequest,
  reply: FastifyReply,
  uid: string,
) {
  const raw = token(),
    csrf = token();
  db.transaction(() => {
    db.run('DELETE FROM sessions WHERE expires_at<?', now());
    const old = request.cookies[COOKIE];
    if (old) db.run('DELETE FROM sessions WHERE token_hash=?', digest(old));
    db.run(
      'INSERT INTO sessions VALUES(?,?,?,?)',
      digest(raw),
      uid,
      csrf,
      now() + config.sessionDays * 86400,
    );
  });
  reply.setCookie(COOKIE, raw, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionDays * 86400,
  });
  return csrf;
}

/** Keep authentication intent local. Never redirect to user-supplied external origins or API routes. */
export function safeReturnPath(value: unknown, fallback = '/library') {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\r\n]/.test(value) ||
    value.length > 1024
  )
    return fallback;
  try {
    const url = new URL(value, 'https://cswatch.invalid');
    if (
      url.origin !== 'https://cswatch.invalid' ||
      !/^\/(?:library|connections|account|explore|watch\/[A-Za-z0-9_-]+)(?:\/)?$/.test(url.pathname)
    )
      return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
