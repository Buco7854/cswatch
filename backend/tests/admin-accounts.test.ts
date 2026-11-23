import assert from 'node:assert/strict';
import fs, {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ApprovedMapEntry } from '../../shared/map-acquisition.js';
import { adminPublication } from '../src/admin-access.js';
import { loadConfig } from '../src/config.js';
import { now, Store } from '../src/db.js';
import {
  cleanupDeletedDemos,
  createDemoScratch,
  demoWriteTimeoutMs,
  globalDemoStorage,
} from '../src/demo-deletion.js';
import { abandonUpload, reserve } from '../src/ingestion.js';
import { mapPackId } from '../src/map-catalog.js';
import { prepareMapJobs, readMapRequest, writeMapWorkerStatus } from '../src/map-jobs.js';
import { issuePasswordReset } from '../src/recovery.js';
import { COOKIE, digest, token } from '../src/security.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';
import { withRouteInventory } from './fixtures/route-inventory.js';
import { createApp } from '../src/server.js';

process.env.LOG_LEVEL = 'silent';
const host = 'localhost:8000';
const origin = 'http://' + host;

type Stage = 'challenge' | 'enroll' | 'full';
async function fixture(
  t: TestContext,
  env: NodeJS.ProcessEnv = {},
  register?: (app: FastifyInstance) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-admin-'));
  const frontend = join(root, 'frontend');
  mkdirSync(frontend);
  writeFileSync(join(frontend, 'index.html'), '<!doctype html><title>Test app</title>');
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    FRONTEND_DIR: frontend,
    ...env,
  });
  const db = new Store(root);
  function user(username: string, role: 'admin' | 'member' = 'member', password = true) {
    const id = token().slice(0, 32);
    db.run(
      'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
      id,
      username,
      password ? 'fixture-password-marker' : null,
      role,
      now(),
    );
    return id;
  }
  function passkey(id: string) {
    db.run(
      `INSERT INTO auth_passkeys(id,user_id,name,public_key,counter,device_type,backed_up,created_at)
       VALUES(?,?,?, ?,0,'singleDevice',0,?)`,
      token(),
      id,
      'Fixture',
      Buffer.from([1]),
      now(),
    );
  }
  function session(userId: string, stage: Stage = 'full', stale = false) {
    const raw = token();
    const csrf = token();
    const id = token().slice(0, 32);
    db.run(
      `INSERT INTO sessions(id,token_hash,user_id,csrf,stage,generation,created_at,last_used_at,
        expires_at,proof_at,proof_kind,address,device)
       VALUES(?,?,?,?,?,(SELECT auth_generation FROM users WHERE id=?),?,?,?,?,'password','198.51.100.0/24','Fixture browser')`,
      id,
      digest(raw),
      userId,
      csrf,
      stage,
      userId,
      now(),
      now(),
      now() + 600,
      now() - (stale ? 360 : 0),
    );
    return { cookie: COOKIE + '=' + raw, 'x-csrf-token': csrf };
  }
  const owner = user('operator', 'admin');
  const { app, routes } = await withRouteInventory(() => createApp(config, db), register);
  const admin = session(owner);
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const inject = (options: InjectOptions = {}) =>
    app.inject({ ...options, headers: { host, origin, ...options.headers } });
  const action = (id: string, payload: Record<string, string | null>, headers = admin) =>
    inject({ method: 'POST', url: `/api/admin/users/${id}/actions`, payload, headers });
  return { app, routes, db, config, root, owner, admin, user, passkey, session, inject, action };
}

test('a bound administrative action signals loss of its original session', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const headers = { ...f.admin, 'x-session-context': f.admin['x-csrf-token'] };
  const before = f.db.flag(f.config, 'registrations_enabled');
  f.db.run('DELETE FROM sessions WHERE user_id=?', f.owner);
  const denied = await f.inject({
    method: 'PATCH',
    url: '/api/admin',
    headers,
    payload: { registrations_enabled: !before },
  });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal(denied.headers['x-session-changed'], '1');
  assert.equal(f.db.flag(f.config, 'registrations_enabled'), before);
});

test('admin network and session boundaries cover every registered route and the browser page', async (t) => {
  const f = await fixture(t, {
    MFA_REQUIRED_ROLES: 'none',
    ADMIN_ALLOWED_IPS: '198.51.100.0/24,2001:db8:c::/48',
  });
  const member = f.session(f.user('member'));
  const pending = f.session(f.owner, 'challenge');
  const stale = f.session(f.owner, 'full', true);
  await f.app.ready();
  const routes = f.routes
    .filter(({ path }) => path === '/api/admin' || path.startsWith('/api/admin/'))
    .map(({ method, path }) => ({
      method,
      url: path
        .replace(':id', f.owner)
        .replace(':packId', 'a'.repeat(64))
        .replace(':kind', 'agents'),
    }));
  assert.ok(routes.some((r) => r.url === '/api/admin/users' && r.method === 'GET'));
  assert.ok(routes.some((r) => r.url === '/api/admin/mfa-policy' && r.method === 'PUT'));
  for (const route of routes) {
    const read = route.method === 'GET' || route.method === 'HEAD';
    const sample = { ...route, ...(read ? {} : { payload: {} }) };
    const networkDenied = await f.inject({
      ...sample,
      headers: f.admin,
      remoteAddress: '203.0.113.5',
    });
    assert.equal(networkDenied.statusCode, 403, `${route.method} ${route.url}`);
    if (route.method !== 'HEAD') {
      assert.match(networkDenied.body, /from this network/);
      assert.equal(networkDenied.json().code, 'admin_network_denied');
    }
    const remoteAddress = '::ffff:198.51.100.8';
    for (const headers of [member, pending]) {
      const denied = await f.inject({ ...sample, remoteAddress, headers });
      assert.equal(denied.statusCode, 403, `${route.method} ${route.url}`);
    }
    const anonymous = await f.inject({ ...sample, remoteAddress });
    assert.equal(anonymous.statusCode, read ? 401 : 403, `${route.method} ${route.url}`);
    if (!read) {
      const noProof = await f.inject({ ...sample, remoteAddress, headers: stale });
      assert.equal(noProof.statusCode, 403);
      assert.match(noProof.body, /Confirm your identity/);
    }
  }
  const operatorDenials = () =>
    f.db.one("SELECT count(*) AS n FROM audit WHERE scope='operator' AND outcome='denied'")!.n;
  const beforeOrigin = operatorDenials();
  const invalidOrigin = await f.inject({
    method: 'POST',
    url: `/api/admin/users/${f.owner}/actions`,
    headers: { ...f.admin, origin: 'https://other.invalid' },
    remoteAddress: '198.51.100.8',
    payload: { action: 'sign-out' },
  });
  assert.equal(invalidOrigin.statusCode, 403);
  assert.equal(operatorDenials(), beforeOrigin);
  const crossSiteRead = await f.inject({
    url: '/api/admin/users/' + f.owner,
    headers: { ...f.admin, 'sec-fetch-site': 'cross-site' },
    remoteAddress: '198.51.100.8',
  });
  assert.equal(crossSiteRead.statusCode, 403);
  assert.equal(operatorDenials(), beforeOrigin);
  const plainRead = {
    url: '/api/admin/users/' + f.owner,
    remoteAddress: '198.51.100.8',
    headers: { host, cookie: f.admin.cookie },
  };
  assert.equal((await f.app.inject(plainRead)).statusCode, 403);
  assert.equal(
    (
      await f.app.inject({
        ...plainRead,
        headers: { ...plainRead.headers, 'x-session-context': f.admin['x-csrf-token'] },
      })
    ).statusCode,
    200,
  );
  assert.equal(operatorDenials(), beforeOrigin);
  const deniedPage = await f.inject({
    url: '/admin',
    remoteAddress: '203.0.113.5',
    headers: { ...f.admin, accept: 'text/html' },
  });
  assert.equal(deniedPage.statusCode, 403);
  assert.equal(deniedPage.headers.location, undefined);
  assert.match(deniedPage.headers['content-type'] as string, /^text\/html/);
  assert.equal(deniedPage.headers['cache-control'], 'no-store');
  const page = await f.inject({ url: '/admin', remoteAddress: '2001:db8:c::8', headers: f.admin });
  assert.equal(page.statusCode, 200, page.body);
  const memberPage = await f.inject({
    url: '/admin',
    remoteAddress: '198.51.100.8',
    headers: { ...member, accept: 'text/html' },
  });
  assert.equal(memberPage.statusCode, 403);
  assert.equal(memberPage.headers.location, undefined);
  assert.equal(memberPage.body, page.body);
  assert.equal(deniedPage.body, page.body);
  const config = await f.inject({
    url: '/api/config',
    remoteAddress: '203.0.113.5',
    headers: f.admin,
  });
  assert.equal(config.json().admin_access, false);
  assert.equal(config.json().admin_network_denial, 'outside_network');
  const unverifiable = await f.inject({
    url: '/api/config',
    remoteAddress: '198.51.100.8',
    headers: { ...f.admin, 'x-forwarded-for': '198.51.100.1' },
  });
  assert.equal(unverifiable.json().admin_access, false);
  assert.equal(unverifiable.json().admin_network_denial, 'unknown_client');
  for (const headers of [member, pending]) {
    const status = await f.inject({ url: '/api/config', remoteAddress: '203.0.113.5', headers });
    assert.equal(status.json().admin_access, false);
    assert.equal(status.json().admin_network_denial, undefined);
  }
  const library = await f.inject({
    url: '/api/demos',
    remoteAddress: '203.0.113.5',
    headers: f.admin,
  });
  assert.equal(library.statusCode, 200, library.body);
});

test('admin IP restrictions use the socket and a configured proxy chain', async (t) => {
  const f = await fixture(t, {
    MFA_REQUIRED_ROLES: 'none',
    ADMIN_ALLOWED_IPS: '198.51.100.0/24',
    TRUSTED_PROXY_IPS: '192.0.2.0/24,2001:db8:d::/48',
  });
  const url = '/api/admin/users';
  for (const [remoteAddress, forwardedFor, allowed] of [
    ['198.51.100.2', undefined, true],
    ['::ffff:198.51.100.2', undefined, true],
    ['192.0.2.2', '198.51.100.4, 2001:db8:d::2', true],
    ['192.0.2.2', '203.0.113.4, 2001:db8:d::2', false],
    ['192.0.2.2', undefined, false],
    ['192.0.2.2', '2001:db8:d::2', false],
    ['198.51.100.2', '198.51.100.2', false],
  ] as const) {
    const response = await f.inject({
      url,
      remoteAddress,
      headers: { ...f.admin, ...(forwardedFor && { 'x-forwarded-for': forwardedFor }) },
    });
    assert.equal(response.statusCode, allowed ? 200 : 403, response.body);
  }
  const singleHop = {
    remoteAddress: '192.0.2.2',
    headers: { ...f.admin, 'x-real-ip': '198.51.100.42' },
  };
  const page = await f.inject({ ...singleHop, url: '/admin' });
  assert.equal(page.statusCode, 200, page.body);
  assert.equal((await f.inject({ ...singleHop, url: '/api/config' })).json().admin_access, true);
  assert.equal((await f.inject({ ...singleHop, url })).statusCode, 200);
  assert.throws(
    () => loadConfig({ COOKIE_SECURE: 'false', ADMIN_ALLOWED_IPS: '192.0.2.1/40' }),
    /CIDR/,
  );
  assert.throws(
    () => loadConfig({ COOKIE_SECURE: 'false', ADMIN_ALLOWED_IPS: 'localhost' }),
    /IP addresses/,
  );
});

test('admin account pages paginate, exclude guests and withhold demo contents and credential materials', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const member = f.user('player_with_underscore');
  f.db.run(
    'UPDATE users SET display_name=?,last_active=? WHERE id=?',
    'Fixture Player',
    now(),
    member,
  );
  const guest = f.user('guest_identity');
  f.db.run(
    'INSERT INTO guest_sessions(owner_id,token_hash,csrf,expires_at) VALUES(?,?,?,?)',
    guest,
    token(),
    token(),
    now() + 60,
  );
  for (let i = 0; i < 27; i++) f.user('test_player_' + i);
  const session = f.session(member);
  f.passkey(member);
  const demoId = token().slice(0, 32);
  f.db.run(
    "INSERT INTO demos(id,owner_id,name,source,status,size,created_at) VALUES(?,?,'Private title','upload','ready',123,?)",
    demoId,
    member,
    now(),
  );
  const list = await f.inject({ url: '/api/admin/users?role=member&offset=25', headers: f.admin });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().total, 28);
  assert.equal(list.json().users.length, 3);
  const search = await f.inject({ url: '/api/admin/users?q=FIXTURE%20PLAYER', headers: f.admin });
  assert.equal(search.json().users[0].id, member);
  const literal = await f.inject({ url: '/api/admin/users?q=%25', headers: f.admin });
  assert.equal(literal.json().total, 0);
  const excluded = await f.inject({ url: `/api/admin/users/${guest}`, headers: f.admin });
  assert.equal(excluded.statusCode, 404);
  const detail = await f.inject({ url: `/api/admin/users/${member}`, headers: f.admin });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().storage, { demos: 1, bytes: 123 });
  assert.equal(detail.json().sessions.length, 1);
  assert.equal(detail.json().sessions[0].address, '198.51.100.0/24');
  assert.equal(detail.json().factors.passkeys, 1);
  for (const value of [
    session.cookie.split('=')[1],
    session['x-csrf-token'],
    'fixture-password-marker',
    'Private title',
    demoId,
  ])
    assert.ok(!detail.body.includes(value));
  assert.equal((await f.inject({ url: `/api/demos/${demoId}`, headers: f.admin })).statusCode, 404);
});

test('admin email changes require fresh proof, preserve handles and retire recovery', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const member = f.user('email_member');
  const other = f.user('other_member');
  const memberSession = f.session(member);
  f.db.run(
    'UPDATE users SET email=?,email_verified_at=? WHERE id=?',
    'prior@example.test',
    now(),
    member,
  );
  f.db.run('UPDATE users SET email=? WHERE id=?', 'reserved@example.test', other);
  issuePasswordReset(f.db, member);
  const change = (email: string, headers = f.admin) =>
    f.action(
      member,
      { action: 'change-email', expected_email: ' PRIOR@example.test ', email },
      headers,
    );
  assert.equal(
    (await f.action(member, { action: 'change-email', email: 'new@example.test' })).statusCode,
    400,
  );
  assert.equal(
    (await f.action(member, { action: 'sign-out', expected_email: null })).statusCode,
    400,
  );
  assert.equal((await change('denied@example.test', memberSession)).statusCode, 403);
  assert.equal(
    (await change('denied@example.test', f.session(f.owner, 'full', true))).statusCode,
    403,
  );
  const conflict = await change('RESERVED@example.test');
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'email_unavailable');
  assert.ok(f.db.one('SELECT 1 FROM password_resets WHERE user_id=?', member));

  const changed = await change('Changed@Example.Test');
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().recovery_code, undefined);
  assert.equal(f.db.one('SELECT 1 FROM password_resets WHERE user_id=?', member), undefined);
  assert.equal(f.db.one('SELECT 1 FROM sessions WHERE user_id=?', member), undefined);
  const renewed = f.session(member);
  const stale = await change('stale@example.test');
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'email_changed');
  assert.ok(
    f.db.one('SELECT 1 FROM sessions WHERE user_id=? AND csrf=?', member, renewed['x-csrf-token']),
  );
  const detail = await f.inject({ url: `/api/admin/users/${member}`, headers: f.admin });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().user.email, 'changed@example.test');
  assert.equal(detail.json().user.email_verified_at, null);
  assert.equal(detail.json().user.username, 'email_member');
  const list = await f.inject({ url: '/api/admin/users', headers: f.admin });
  assert.equal(list.json().users.find(({ id }: { id: string }) => id === member).email, undefined);
  assert.equal(
    f.db.one(
      "SELECT target FROM audit WHERE action='admin.user.change-email' AND outcome='success'",
    )?.target,
    member,
  );
  const withoutAddress = f.user('no_address');
  const added = await f.action(withoutAddress, {
    action: 'change-email',
    expected_email: null,
    email: 'first@example.test',
  });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal(
    f.db.one('SELECT email FROM users WHERE id=?', withoutAddress)?.email,
    'first@example.test',
  );
});

test('admin changes revoke pending grants and self-demotion requires another signable administrator', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const second = f.user('second_operator', 'admin');
  const secondSession = f.session(second);
  f.session(second, 'enroll');
  f.session(f.owner, 'challenge');
  const responses = await Promise.all([
    f.action(second, { action: 'change-role', role: 'member' }),
    f.action(f.owner, { action: 'change-role', role: 'member' }, secondSession),
  ]);
  const statuses = responses.map((response) => response.statusCode).sort();
  assert.equal(statuses[0], 200);
  assert.ok([401, 403].includes(statuses[1]));
  const remaining = f.db.one("SELECT id FROM users WHERE role='admin'")!.id;
  const demoted = remaining === f.owner ? second : f.owner;
  assert.equal(f.db.one('SELECT count(*) AS n FROM sessions WHERE user_id=?', demoted)!.n, 0);
  const survivor = remaining === f.owner ? f.admin : secondSession;
  const self = await f.action(remaining, { action: 'change-role', role: 'member' }, survivor);
  assert.equal(self.statusCode, 409);
  assert.equal(self.json().detail, 'Keep at least one administrator who can sign in.');
  const promote = await f.action(demoted, { action: 'change-role', role: 'admin' }, survivor);
  assert.equal(promote.statusCode, 200);
  const permitted = await f.action(remaining, { action: 'change-role', role: 'member' }, survivor);
  assert.equal(permitted.statusCode, 200);
  assert.equal(permitted.json().session.stage, 'anonymous');
  const resumed = await f.inject({
    url: '/api/auth/me',
    headers: { cookie: permitted.cookies.map((c) => c.name + '=' + c.value).join('; ') },
  });
  assert.equal(resumed.json().session.csrf, permitted.json().session.csrf);
  assert.equal(f.db.one("SELECT id FROM users WHERE role='admin'")!.id, demoted);
});

test('administrators still completing signup cannot be the last usable operator', async (t) => {
  const f = await fixture(t, {
    MFA_REQUIRED_ROLES: 'none',
    EMAIL_DELIVERY_ENABLED: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_FROM: 'sending@example.test',
    SMTP_USERNAME: 'fixture-mailer',
    SMTP_PASSWORD: 'synthetic-password',
  });
  const incompleteProfile = f.user('incomplete_profile', 'admin');
  const unverifiedAddress = f.user('unverified_address', 'admin');
  f.db.run('UPDATE users SET profile_required=1 WHERE id=?', incompleteProfile);
  f.db.run(
    'UPDATE users SET email=?,email_verification_required=1 WHERE id=?',
    'pending@example.test',
    unverifiedAddress,
  );
  for (const id of [incompleteProfile, unverifiedAddress]) {
    const gated = await f.inject({ url: '/api/admin', headers: f.session(id) });
    assert.equal(gated.statusCode, 403, gated.body);
    assert.equal(gated.json().code, 'account_onboarding_required');
  }
  const demote = () => f.action(f.owner, { action: 'change-role', role: 'member' });
  assert.equal((await demote()).statusCode, 409);
  assert.equal(f.db.one('SELECT role FROM users WHERE id=?', f.owner)?.role, 'admin');

  // Simulate an instance whose only remaining admins still need to finish signup.
  f.db.run("UPDATE users SET role='member' WHERE id=?", f.owner);
  const startupStore = new Store(f.root);
  try {
    await assert.rejects(() => createApp(f.config, startupStore), /No administrator can sign in/);
  } finally {
    startupStore.close();
    f.db.run("UPDATE users SET role='admin' WHERE id=?", f.owner);
  }
  f.db.run(
    'UPDATE users SET email_verified_at=?,email_verification_required=0 WHERE id=?',
    now(),
    unverifiedAddress,
  );
  assert.equal((await demote()).statusCode, 200);
});

test('recovery removes the old password immediately and renewed grants omit raw codes and provider secrets', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none', STEAM_ENABLED: 'true' });
  const sole = await f.action(f.owner, { action: 'reset-password' });
  assert.equal(sole.statusCode, 409);
  assert.equal(
    f.db.one('SELECT password_hash FROM users WHERE id=?', f.owner)!.password_hash,
    'fixture-password-marker',
  );
  const member = f.user('recovery_user');
  f.session(member);
  f.session(member, 'challenge');
  const reset = await f.action(member, { action: 'reset-password' });
  assert.equal(reset.statusCode, 200, reset.body);
  const { recovery_code: first, recovery_expires_in_ms } = reset.json();
  assert.ok(recovery_expires_in_ms > 0 && recovery_expires_in_ms <= 600_000);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(f.db.one('SELECT password_hash FROM users WHERE id=?', member)!.password_hash, null);
  assert.equal(
    f.db.one('SELECT verifier FROM password_resets WHERE user_id=?', member)!.verifier,
    digest(first),
  );
  assert.equal(f.db.one('SELECT count(*) AS n FROM sessions WHERE user_id=?', member)!.n, 0);
  const reissue = await f.action(member, { action: 'sign-out' });
  assert.equal(reissue.statusCode, 200, reissue.body);
  assert.equal(reissue.json().recovery_code, undefined);
  assert.ok(
    f.db.one(
      'SELECT 1 FROM password_resets p JOIN users u ON u.id=p.user_id WHERE p.verifier=? AND p.generation=u.auth_generation',
      digest(first),
    ),
  );
  const replacement = await f.action(member, { action: 'reset-password' });
  assert.match(replacement.json().recovery_code, /^[a-f0-9]{64}$/);
  assert.equal(
    f.db.one('SELECT 1 FROM password_resets WHERE verifier=?', digest(first)),
    undefined,
  );
  const beforePromotion = replacement.json().recovery_code;
  const browser = await f.inject({ url: '/api/auth/me' });
  const claimedHeaders = {
    cookie: browser.cookies.map((c) => c.name + '=' + c.value).join('; '),
    'x-csrf-token': browser.json().session.csrf,
  };
  const claimed = await f.inject({
    method: 'POST',
    url: '/api/auth/recover/claim',
    headers: claimedHeaders,
    payload: { code: beforePromotion },
  });
  assert.equal(claimed.statusCode, 200);
  const promotion = await f.action(member, { action: 'change-role', role: 'admin' });
  assert.equal(promotion.statusCode, 200, promotion.body);
  assert.match(promotion.json().recovery_code, /^[a-f0-9]{64}$/);
  assert.notEqual(promotion.json().recovery_code, beforePromotion);
  assert.equal(
    (
      await f.inject({
        method: 'POST',
        url: '/api/auth/recover/complete',
        headers: claimedHeaders,
        payload: { password: 'Synthetic-recovery-fixture', claim_id: claimed.json().claim_id },
      })
    ).statusCode,
    400,
  );
  const steam = f.user('steam_owner', 'member', false);
  f.db.run("INSERT INTO identities VALUES('steam','76561198000000001',?)", steam);
  f.db.run("INSERT INTO identities VALUES('faceit','faceit-fixture',?)", steam);
  f.db.run(
    "INSERT INTO steam_matches(user_id,match_id,code) VALUES(?,'1','private-match-code')",
    steam,
  );
  const unlink = await f.action(steam, { action: 'unlink-steam' });
  assert.equal(unlink.statusCode, 200, unlink.body);
  assert.match(unlink.json().recovery_code, /^[a-f0-9]{64}$/);
  assert.equal(f.db.one('SELECT 1 FROM identities WHERE user_id=?', steam), undefined);
  assert.equal(f.db.one('SELECT 1 FROM steam_matches WHERE user_id=?', steam), undefined);
  const audit = await f.inject({
    url: `/api/admin/audit?action=admin.user.unlink-steam&outcome=success&target=${steam}`,
    headers: f.admin,
  });
  assert.equal(audit.json().total, 1);
  assert.equal(audit.json().events[0].actor, f.owner);
  for (const value of [
    first,
    'private-match-code',
    '76561198000000001',
    unlink.json().recovery_code,
  ])
    assert.ok(!audit.body.includes(value));
  assert.equal(
    (await f.inject({ url: '/api/admin/audit?outcome=denied', headers: f.admin })).json().total,
    1,
  );
});

test('admin policy persists locked state and retired permissions', async (t) => {
  const f = await fixture(t);
  const second = f.user('second_operator', 'admin', false);
  f.db.run("INSERT INTO identities VALUES('steam','76561198000000001',?)", second);
  const member = f.user('member');
  const memberSession = f.session(member);
  f.passkey(f.owner);
  f.db.run("UPDATE sessions SET proof_kind='passkey' WHERE user_id=?", f.owner);
  const get = await f.inject({ url: '/api/admin', headers: f.admin });
  assert.deepEqual(get.json().mfa_required_roles, { value: ['admin'], locked: false });
  const put = await f.inject({
    method: 'PUT',
    url: '/api/admin/mfa-policy',
    headers: f.admin,
    payload: { roles: ['admin', 'member'], expected_roles: ['admin'] },
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(f.db.mfaRequiredRoles(f.config), ['member', 'admin']);
  assert.equal(f.db.one('SELECT 1 FROM sessions WHERE user_id=?', member), undefined);
  assert.equal((await f.inject({ url: '/api/demos', headers: memberSession })).statusCode, 401);
  f.db.run("INSERT INTO settings VALUES('steam_enabled',1)");
  f.db.run('UPDATE users SET password_hash=NULL WHERE id=?', f.owner);
  assert.equal((await f.action(f.owner, { action: 'reset-passkeys' })).statusCode, 200);
  f.db.transaction(() => f.db.setMfaRequiredRoles(f.config, []));
  const validSteam = f.session(second);
  f.db.run("UPDATE sessions SET proof_kind='steam' WHERE user_id=?", second);
  const disable = await f.inject({
    method: 'PATCH',
    url: '/api/admin',
    headers: validSteam,
    payload: { steam_enabled: false },
  });
  assert.equal(disable.statusCode, 409, disable.body);
  assert.equal(f.db.flag(f.config, 'steam_enabled'), true);
});

test('second-factor policy rejects a stale change from a different administrator', async (t) => {
  const f = await fixture(t);
  f.db.transaction(() => f.db.setMfaRequiredRoles(f.config, ['member']));
  f.passkey(f.owner);
  const second = f.user('second_operator', 'admin');
  f.passkey(second);
  const secondSession = f.session(second);
  f.db.run("UPDATE sessions SET proof_kind='passkey' WHERE user_id IN (?,?)", f.owner, second);
  const read = async (headers: typeof f.admin) => {
    const response = await f.inject({ url: '/api/admin', headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().mfa_required_roles.value;
  };
  const write = (
    headers: typeof f.admin,
    payload: { roles: string[]; expected_roles?: string[] },
  ) =>
    f.inject({
      method: 'PUT',
      url: '/api/admin/mfa-policy',
      headers: { ...headers, 'x-session-context': headers['x-csrf-token'] },
      payload,
    });
  const firstExpected = await read(f.admin);
  const secondExpected = await read(secondSession);
  assert.deepEqual(firstExpected, ['member']);
  assert.deepEqual(secondExpected, ['member']);
  assert.equal((await write(f.admin, { roles: [] })).statusCode, 400);
  assert.equal(
    (await write(f.admin, { roles: [], expected_roles: ['member', 'member'] })).statusCode,
    400,
  );
  const accepted = await write(secondSession, {
    roles: ['admin', 'member'],
    expected_roles: secondExpected,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const conflict = await write(f.admin, { roles: [], expected_roles: firstExpected });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, 'mfa_policy_conflict');
  assert.deepEqual(await read(f.admin), ['member', 'admin']);
  assert.equal(
    f.db.one(
      "SELECT count(*) AS n FROM audit WHERE action='admin.mfa-policy' AND outcome='success'",
    )?.n,
    1,
  );
  const revised = await write(f.admin, { roles: ['admin'], expected_roles: ['admin', 'member'] });
  assert.equal(revised.statusCode, 200, revised.body);
  assert.deepEqual(await read(secondSession), ['admin']);
});

test('disabling Steam waits until linked members have a separate sign-in method', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  f.db.run("INSERT INTO settings VALUES('steam_enabled',1)");
  const steamOnly = f.user('steam_member', 'member', false);
  const steamWithPassword = f.user('steam_with_password');
  f.db.run("INSERT INTO identities VALUES('steam','76561198000000001',?)", steamOnly);
  f.db.run("INSERT INTO identities VALUES('steam','76561198000000002',?)", steamWithPassword);
  f.db.run('INSERT INTO auth_totp VALUES(?,?,?,?)', steamOnly, Buffer.from('fixture'), 0, now());
  f.session(steamOnly, 'challenge');
  f.db.run("UPDATE sessions SET proof_kind='steam' WHERE user_id=?", steamOnly);

  const priorRegistration = f.db.flag(f.config, 'registrations_enabled');
  const change = () =>
    f.inject({
      method: 'PATCH',
      url: '/api/admin',
      headers: f.admin,
      payload: { steam_enabled: false, registrations_enabled: !priorRegistration },
    });
  const denied = await change();
  assert.equal(denied.statusCode, 409, denied.body);
  assert.match(denied.json().detail, /add a password or passkey/);
  assert.equal(f.db.flag(f.config, 'steam_enabled'), true);
  assert.equal(f.db.flag(f.config, 'registrations_enabled'), priorRegistration);
  assert.ok(f.db.one('SELECT 1 FROM sessions WHERE user_id=?', steamOnly));

  f.passkey(steamOnly);
  const accepted = await change();
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(f.db.flag(f.config, 'steam_enabled'), false);
  assert.equal(f.db.flag(f.config, 'registrations_enabled'), !priorRegistration);
  assert.equal(f.db.one('SELECT 1 FROM sessions WHERE user_id=?', steamOnly), undefined);
});

test('an environment role policy cannot be changed through administration', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const get = await f.inject({ url: '/api/admin', headers: f.admin });
  assert.deepEqual(get.json().mfa_required_roles, { value: [], locked: true });
  const put = await f.inject({
    method: 'PUT',
    url: '/api/admin/mfa-policy',
    headers: f.admin,
    payload: { roles: ['admin'], expected_roles: [] },
  });
  assert.equal(put.statusCode, 409, put.body);
  assert.equal(f.db.one("SELECT 1 FROM settings WHERE key='mfa_required_roles'"), undefined);
});

function failDirectorySync(t: TestContext, directory: string) {
  const target = fs.statSync(directory);
  const sync = fs.fsyncSync;
  const failure = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    const info = fstatSync(fd);
    if (info.dev === target.dev && info.ino === target.ino)
      throw Object.assign(new Error('Injected directory sync failure'), { code: 'EIO' });
    sync(fd);
  });
  syncBuiltinESMExports();
  return () => {
    failure.mock.restore();
    syncBuiltinESMExports();
  };
}

test('account deletion commits private rows and leaves durable cleanup for both workers', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const member = f.user('delete_me');
  const ownerCookie = f.session(member);
  const id = token().slice(0, 32);
  f.db.run(
    "INSERT INTO demos(id,owner_id,name,source,status,size,created_at,started_at) VALUES(?,?,'Recording','upload','processing',256,?,?)",
    id,
    member,
    now(),
    now(),
  );
  const folder = join(f.root, 'demos', id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'input.dem'), 'original fixture data');
  const parse = createDemoScratch(f.db, id, 'jobs', () => true);
  const subtitles = createDemoScratch(f.db, id, 'transcription-jobs', () => true);
  writeFileSync(join(parse, 'input.dem'), 'private job input');
  writeFileSync(join(subtitles, 'manifest.json.gz'), 'private transcript input');
  const unrelated = createDemoScratch(f.db, token().slice(0, 32), 'jobs', () => true);
  const deleted = await f.action(member, { action: 'delete' });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(f.db.one('SELECT 1 FROM users WHERE id=?', member), undefined);
  assert.equal((await f.inject({ url: `/api/demos/${id}`, headers: ownerCookie })).statusCode, 404);
  assert.equal(globalDemoStorage(f.db), 256);
  assert.throws(
    () =>
      createDemoScratch(f.db, id, 'jobs', () =>
        Boolean(f.db.one('SELECT 1 FROM demos WHERE id=?', id)),
      ),
    /cancelled/,
  );
  cleanupDeletedDemos(f.db);
  assert.ok(existsSync(folder));
  const reopened = new Store(f.root);
  try {
    const verifyRetained = (directory: string) => {
      const restore = failDirectorySync(t, directory);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          reopened.run('UPDATE pending_demo_deletions SET ready_at=? WHERE id=?', now(), id);
          cleanupDeletedDemos(reopened);
          assert.equal(globalDemoStorage(reopened), 256);
          const row = reopened.one('SELECT ready_at FROM pending_demo_deletions WHERE id=?', id);
          assert.ok(row && row.ready_at > now());
        }
      } finally {
        restore();
      }
    };
    verifyRetained(join(f.root, 'jobs'));
    assert.ok(!existsSync(parse));
    verifyRetained(join(f.root, 'transcription-jobs'));
    assert.ok(!existsSync(subtitles));
    rmSync(join(f.root, 'transcription-jobs'), { recursive: true });
    verifyRetained(f.root);

    // An unavailable original storage root also leaves the durable job pending.
    reopened.run('UPDATE pending_demo_deletions SET ready_at=? WHERE id=?', now(), id);
    renameSync(join(f.root, 'demos'), join(f.root, 'demos-unavailable'));
    cleanupDeletedDemos(reopened);
    assert.equal(globalDemoStorage(reopened), 256);
    renameSync(join(f.root, 'demos-unavailable'), join(f.root, 'demos'));

    verifyRetained(join(f.root, 'demos'));
    assert.ok(!existsSync(folder));

    reopened.run('UPDATE pending_demo_deletions SET ready_at=? WHERE id=?', now(), id);
    cleanupDeletedDemos(reopened);
    for (const deleted of [folder, parse, subtitles]) assert.ok(!existsSync(deleted));
    assert.ok(existsSync(unrelated));
    assert.equal(globalDemoStorage(reopened), 0);
  } finally {
    reopened.close();
  }
});

test('an active upload retains its reservation through deletion until the writer closes', async (t) => {
  const f = await fixture(t, {
    MFA_REQUIRED_ROLES: 'none',
    MAX_UPLOAD_MB: '1',
    GLOBAL_STORAGE_MB: '1',
  });
  const member = f.user('active_upload_owner');
  const { id, folder, writeExpiresAt } = reserve(f.db, f.config, member, 'fixture.dem', 'upload');
  const file = join(folder, 'input.dem');
  const fd = openSync(file, 'wx', 0o600);
  const bytes = 1024 ** 2;
  try {
    writeSync(fd, 'abc');
    const deletion = await f.action(member, { action: 'delete' });
    assert.equal(deletion.statusCode, 200, deletion.body);
    const retained = f.db.one('SELECT size,ready_at FROM pending_demo_deletions WHERE id=?', id)!;
    assert.equal(retained.size, bytes);
    assert.ok(retained.ready_at * 1000 > writeExpiresAt);
    assert.ok(retained.ready_at > now() + demoWriteTimeoutMs / 1000);
    cleanupDeletedDemos(f.db);
    assert.equal(globalDemoStorage(f.db), bytes);
    assert.ok(existsSync(file));
    writeSync(fd, 'def');
    assert.equal(fstatSync(fd).size, 6);
    assert.throws(() => reserve(f.db, f.config, f.owner, 'next.dem', 'upload'), /storage is full/);
  } finally {
    closeSync(fd);
  }
  const restore = failDirectorySync(t, join(f.root, 'demos'));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => abandonUpload(f.db, id), /Injected directory sync failure/);
      assert.ok(!existsSync(folder));
      assert.equal(globalDemoStorage(f.db), bytes);
    }
  } finally {
    restore();
  }
  abandonUpload(f.db, id);
  assert.ok(!existsSync(file));
  assert.equal(globalDemoStorage(f.db), 0);
  assert.ok(reserve(f.db, f.config, f.owner, 'next.dem', 'upload').id);
});

test('external admin audit records the committed intent and can report an uncertain publication', async (t) => {
  let intentId = 0;
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' }, (app) => {
    app.post('/api/admin/fixture-publication', (r) => {
      adminPublication(
        f.db,
        f.config,
        r,
      )(() => {
        const intent = observer.one("SELECT * FROM audit WHERE outcome='authorized'");
        assert.equal(intent?.actor, f.owner);
        intentId = intent?.id;
        writeFileSync(prepared, 'the external write completed');
        throw Error('The final storage acknowledgement failed');
      });
      return { ok: true };
    });
  });
  const observer = new Store(f.root);
  t.after(() => observer.close());
  const prepared = join(f.root, 'prepared');
  const result = await f.inject({
    method: 'POST',
    url: '/api/admin/fixture-publication',
    headers: f.admin,
    payload: {},
  });
  assert.equal(result.statusCode, 500);
  assert.ok(existsSync(prepared));
  assert.ok(intentId > 0);
  const events = observer.all('SELECT outcome,intent_id FROM audit ORDER BY id');
  assert.deepEqual(
    events.map(({ outcome, intent_id }) => [outcome, intent_id]),
    [
      ['authorized', null],
      ['unknown', intentId],
    ],
  );
});

const mapApproval = {
  identity: {
    map: 'de_mirage',
    buildNum: 9842,
    patchVersion: 13984,
    demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
    addonPresence: 'none',
  },
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: '6678473446694075055',
    mapSha256: 'a'.repeat(64),
  },
} satisfies ApprovedMapEntry;

function seedMapDemo(f: Awaited<ReturnType<typeof fixture>>, owner: string) {
  const id = token().slice(0, 32);
  f.db.run(
    "INSERT INTO demos(id,owner_id,name,source,status,size,created_at,map,metadata,public) VALUES(?,?,'Fixture','upload','ready',100,?,?,?,1)",
    id,
    owner,
    now(),
    mapApproval.identity.map,
    JSON.stringify({ mapIdentity: mapApproval.identity }),
  );
  return `/api/demos/${id}/map-assets`;
}

test('map discovery rechecks live policy, ownership and both credential types after disk reads', async (t) => {
  for (const [subject, expected] of [
    ['account', 401],
    ['guest', 401],
    ['guest browser', 401],
    ['visibility', 404],
    ['private', 401],
    ['acquisition', 409],
  ] as const) {
    const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
    const member = f.user('map_member');
    const guest = f.user('map_guest');
    const guestRaw = token();
    f.db.run(
      'INSERT INTO guest_sessions(owner_id,token_hash,csrf,expires_at) VALUES(?,?,?,?)',
      guest,
      digest(guestRaw),
      token(),
      now() + 600,
    );
    const guestOwner = subject === 'guest' || subject === 'guest browser';
    const url = seedMapDemo(f, guestOwner ? guest : member);
    const auth = subject === 'account' ? f.session(member) : undefined;
    const guestCookie = 'cswatch_guest=' + guestRaw;
    const headers =
      subject === 'guest browser'
        ? await browserBootstrap(f.app, f.config, guestCookie)
        : guestOwner
          ? { cookie: guestCookie }
          : auth;
    const previousFlag = f.db.flag.bind(f.db);
    let observedRead = false;
    f.db.flag = (config, key) => {
      if (key === 'auto_official_maps_enabled' && !observedRead) {
        observedRead = true;
        queueMicrotask(() => {
          if (subject === 'account') f.db.run('DELETE FROM sessions WHERE user_id=?', member);
          if (subject === 'guest browser') f.db.run("DELETE FROM sessions WHERE stage='anonymous'");
          if (subject === 'guest') f.db.run('UPDATE guest_sessions SET expires_at=0');
          if (subject === 'visibility') f.db.run('UPDATE demos SET public=0');
          if (subject === 'private') f.db.run("INSERT INTO settings VALUES('public_access',0)");
          if (subject === 'acquisition')
            f.db.run("INSERT INTO settings VALUES('auto_official_maps_enabled',1)");
        });
      }
      return previousFlag(config, key);
    };
    const result = await f.inject({ url, headers });
    assert.equal(result.statusCode, expected, subject + ': ' + result.body);
    assert.ok(observedRead);
  }
});

test('map enqueue rechecks ownership and acquisition policy at synchronous publication', async (t) => {
  for (const [change, expected] of [
    ['session', 401],
    ['acquisition', 409],
  ] as const) {
    const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
    const member = f.user('queue_owner');
    const headers = f.session(member);
    const url = seedMapDemo(f, member);
    f.db.run("INSERT INTO settings VALUES('auto_official_maps_enabled',1)");
    writeFileSync(
      f.config.mapCatalogFile,
      JSON.stringify({ schemaVersion: 1, entries: [mapApproval] }),
      { mode: 0o600 },
    );
    await prepareMapJobs(f.config.mapJobsDir);
    await writeMapWorkerStatus(f.config.mapJobsDir, {
      schemaVersion: 1,
      status: 'idle',
      updatedAt: now(),
    });
    const previousFlag = f.db.flag.bind(f.db);
    let checks = 0;
    f.db.flag = (config, key) => {
      if (key === 'auto_official_maps_enabled' && ++checks === 2)
        queueMicrotask(() => {
          if (change === 'session') f.db.run('DELETE FROM sessions WHERE user_id=?', member);
          if (change === 'acquisition')
            f.db.run("UPDATE settings SET value=0 WHERE key='auto_official_maps_enabled'");
        });
      return previousFlag(config, key);
    };
    const result = await f.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal(result.statusCode, expected, result.body);
    assert.equal(await readMapRequest(f.config.mapJobsDir, mapPackId(mapApproval)), undefined);
    assert.ok(checks >= 2);
  }
});

test('unprivileged denials are sampled and routine activity preserves administrative audit history', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const member = f.session(f.user('audit_member'));
  const denied = () => f.inject({ url: '/api/admin/users', headers: member });
  assert.equal((await denied()).statusCode, 403);
  assert.equal((await denied()).statusCode, 403);
  assert.equal(
    f.db.one("SELECT count(*) n FROM audit WHERE outcome='denied' AND scope='account'")!.n,
    1,
  );
  const preserved = f.db.audit(f.owner, 'admin.user.sign-out', {
    administrative: true,
    target: f.owner,
  });
  // A bounded cleanup boundary must retain an older independent operator event.
  f.db.run(
    "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<18100) INSERT INTO audit(actor,action,created_at,outcome,scope) SELECT ?, 'demo.renamed', ?, 'success','account' FROM n",
    f.owner,
    now(),
  );
  for (let i = 0; i < 128; i++) f.db.audit(f.owner, 'demo.renamed');
  assert.ok(f.db.one('SELECT id FROM audit WHERE id=?', preserved));
  assert.ok(
    f.db.one("SELECT count(*) n FROM audit WHERE outcome='success' AND scope='account'")!.n < 18128,
  );
});

test('a failed first detail audit leaves the next successful read eligible', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const id = f.user('read_retry_target');
  const audit = f.db.audit.bind(f.db);
  let fail = true;
  f.db.audit = (actor, action, details) => {
    if (fail && action === 'admin.user.read' && details?.outcome === 'success') {
      fail = false;
      throw new Error('Fixture audit write failed');
    }
    return audit(actor, action, details);
  };
  const read = () => f.inject({ url: '/api/admin/users/' + id, headers: f.admin });
  assert.equal((await read()).statusCode, 500);
  assert.equal((await read()).statusCode, 200);
  assert.equal(
    f.db.one(
      "SELECT count(*) n FROM audit WHERE target=? AND action='admin.user.read' AND outcome='success'",
      id,
    )!.n,
    1,
  );
});

test('failed retention rolls back a sampled audit insert together with its sample', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const id = f.user('cleanup_retry_target');
  // The next row triggers the periodic cleanup.
  const nextId =
    (Math.floor((f.db.one('SELECT coalesce(max(id),0) n FROM audit')!.n + 1) / 128) + 1) * 128;
  f.db.run(
    "INSERT INTO audit(id,action,created_at,outcome,scope) VALUES(?,'fixture',?,'success','account')",
    nextId - 1,
    now(),
  );
  const original = f.db.run.bind(f.db);
  let fail = true;
  f.db.run = (sql, ...args) => {
    if (fail && sql.startsWith('DELETE FROM audit WHERE outcome=')) {
      fail = false;
      throw new Error('Fixture cleanup failed');
    }
    return original(sql, ...args);
  };
  const read = () => f.inject({ url: '/api/admin/users/' + id, headers: f.admin });
  assert.equal((await read()).statusCode, 500);
  assert.equal((await read()).statusCode, 200);
  assert.equal(
    f.db.one(
      "SELECT count(*) n FROM audit WHERE action='admin.user.read' AND target=? AND outcome='success'",
      id,
    )!.n,
    1,
  );
});

test('an uncommitted detail audit does not consume its sample for a later read', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const id = f.user('commit_retry_target');
  const timestamp = Date.now();
  t.mock.method(Date, 'now', () => timestamp);
  f.db.db.exec(`CREATE TABLE detail_commit_fixture(
    user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
  )`);
  const audit = f.db.audit.bind(f.db);
  let fail = true;
  t.mock.method(f.db, 'audit', (actor, action, details) => {
    const row = audit(actor, action, details);
    if (fail && action === 'admin.user.read' && details?.outcome === 'success') {
      fail = false;
      // The audit insert succeeds, but the outer transaction cannot commit.
      f.db.run("INSERT INTO detail_commit_fixture VALUES('missing-fixture-user')");
    }
    return row;
  });
  const read = () => f.inject({ url: '/api/admin/users/' + id, headers: f.admin });
  const recorded = () =>
    f.db.one(
      "SELECT count(*) n FROM audit WHERE action='admin.user.read' AND target=? AND outcome='success'",
      id,
    )!.n;
  assert.equal((await read()).statusCode, 500);
  assert.equal(recorded(), 0);
  assert.equal((await read()).statusCode, 200);
  assert.equal((await read()).statusCode, 200);
  assert.equal(recorded(), 1);
});

test('admin detail reads and attributable denials are sampled without changing their responses', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  let timestamp = Date.now();
  t.mock.method(Date, 'now', () => timestamp);
  const otherAdmin = f.user('another_operator', 'admin');
  const stale = f.session(f.owner, 'full', true);
  const other = f.session(otherAdmin);
  const members = Array.from({ length: 22 }, (_, index) => f.user(`reader_target_${index}`));
  const read = (id: string, headers = stale, method: 'GET' | 'HEAD' = 'GET') =>
    f.inject({ method, url: `/api/admin/users/${id}`, headers });
  const reads = () =>
    f.db.all("SELECT actor,target FROM audit WHERE action='admin.user.read' ORDER BY id");
  for (const id of members) {
    const response = await read(id);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.id, id);
  }
  const first = members[0];
  assert.equal((await read(first)).statusCode, 200);
  assert.equal((await read(first, stale, 'HEAD')).statusCode, 200);
  assert.equal((await read(first, other)).statusCode, 200);
  assert.deepEqual(
    reads().map(({ actor, target }) => [actor, target]),
    [...members.slice(0, 20).map((id) => [f.owner, id]), [otherAdmin, first]],
  );

  const denials = () =>
    f.db.all(
      "SELECT action,actor FROM audit WHERE scope='operator' AND outcome='denied' ORDER BY id",
    );
  const deny = () => f.action(first, { action: 'sign-out' }, stale);
  for (let i = 0; i < 3; i++) assert.equal((await deny()).statusCode, 403);
  assert.equal(
    (await f.inject({ method: 'PATCH', url: '/api/admin', headers: stale, payload: {} }))
      .statusCode,
    403,
  );
  assert.deepEqual(
    denials().map(({ action, actor }) => [action, actor]),
    [
      ['admin.user.action', f.owner],
      ['settings.updated', f.owner],
    ],
  );
  timestamp += 60000;
  assert.equal((await read(first)).statusCode, 200);
  assert.equal(reads().length, 22);
  assert.equal((await deny()).statusCode, 403);
  assert.equal(denials().length, 3);
});

test('routine operator reads and denials have independent capacity from durable changes', async (t) => {
  const f = await fixture(t, { MFA_REQUIRED_ROLES: 'none' });
  const member = f.user('audit_target');
  assert.equal((await f.action(member, { action: 'sign-out' })).statusCode, 200);
  const intent = f.db.audit(f.owner, 'assets.retry_requested', {
    outcome: 'authorized',
    administrative: true,
  });
  const result = f.db.audit(f.owner, 'assets.retry_requested', {
    intentId: intent,
    administrative: true,
  });
  const deniedIntent = f.db.audit(f.owner, 'assets.retry_requested', {
    outcome: 'authorized',
    administrative: true,
  });
  const denied = f.db.audit(f.owner, 'assets.retry_requested', {
    outcome: 'denied',
    intentId: deniedIntent,
    administrative: true,
  });
  const seed = (action: string, outcome: string, count: number) =>
    f.db.run(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
       INSERT INTO audit(actor,action,created_at,outcome,scope) SELECT ?,?,?,?,'operator' FROM n`,
      count,
      f.owner,
      action,
      now(),
      outcome,
    );
  seed('admin.user.read', 'success', 15000);
  seed('admin.user.action', 'denied', 5000);
  // Run one cleanup at the storage boundary, with both routine groups saturated.
  for (let i = 0; i < 128; i++) f.db.audit(f.owner, 'demo.renamed');
  assert.equal(
    f.db.one("SELECT count(*) n FROM audit WHERE action='admin.user.read' AND outcome='success'")!
      .n,
    3000,
  );
  assert.equal(
    f.db.one("SELECT count(*) n FROM audit WHERE action='admin.user.action' AND outcome='denied'")!
      .n,
    5000,
  );
  assert.equal(f.db.one('SELECT intent_id FROM audit WHERE id=?', result)?.intent_id, intent);
  assert.equal(f.db.one('SELECT intent_id FROM audit WHERE id=?', denied)?.intent_id, deniedIntent);
  assert.equal(
    (
      await f.inject({ url: '/api/admin/audit?action=admin.user.sign-out', headers: f.admin })
    ).json().total,
    1,
  );

  // Durable capacity still retires a publication and both rows disappear together.
  seed('settings.updated', 'success', 15000);
  for (let i = 0; i < 128; i++) f.db.audit(f.owner, 'demo.renamed');
  assert.equal(f.db.one('SELECT 1 FROM audit WHERE id IN (?,?)', intent, result), undefined);
  assert.equal(f.db.one('SELECT intent_id FROM audit WHERE id=?', denied)?.intent_id, deniedIntent);
});
