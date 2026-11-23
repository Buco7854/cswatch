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

test('password hashing cannot revive a revoked session or overwrite newer credentials', async (t) => {
  for (const state of ['session-revoked', 'password-replaced'] as const)
    await t.test(state, async () => {
      const root = await mkdtemp(join(tmpdir(), 'cswatch-password-race-'));
      const config = loadConfig({
        APP_URL: 'http://localhost:8000',
        COOKIE_SECURE: 'false',
        DATA_DIR: root,
        ADMIN_USERNAME: 'password_fixture_admin',
        ADMIN_PASSWORD: 'Original-fixture-password-2026',
        MFA_REQUIRED_ROLES: 'none',
      });
      const db = new Store(root),
        app = await createApp(config, db);
      const headers = { host: 'localhost:8000', origin: 'http://localhost:8000' };
      try {
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: await browserBootstrap(app, config),
          payload: {
            username: 'password_fixture_admin',
            password: 'Original-fixture-password-2026',
          },
        });
        assert.equal(login.statusCode, 200);
        const { user } = login.json(),
          cookie = login.cookies.find((c) => c.name === sessionCookieName(config))!;
        const previous = db.one(
          'SELECT password_hash FROM users WHERE id=?',
          user.id,
        )!.password_hash;
        const replacement =
          state === 'password-replaced'
            ? await hashPassword('Separately-changed-fixture-password')
            : previous;
        const originalOne = db.one.bind(db);
        let invalidated = false;
        // Deterministically revoke after request authentication/CSRF checks and
        // after its old password snapshot, before the asynchronous hash completes.
        db.one = (sql, ...args) => {
          const row = originalOne(sql, ...args);
          if (!invalidated && sql === 'SELECT password_hash FROM users WHERE id=?') {
            invalidated = true;
            if (state === 'session-revoked')
              db.run('DELETE FROM sessions WHERE user_id=?', user.id);
            else db.run('UPDATE users SET password_hash=? WHERE id=?', replacement, user.id);
          }
          return row;
        };
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          headers: {
            ...headers,
            cookie: `${cookie.name}=${cookie.value}`,
            'x-csrf-token': user.csrf,
          },
          payload: {
            new_password: 'Stale-attempt-fixture-password',
          },
        });
        db.one = originalOne;
        assert.equal(invalidated, true);
        assert.equal(
          db.one('SELECT count FROM rate_limits WHERE key=?', digest('password:' + user.id))?.count,
          1,
          'a credential change uses the same account-wide allowance across sessions',
        );
        assert.equal(response.statusCode, state === 'session-revoked' ? 401 : 409);
        assert.equal(response.headers['set-cookie'], undefined);
        assert.equal(
          db.one('SELECT password_hash FROM users WHERE id=?', user.id)!.password_hash,
          replacement,
        );
        assert.equal(
          db.one('SELECT count(*) AS count FROM sessions WHERE user_id=?', user.id)!.count,
          state === 'session-revoked' ? 0 : 1,
        );
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    });
});
