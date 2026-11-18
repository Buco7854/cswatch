import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/server.js';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { guestCookieName, cleanupExpiredGuests } from '../src/guest.js';
import { sessionCookieName, verifyPassword } from '../src/security.js';

const origin = 'http://localhost:8000';
const host = 'localhost:8000';
async function fixture(env: Record<string, string> = {}, initialized = true) {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-enrollment-'));
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: dir,
    MAX_UPLOAD_MB: '1',
    GUEST_STORAGE_MB: '2',
    ...(initialized
      ? { ADMIN_USERNAME: 'operator', ADMIN_PASSWORD: 'synthetic-operator-password' }
      : {}),
    ...env,
  });
  const db = new Store(dir),
    app = await createApp(config, db);
  await app.ready();
  return {
    dir,
    config,
    db,
    app,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const uploadBody = Buffer.concat([
  Buffer.from(
    '--demo-boundary\r\nContent-Disposition: form-data; name="file"; filename="private.dem"\r\nContent-Type: application/octet-stream\r\n\r\n',
  ),
  Buffer.from('PBDEMS2\0synthetic-not-a-parser-fixture'),
  Buffer.from('\r\n--demo-boundary--\r\n'),
]);

for (const secure of [false, true])
  test(`first admin enrollment requires operator code and is one-use (${secure ? 'HTTPS' : 'HTTP'})`, async () => {
    const f = await fixture(
      secure ? { APP_URL: 'https://cswatch.test', COOKIE_SECURE: 'true' } : {},
      false,
    );
    const headers = {
      host: secure ? 'cswatch.test' : host,
      origin: secure ? 'https://cswatch.test' : origin,
    };
    try {
      const code = readFileSync(join(f.dir, 'setup-token'), 'utf8').trim();
      assert.match(code, /^[a-f0-9]{64}$/);
      assert.equal(statSync(join(f.dir, 'setup-token')).mode & 0o777, 0o600);
      const cfg = (
        await f.app.inject({ url: '/api/config', headers: { host: headers.host } })
      ).json();
      assert.equal(cfg.setup_required, true);
      assert.equal(cfg.guest_uploads_enabled, false);
      assert.ok(!JSON.stringify(cfg).includes(code));
      assert.equal(f.db.one('SELECT token_hash FROM instance_setup')!.token_hash === code, false);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/auth/register',
            headers,
            payload: { username: 'not_admin', password: 'synthetic-member-password' },
          })
        ).statusCode,
        503,
      );
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/setup',
            headers: { ...headers, origin: 'https://evil.invalid' },
            payload: { username: 'admin', password: 'synthetic-admin-password', setupToken: code },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/setup',
            headers,
            payload: {
              username: 'admin',
              password: 'synthetic-admin-password',
              setupToken: '0'.repeat(64),
            },
          })
        ).statusCode,
        403,
      );
      const results = await Promise.all(
        ['admin_one', 'admin_two'].map((username) =>
          f.app.inject({
            method: 'POST',
            url: '/api/setup',
            headers,
            payload: { username, password: 'synthetic-admin-password', setupToken: code },
          }),
        ),
      );
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
      assert.equal(f.db.one('SELECT count(*) AS n FROM users WHERE is_admin=1')!.n, 1);
      const success = results.find((r) => r.statusCode === 201)!;
      const cookie = success.cookies.find((cookie) => cookie.name === sessionCookieName(f.config))!;
      assert.ok(cookie);
      assert.equal(Boolean(cookie.httpOnly), true);
      assert.equal(Boolean(cookie.secure), secure);
      assert.equal(existsSync(join(f.dir, 'setup-token')), false);
      assert.equal(f.db.one('SELECT count(*) AS n FROM instance_setup')!.n, 0);
      assert.equal(
        (await f.app.inject({ url: '/api/config', headers: { host: headers.host } })).json()
          .setup_required,
        false,
      );
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/setup',
            headers,
            payload: {
              username: 'attacker',
              password: 'synthetic-attacker-password',
              setupToken: code,
            },
          })
        ).statusCode,
        409,
      );
    } finally {
      await f.close();
    }
  });

test('environment admin is provisioned once, never resets an existing administrator, and secrets remain server-only', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject({ url: '/api/config', headers: { host } })).json().setup_required,
      false,
    );
    assert.equal(existsSync(join(f.dir, 'setup-token')), false);
    const row = f.db.one('SELECT * FROM users WHERE is_admin=1')!;
    assert.equal(await verifyPassword(row.password_hash, 'synthetic-operator-password'), true);
    const { provisionAdmin } = await import('../src/setup.js');
    await provisionAdmin(f.db, { ...f.config, adminPassword: 'a-different-valid-password' });
    assert.equal(
      f.db.one('SELECT password_hash FROM users WHERE id=?', row.id)!.password_hash,
      row.password_hash,
    );
    const cfg = (await f.app.inject({ url: '/api/config', headers: { host } })).body;
    assert.ok(!cfg.includes('synthetic-operator-password'));
    assert.ok(!cfg.includes('adminPassword'));
  } finally {
    await f.close();
  }
});

test('guest uploads use expiring private ownership with CSRF, isolation, bounded quotas and no account session', async () => {
  const f = await fixture({ GUEST_DEMO_LIMIT: '2' });
  try {
    const create = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/guest/session',
        headers: { host, origin },
        payload: {},
      });
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/guest/session',
          headers: { host, origin: 'https://evil.invalid' },
          payload: {},
        })
      ).statusCode,
      403,
    );
    const created = await create(),
      other = await create();
    assert.equal(created.statusCode, 201);
    const raw = created.cookies.find((cookie) => cookie.name === guestCookieName(f.config))!;
    assert.equal(Boolean(raw.httpOnly), true);
    assert.equal(raw.path, '/');
    const cookie = `${raw.name}=${raw.value}`,
      csrf = created.json().csrf;
    const otherCookie = other.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    assert.equal(
      created.cookies.some((cookie) => cookie.name === sessionCookieName(f.config)),
      false,
    );
    const me = (await f.app.inject({ url: '/api/auth/me', headers: { host, cookie } })).json();
    assert.equal(me.user, null);
    assert.equal(me.guest_session.csrf, csrf);
    assert.equal(
      f.db.one('SELECT token_hash FROM guest_sessions WHERE token_hash=?', raw.value),
      undefined,
    );
    const upload = (csrfToken?: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/demos',
        headers: {
          host,
          origin,
          cookie,
          'content-type': 'multipart/form-data; boundary=demo-boundary',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        payload: uploadBody,
      });
    assert.equal((await upload()).statusCode, 403);
    const first = await upload(csrf);
    assert.equal(first.statusCode, 202, first.body);
    const id = first.json().id;
    assert.equal(
      (await f.app.inject({ url: `/api/demos/${id}`, headers: { host } })).statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject({ url: `/api/demos/${id}`, headers: { host, cookie: otherCookie } }))
        .statusCode,
      404,
    );
    const own = (await f.app.inject({ url: `/api/demos/${id}`, headers: { host, cookie } })).json();
    assert.equal(own.public, 0);
    assert.equal(own.owned, false);
    assert.equal(own.guest_owned, true);
    assert.equal(own.expires_at, created.json().expires_at);
    assert.equal(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/demos/${id}`,
          headers: { host, origin, cookie, 'x-csrf-token': csrf },
          payload: { public: true },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await f.app.inject({ url: `/api/demos/${id}/bookmarks`, headers: { host, cookie } }))
        .statusCode,
      401,
    );
    const folder = join(f.dir, 'demos', id);
    mkdirSync(join(folder, 'chunks'));
    writeFileSync(join(folder, 'manifest.json.gz'), gzipSync('{}'));
    writeFileSync(join(folder, 'chunks', '0.json.gz'), gzipSync('{}'));
    f.db.run("UPDATE demos SET status='ready' WHERE id=?", id);
    for (const path of [
      `/api/demos/${id}/playback`,
      `/api/demos/${id}/playback/chunks/0`,
      `/api/demos/${id}/captions`,
    ]) {
      assert.equal(
        (await f.app.inject({ url: path, headers: { host, cookie } })).statusCode,
        200,
        path,
      );
      assert.equal(
        (await f.app.inject({ url: path, headers: { host, cookie: otherCookie } })).statusCode,
        404,
        path,
      );
    }
    assert.equal((await upload(csrf)).statusCode, 202);
    assert.equal((await upload(csrf)).statusCode, 429);
    const owner = f.db.one('SELECT owner_id FROM guest_sessions WHERE csrf=?', csrf)!.owner_id;
    f.db.run('UPDATE guest_sessions SET expires_at=? WHERE owner_id=?', now() - 1, owner);
    assert.equal(
      (await f.app.inject({ url: `/api/demos/${id}`, headers: { host, cookie } })).statusCode,
      404,
    );
    cleanupExpiredGuests(f.db);
    assert.equal(existsSync(folder), false);
    assert.equal(f.db.one('SELECT id FROM users WHERE id=?', owner), undefined);
    assert.equal(f.db.one('SELECT id FROM demos WHERE id=?', id), undefined);
  } finally {
    await f.close();
  }
});

for (const env of [{ PUBLIC_ACCESS: 'false' }, { GUEST_UPLOADS_ENABLED: 'false' }])
  test(`guest upload policy is denied by environment ${Object.keys(env)[0]}`, async () => {
    const f = await fixture(env);
    try {
      f.db.run("INSERT INTO settings VALUES('guest_uploads_enabled',1)");
      assert.equal(
        (await f.app.inject({ url: '/api/config', headers: { host } })).json()
          .guest_uploads_enabled,
        false,
      );
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/guest/session',
        headers: { host, origin },
        payload: {},
      });
      assert.equal(result.statusCode, env.PUBLIC_ACCESS ? 401 : 403);
    } finally {
      await f.close();
    }
  });

test('guest access is revoked by policy, internal owners stay out of admin accounts, and guest cookies do not block member login', async () => {
  const f = await fixture();
  try {
    const guest = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: { host, origin },
      payload: {},
    });
    const cookie = guest.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const csrf = guest.json().csrf;
    const uploaded = await f.app.inject({
      method: 'POST',
      url: '/api/demos',
      headers: {
        host,
        origin,
        cookie,
        'x-csrf-token': csrf,
        'content-type': 'multipart/form-data; boundary=demo-boundary',
      },
      payload: uploadBody,
    });
    assert.equal(uploaded.statusCode, 202);
    const id = uploaded.json().id;
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host, origin, cookie },
      payload: { username: 'operator', password: 'synthetic-operator-password' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const memberCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const admin = await f.app.inject({
      url: '/api/admin',
      headers: { host, cookie: memberCookie },
    });
    assert.deepEqual(
      admin.json().users.map((user: { username: string }) => user.username),
      ['operator'],
    );
    const disabled = await f.app.inject({
      method: 'PATCH',
      url: '/api/admin',
      headers: { host, origin, cookie: memberCookie, 'x-csrf-token': login.json().user.csrf },
      payload: { guest_uploads_enabled: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(
      (await f.app.inject({ url: `/api/demos/${id}`, headers: { host, cookie } })).statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: { host, cookie } })).json().guest_session,
      null,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/guest/session',
          headers: { host, origin, cookie },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(f.db.one('SELECT public FROM demos WHERE id=?', id)!.public, 0);
  } finally {
    await f.close();
  }
});

test('setup token persists across startup preparation and rejects public permissions or a mismatched verifier', async () => {
  const f = await fixture({}, false);
  try {
    const { prepareSetup } = await import('../src/setup.js');
    const path = join(f.dir, 'setup-token');
    const saved = readFileSync(path, 'utf8');
    prepareSetup(f.db);
    assert.equal(readFileSync(path, 'utf8'), saved);
    f.db.run('UPDATE instance_setup SET token_hash=? WHERE id=1', '0'.repeat(64));
    assert.throws(() => prepareSetup(f.db), /does not match/);
    f.db.run('DELETE FROM instance_setup');
    const { chmodSync } = await import('node:fs');
    chmodSync(path, 0o644);
    assert.throws(() => prepareSetup(f.db), /private regular file/);
  } finally {
    await f.close();
  }
});

test('partial administrator environment configuration fails closed instead of exposing public setup', async () => {
  for (const env of [
    { ADMIN_USERNAME: 'operator' },
    { ADMIN_PASSWORD: 'synthetic-operator-password' },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'cswatch-invalid-admin-env-'));
    const db = new Store(dir);
    try {
      const config = loadConfig({ APP_URL: origin, COOKIE_SECURE: 'false', DATA_DIR: dir, ...env });
      await assert.rejects(() => createApp(config, db), /must be configured together/);
      assert.equal(db.one('SELECT count(*) AS n FROM users')!.n, 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('guest upload reserves and streams against the smaller visitor storage limit', async () => {
  const f = await fixture({ MAX_UPLOAD_MB: '2', GUEST_STORAGE_MB: '1' });
  try {
    assert.equal(
      (await f.app.inject({ url: '/api/config', headers: { host } })).json().max_upload_mb,
      1,
    );
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: { host, origin },
      payload: {},
    });
    const cookie = created.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const data = Buffer.concat([
      Buffer.from(
        '--demo-boundary\r\nContent-Disposition: form-data; name="file"; filename="too-large.dem"\r\nContent-Type: application/octet-stream\r\n\r\nPBDEMS2\0',
      ),
      Buffer.alloc(1024 ** 2),
      Buffer.from('\r\n--demo-boundary--\r\n'),
    ]);
    const upload = await f.app.inject({
      method: 'POST',
      url: '/api/demos',
      headers: {
        host,
        origin,
        cookie,
        'x-csrf-token': created.json().csrf,
        'content-type': 'multipart/form-data; boundary=demo-boundary',
      },
      payload: data,
    });
    assert.equal(upload.statusCode, 413, upload.body);
    assert.equal(f.db.one('SELECT count(*) AS n FROM demos')!.n, 0);
  } finally {
    await f.close();
  }
});

test('anonymous session capacity is bounded atomically before another temporary owner is created', async () => {
  const f = await fixture();
  try {
    f.db.run(
      "WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<4096) INSERT INTO users SELECT 'quota-guest-'||n,'$quota_guest_'||n,NULL,0,? FROM ids",
      now(),
    );
    f.db.run(
      "INSERT INTO guest_sessions SELECT id,'fixture-hash-'||id,'fixture-csrf',? FROM users WHERE id LIKE 'quota-guest-%'",
      now() + 3600,
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: { host, origin },
      payload: {},
    });
    assert.equal(response.statusCode, 503);
    assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions')!.n, 4096);
    assert.equal(f.db.one('SELECT count(*) AS n FROM users')!.n, 4097);
    assert.equal(response.cookies.length, 0);
  } finally {
    await f.close();
  }
});
