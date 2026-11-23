import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { now, Store } from '../src/db.js';
import { openEncryptionKey, seal, totpBinding } from '../src/encryption-key.js';
import { canSignIn, firstFactorStage } from '../src/security.js';
import { codeFor } from './fixtures/totp-code.js';

/** Deterministic model checks after sequences of admin policy, factor, role and identity changes. */
test('account login eligibility and next stage follow the current primary, factors and role policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-account-model-'));
  const db = new Store(root);
  const config = loadConfig({ APP_URL: 'https://watch.example' });
  const model = {
    admin: false,
    required: true,
    passkey: false,
    totp: false,
    password: false,
    steam: false,
    provider: false,
  };
  let random = 0x7d195558;
  try {
    db.run("INSERT INTO users(id,username,role,created_at) VALUES('m','model','member',1)");
    for (let i = 0; i < 1024; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const operation = (Object.keys(model) as (keyof typeof model)[])[random % 7];
      const enabled = (model[operation] = !model[operation]);
      switch (operation) {
        case 'admin':
          db.run('UPDATE users SET role=? WHERE id=?', enabled ? 'admin' : 'member', 'm');
          break;
        case 'required':
          db.setMfaRequiredRoles(config, enabled ? ['admin'] : []);
          break;
        case 'password':
          db.run(
            'UPDATE users SET password_hash=? WHERE id=?',
            enabled ? 'fixture-hash' : null,
            'm',
          );
          break;
        case 'steam':
          if (enabled) db.run("INSERT INTO identities VALUES('steam','test-subject','m')");
          else db.run("DELETE FROM identities WHERE user_id='m'");
          break;
        case 'provider':
          db.run("INSERT OR REPLACE INTO settings VALUES('steam_enabled',?)", Number(enabled));
          break;
        case 'totp':
          if (enabled) db.run("INSERT INTO auth_totp VALUES('m',X'01',1,1)");
          else db.run("DELETE FROM auth_totp WHERE user_id='m'");
          break;
        case 'passkey':
          if (enabled)
            db.run(
              "INSERT INTO auth_passkeys VALUES('key','m','Fixture',X'01',0,'singleDevice',0,1,NULL)",
            );
          else db.run("DELETE FROM auth_passkeys WHERE user_id='m'");
          break;
      }
      assert.equal(
        canSignIn(db, config, 'm'),
        model.password || model.passkey || (model.steam && model.provider),
        'primary availability at transition ' + i,
      );
      const stage =
        model.passkey || model.totp
          ? 'challenge'
          : model.required && model.admin
            ? 'enroll'
            : 'full';
      assert.equal(firstFactorStage(db, config, 'm'), stage, 'first proof at transition ' + i);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated browser transitions preserve proof level, session ownership and revocation', async (t) => {
  const initialTime = Date.UTC(2026, 0, 1, 12);
  t.mock.timers.enable({ apis: ['Date'], now: initialTime });
  const { createApp } = await import('../src/server.js');
  const root = mkdtempSync(join(tmpdir(), 'cswatch-login-sequence-'));
  const c = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    ADMIN_USERNAME: 'model_admin',
    ADMIN_PASSWORD: 'Synthetic-model-password',
  });
  const db = new Store(root),
    app = await createApp(c, db);
  type Stage = 'anonymous' | 'full' | 'enroll' | 'challenge';
  const cookies = new Map<string, string>();
  const headers = () => ({
    host: c.host,
    origin: c.appUrl,
    cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '),
  });
  const jar = (reply: Awaited<ReturnType<typeof status>>) => {
    for (const cookie of reply.cookies) {
      if (cookie.value) cookies.set(cookie.name, cookie.value);
      else cookies.delete(cookie.name);
    }
  };
  const status = () => app.inject({ url: '/api/auth/me', headers: headers() });
  let seed = 0xbafdf00d;
  let stage: Stage = 'anonymous';
  let proof: 'password' | 'totp' | null = null;
  let requires = true;
  let enrolled = false;
  const modelId = db.one("SELECT id FROM users WHERE role='admin'")!.id;
  const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const transitions = [
    'policy',
    'expire',
    'logout',
    'login',
    'observe',
    'reject-totp',
    'verify-totp',
  ] as const;
  // Reach each sign-in stage before the generated actions vary their order.
  const initial = [
    'login',
    'logout',
    'policy',
    'login',
    'logout',
    'seed-factor',
    'login',
    'reject-totp',
    'verify-totp',
    'logout',
    'login',
    'expire',
  ] as const;
  const events = new Set<string>();
  try {
    for (let i = 0; i < 64; i++) {
      t.mock.timers.setTime(initialTime + i * 12_000);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const action = initial[i] ?? transitions[(seed >>> 12) % transitions.length];
      const last = await status();
      jar(last);
      const post = (path: string, payload: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/' + path,
          headers: { ...headers(), 'x-csrf-token': last.json().session.csrf },
          remoteAddress: '192.0.2.' + (i + 1),
          payload,
        });
      if (action === 'policy') {
        requires = !requires;
        db.transaction(() => db.setMfaRequiredRoles(c, requires ? ['admin'] : []));
        if (requires && stage === 'full' && !enrolled) {
          stage = 'anonymous';
          proof = null;
        }
      } else if (action === 'seed-factor') {
        const key = openEncryptionKey(c, db);
        const encrypted = seal(
          key,
          totpBinding(modelId),
          Buffer.from('12345678901234567890').toString('hex'),
        );
        db.run('INSERT INTO auth_totp VALUES(?,?,?,?)', modelId, encrypted, -1, now());
        enrolled = true;
      } else if (action === 'expire' || action === 'logout') {
        if (action === 'expire') {
          db.run('UPDATE sessions SET expires_at=0 WHERE user_id=?', modelId);
        } else {
          const result = await post('logout', {});
          assert.equal(result.statusCode, 200, result.body);
          jar(result);
        }
        stage = 'anonymous';
        proof = null;
      } else if (action === 'login' && stage === 'anonymous') {
        const result = await post('login', {
          username: c.adminUsername,
          password: c.adminPassword,
        });
        assert.equal(result.statusCode, 200, result.body);
        jar(result);
        stage = enrolled ? 'challenge' : requires ? 'enroll' : 'full';
        proof = 'password';
        events.add(action + ':' + stage);
      } else if ((action === 'reject-totp' || action === 'verify-totp') && stage === 'challenge') {
        const step = Math.floor(now() / 30);
        const codes = [-1, 0, 1].map((drift) => codeFor(totpSecret, step + drift));
        const reject = action === 'reject-totp';
        const code = reject
          ? ['100000', '200000', '300000', '400000'].find((value) => !codes.includes(value))!
          : codes[1];
        const result = await post('mfa/totp', { code });
        assert.equal(result.statusCode, reject ? 401 : 200, result.body);
        if (reject) {
          assert.equal(result.headers['set-cookie'], undefined);
        } else {
          assert.notEqual(result.json().session.csrf, last.json().session.csrf);
          jar(result);
          stage = 'full';
          proof = 'totp';
        }
        events.add(action + ':' + stage);
      }
      const me = await status();
      jar(me);
      assert.equal(me.json().session.stage, stage, 'stage after transition ' + i);
      assert.equal(me.json().session.proof_kind, proof, 'proof after transition ' + i);
      assert.equal(me.json().user?.id ?? null, stage === 'full' ? modelId : null);
      if (stage === 'enroll' || stage === 'challenge') {
        const denied = await app.inject({ url: '/api/admin/users', headers: headers() });
        assert.equal(denied.statusCode, 403);
      }
    }
    for (const event of [
      'login:full',
      'login:enroll',
      'login:challenge',
      'reject-totp:challenge',
      'verify-totp:full',
    ])
      assert.ok(events.has(event), event + ' must be exercised');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
