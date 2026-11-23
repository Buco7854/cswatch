import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config.js';
import { browserCookieName } from '../../src/security.js';

export async function browserBootstrap(app: FastifyInstance, c: Config, existingCookies?: string) {
  const r = await app.inject({
    url: '/api/auth/me',
    headers: { host: c.host, ...(existingCookies ? { cookie: existingCookies } : {}) },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().session.stage, 'anonymous');
  const session = r.cookies.find(({ name }) => name === browserCookieName(c));
  assert.ok(session);
  const sameJar = (existingCookies ?? '')
    .split('; ')
    .filter((entry) => entry && !r.cookies.some(({ name }) => entry.startsWith(name + '=')));
  return {
    host: c.host,
    origin: c.appUrl,
    cookie: sameJar.concat(r.cookies.map(({ name, value }) => name + '=' + value)).join('; '),
    'x-csrf-token': r.json().session.csrf as string,
  };
}
