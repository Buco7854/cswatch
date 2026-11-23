import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { adminNetworkAllowed } from '../src/admin-network.js';
import { loadConfig } from '../src/config.js';

test('restricted administration identifies direct clients and resolves trusted edge addresses', () => {
  const config = loadConfig({
    APP_URL: 'https://watch.example',
    ADMIN_ALLOWED_IPS: '192.0.2.0/25,2001:db8:1::/48',
    TRUSTED_PROXY_IPS: '10.0.0.1,10.0.0.2',
  });
  const allowed = (
    remoteAddress: string,
    headers: Record<string, string> = {},
    rawHeaders = Object.entries(headers).flat(),
  ) =>
    adminNetworkAllowed(
      {
        raw: { socket: { remoteAddress }, rawHeaders },
        headers,
      } as FastifyRequest,
      config,
    );
  assert.equal(allowed('::ffff:192.0.2.1'), true);
  assert.equal(allowed('192.0.2.128'), false);
  assert.equal(allowed('2001:db8:1::2'), true);
  assert.equal(allowed('10.0.0.2', { 'x-forwarded-for': '192.0.2.3, 10.0.0.1' }), true);
  const clientHeader = { 'x-forwarded-for': '192.0.2.3' };
  assert.equal(allowed('10.0.0.2', { ...clientHeader, 'x-real-ip': '192.0.2.3' }), true);
  assert.equal(allowed('10.0.0.2', { ...clientHeader, 'x-real-ip': '192.0.2.4' }), false);
  const repeated = ['X-Forwarded-For', '192.0.2.3', 'x-forwarded-for', '192.0.2.3'];
  assert.equal(allowed('10.0.0.2', clientHeader, repeated), false);
  assert.equal(allowed('10.0.0.2'), false);
  assert.equal(allowed('192.0.2.3', { 'x-forwarded-proto': 'https' }), false);
});
test('network configuration rejects malformed or ambiguous entries before serving requests', () => {
  for (const value of [
    '127.1',
    '127.0.0.999',
    '10.0.0.1/33',
    '::/129',
    '::ffff:192.0.2.0/95',
    '::1,,10.0.0.1',
    '::1%lo',
    '10.0.0.1/0/1',
  ])
    assert.throws(
      () => loadConfig({ APP_URL: 'https://watch.example', ADMIN_ALLOWED_IPS: value }),
      /ADMIN_ALLOWED_IPS/,
    );
});
