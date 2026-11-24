import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { adminNetworkAllowed, adminNetworkDenial } from '../src/admin-network.js';
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
  assert.equal(allowed('10.0.0.2', { 'x-real-ip': '192.0.2.3' }), true);
  assert.equal(allowed('::ffff:10.0.0.2', { 'x-real-ip': '::ffff:192.0.2.3' }), true);
  assert.equal(allowed('10.0.0.2', { 'x-real-ip': '2001:db8:1::3' }), true);
  assert.equal(allowed('10.0.0.2', { 'x-real-ip': '10.0.0.1' }), false);
  assert.equal(allowed('10.0.0.2', { 'x-real-ip': '192.0.2.3, 10.0.0.1' }), false);
  assert.equal(allowed('10.0.0.2', { 'x-real-ip': 'not-an-address' }), false);
  assert.equal(allowed('192.0.2.3', { 'x-real-ip': '192.0.2.4' }), false);
  assert.equal(allowed('10.0.0.2', { 'x-real-ip': '192.0.2.3', 'x-forwarded-for': '' }), false);
  assert.equal(
    allowed('10.0.0.2', { 'x-real-ip': '192.0.2.3' }, [
      'X-Real-IP',
      '192.0.2.3',
      'x-real-ip',
      '192.0.2.3',
    ]),
    false,
  );
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

test('network diagnostics identify the decision using only canonical socket and verified client addresses', () => {
  const config = loadConfig({
    APP_URL: 'https://watch.example',
    ADMIN_ALLOWED_IPS: '192.168.0.0/16',
    TRUSTED_PROXY_IPS: '192.168.0.0/16',
  });
  function report(
    remoteAddress: string | undefined,
    headers: Record<string, string> = {},
    rawHeaders = Object.entries(headers).flat(),
  ) {
    return adminNetworkDenial(
      { raw: { socket: { remoteAddress }, rawHeaders }, headers } as FastifyRequest,
      config,
    );
  }
  const proxy = '192.168.1.151';
  assert.equal(report(proxy), null);
  assert.equal(report(proxy, { 'x-real-ip': '192.168.5.8' }), null);
  assert.equal(
    report(proxy, { 'x-forwarded-for': '203.0.113.9, 192.168.4.1' })?.diagnostic.client,
    '203.0.113.9',
  );
  assert.deepEqual(report('::ffff:172.18.0.2', { 'x-real-ip': '192.168.1.1' })?.diagnostic, {
    connection: '172.18.0.2',
    client: null,
    issue: 'untrusted_proxy',
  });
  assert.equal(report(undefined)?.diagnostic.issue, 'socket_unavailable');
  for (const [headers, issue] of [
    [{ 'x-forwarded-proto': 'https' }, 'missing_address'],
    [{ forwarded: 'for=invalid' }, 'unsupported_header'],
    [{ 'x-real-ip': 'invalid' }, 'invalid_address'],
    [{ 'x-real-ip': '192.168.8.1', 'x-forwarded-for': '192.168.4.1' }, 'conflicting_addresses'],
  ] as [Record<string, string>, string][]) {
    assert.deepEqual(report(proxy, headers)?.diagnostic, {
      connection: proxy,
      client: null,
      issue,
    });
  }
  assert.equal(
    report(proxy, { 'x-real-ip': '192.168.7.1' }, ['X-Real-IP', 'unknown', 'X-Real-IP', 'unknown'])
      ?.diagnostic.issue,
    'duplicate_header',
  );
});
