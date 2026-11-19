import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { hashPassword, sessionCookieName } from '../src/security.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-login-race-'));
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    ADMIN_USERNAME: 'login_fixture_admin',
    ADMIN_PASSWORD: 'Original-login-fixture-password-2026',
  });
  const db = new Store(root),
    app = await createApp(config, db);
  const login = (password = 'Original-login-fixture-password-2026') =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'localhost:8000', origin: 'http://localhost:8000' },
      payload: { username: 'login_fixture_admin', password },
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
const initialLoginQuery =
  'SELECT * FROM users u WHERE username=? COLLATE NOCASE AND NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id)';

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
      if (!replaced && sql === initialLoginQuery) {
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
    assert.equal(stale.headers['set-cookie'], undefined);
    assert.equal(s.db.one('SELECT count(*) AS count FROM sessions')!.count, 0);
    const current = await s.login('Replacement-login-fixture-password-2026');
    assert.equal(current.statusCode, 200);
    assert.ok(current.cookies.some((cookie) => cookie.name === sessionCookieName(s.config)));
    assert.equal(s.db.one('SELECT count(*) AS count FROM sessions')!.count, 1);
  } finally {
    s.db.one = originalOne;
    await s.close();
  }
});

test('a verified login uses current account name and privileges after asynchronous verification', async () => {
  const s = await fixture();
  const originalOne = s.db.one.bind(s.db);
  let changed = false;
  try {
    s.db.one = (sql, ...args) => {
      const row = originalOne(sql, ...args);
      if (!changed && sql === initialLoginQuery) {
        changed = true;
        s.db.run(
          'UPDATE users SET username=?,is_admin=0 WHERE id=?',
          'renamed_login_fixture',
          row!.id,
        );
      }
      return row;
    };
    const response = await s.login();
    s.db.one = originalOne;
    assert.equal(changed, true);
    assert.equal(response.statusCode, 200);
    const { user } = response.json();
    assert.equal(user.username, 'renamed_login_fixture');
    assert.equal(user.is_admin, false);
    const cookie = response.cookies.find((item) => item.name === sessionCookieName(s.config))!;
    const me = await s.app.inject({
      url: '/api/auth/me',
      headers: { host: 'localhost:8000', cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(me.json().user.id, user.id);
    assert.equal(me.json().user.username, 'renamed_login_fixture');
    assert.equal(me.json().user.is_admin, 0);
  } finally {
    s.db.one = originalOne;
    await s.close();
  }
});
