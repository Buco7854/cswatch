import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { digest, hashPassword, sessionCookieName } from '../src/security.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-login-race-'));
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    ADMIN_USERNAME: 'login_fixture_admin',
    ADMIN_PASSWORD: 'Original-login-fixture-password-2026',
    MFA_REQUIRED_ROLES: 'none',
  });
  const db = new Store(root),
    app = await createApp(config, db);
  const login = async (
    password = 'Original-login-fixture-password-2026',
    username = 'login_fixture_admin',
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: await browserBootstrap(app, config),
      payload: { username, password },
    });
  return {
    config,
    db,
    app,
    login,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const passwordLookup = 'SELECT id,username,role,password_hash,auth_generation FROM users u';

test('a login verifying superseded credentials cannot recreate access, while the replacement password still works', async () => {
  const s = await fixture();
  const replacement = await hashPassword('Replacement-login-fixture-password-2026');
  const originalOne = s.db.one.bind(s.db);
  let replaced = false;
  try {
    // Deterministically change the stored credential after returning the old
    // snapshot, before asynchronous verification can complete.
    s.db.one = (sql, ...args) => {
      const row = originalOne(sql, ...args);
      if (!replaced && sql.startsWith(passwordLookup)) {
        replaced = true;
        s.db.run('UPDATE users SET password_hash=? WHERE id=?', replacement, row!.id);
        s.db.run('DELETE FROM sessions WHERE user_id=?', row!.id);
      }
      return row;
    };
    const stale = await s.login();
    s.db.one = originalOne;
    assert.equal(replaced, true);
    assert.equal(stale.statusCode, 401);
    assert.equal(stale.headers['cache-control'], 'no-store');
    assert.equal(stale.headers['set-cookie'], undefined);
    assert.equal(
      s.db.one('SELECT count(*) AS count FROM sessions WHERE user_id IS NOT NULL')!.count,
      0,
    );
    const current = await s.login('Replacement-login-fixture-password-2026');
    assert.equal(current.statusCode, 200);
    assert.equal(current.headers['cache-control'], 'no-store');
    assert.ok(current.cookies.some((cookie) => cookie.name === sessionCookieName(s.config)));
    assert.equal(
      s.db.one('SELECT count(*) AS count FROM sessions WHERE user_id IS NOT NULL')!.count,
      1,
    );
  } finally {
    s.db.one = originalOne;
    await s.close();
  }
});

test('a verified login cannot grant stale privileges after the account changes during verification', async () => {
  const s = await fixture();
  const originalOne = s.db.one.bind(s.db);
  let changed = false;
  try {
    s.db.run(
      "INSERT INTO users(id,username,password_hash,role,created_at) VALUES('other-admin','other_admin',?,'admin',0)",
      await hashPassword('Unrelated-fixture-password'),
    );
    s.db.one = (sql, ...args) => {
      const row = originalOne(sql, ...args);
      if (!changed && sql.startsWith(passwordLookup)) {
        changed = true;
        s.db.run(
          "UPDATE users SET username=?,role='member',auth_generation=auth_generation+1 WHERE id=?",
          'renamed_login_fixture',
          row!.id,
        );
      }
      return row;
    };
    const response = await s.login();
    s.db.one = originalOne;
    assert.equal(changed, true);
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['set-cookie'], undefined);
    const fresh = await s.login(undefined, 'renamed_login_fixture');
    assert.equal(fresh.statusCode, 200);
    const { user } = fresh.json();
    assert.equal(user.username, 'renamed_login_fixture');
    assert.equal(user.role, 'member');
    const cookie = fresh.cookies.find((item) => item.name === sessionCookieName(s.config))!;
    const me = await s.app.inject({
      url: '/api/auth/me',
      headers: { host: 'localhost:8000', cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(me.json().user.id, user.id);
    assert.equal(me.json().user.username, 'renamed_login_fixture');
    assert.equal(me.json().user.role, 'member');
  } finally {
    s.db.one = originalOne;
    await s.close();
  }
});

test('changed factor policy is rechecked after password verification', async () => {
  const s = await fixture();
  const initial = s.db.mfaRequiredRoles.bind(s.db);
  let reads = 0;
  try {
    s.db.mfaRequiredRoles = (config) => (++reads === 1 ? initial(config) : ['admin']);
    const result = await s.login();
    assert.equal(result.statusCode, 401, result.body);
    assert.equal(s.db.one('SELECT 1 FROM sessions WHERE user_id IS NOT NULL'), undefined);
  } finally {
    s.db.mfaRequiredRoles = initial;
    await s.close();
  }
});

test('password work reserves two places for login and charges only admitted attempts', async () => {
  const { verifyPassword } = await import('../src/security.js');
  const password = 'ordinary-local-test-password';
  const hash = await hashPassword(password);
  let admitted = 0;
  const admit = () => {
    admitted++;
  };
  const auxiliary = Array.from({ length: 4 }, () => verifyPassword(hash, password));
  const [blockedAuxiliary, firstLogin, secondLogin, blockedLogin] = await Promise.allSettled([
    verifyPassword(hash, password),
    verifyPassword(hash, password, admit),
    verifyPassword(hash, password, admit),
    verifyPassword(hash, password, admit),
  ]);
  assert.deepEqual(await Promise.all(auxiliary), [true, true, true, true]);
  assert.equal(blockedAuxiliary.status, 'rejected');
  assert.deepEqual(firstLogin, { status: 'fulfilled', value: true });
  assert.deepEqual(secondLogin, { status: 'fulfilled', value: true });
  assert.equal(blockedLogin.status, 'rejected');
  assert.equal(admitted, 2);
});

test('username-wide password admission has a fixed short window independent of source or account existence', async () => {
  const s = await fixture();
  try {
    const key = digest('login-username:' + digest('unassigned_fixture'));
    const expires = Math.floor(Date.now() / 1000) + 4;
    s.db.run('INSERT INTO rate_limits VALUES(?,?,?)', key, 8, expires);
    for (const address of ['192.0.2.1', '198.51.100.2']) {
      const denied = await s.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: address,
        headers: await browserBootstrap(s.app, s.config),
        payload: { username: 'Unassigned_Fixture', password: 'sample-local-password' },
      });
      assert.equal(denied.statusCode, 429);
      assert.equal(
        s.db.one('SELECT expires_at FROM rate_limits WHERE key=?', key)!.expires_at,
        expires,
      );
    }
    assert.equal((await s.login()).statusCode, 200);
  } finally {
    await s.close();
  }
});
