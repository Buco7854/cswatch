import { cleanupDeletedDemos } from '../src/demo-deletion.js';
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
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/server.js';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { guestCookieName, cleanupExpiredGuests } from '../src/guest.js';
import { issuePasswordReset } from '../src/recovery.js';
import {
  browserBindingCookieName,
  browserCookieName,
  digest,
  sessionCookieName,
  verifyPassword,
} from '../src/security.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';
import { withRouteInventory } from './fixtures/route-inventory.js';

const origin = 'http://localhost:8000';
const host = 'localhost:8000';
async function fixture(
  env: Record<string, string> = {},
  initialized = true,
  register?: (app: FastifyInstance) => void,
) {
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
  const db = new Store(dir);
  const { app } = await withRouteInventory(() => createApp(config, db), register);
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

test('guest admission extends the same browser grant and preserves a live recovery claim', async () => {
  const f = await fixture();
  try {
    const browser = await browserBootstrap(f.app, f.config);
    const owner = f.db.one("SELECT id FROM users WHERE username='operator'")!.id;
    const code = f.db.transaction(() => issuePasswordReset(f.db, owner));
    const claim = await f.app.inject({
      method: 'POST',
      url: '/api/auth/recover/claim',
      headers: browser,
      payload: { code },
    });
    assert.equal(claim.statusCode, 200, claim.body);
    const prior = f.db.one(
      "SELECT id,token_hash,created_at FROM sessions WHERE stage='anonymous'",
    )!;
    f.db.run("UPDATE sessions SET expires_at=? WHERE stage='anonymous'", now() + 20);
    const admission = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: browser,
      payload: {},
    });
    assert.equal(admission.statusCode, 201, admission.body);
    assert.ok(admission.cookies.some((cookie) => cookie.name === guestCookieName(f.config)));
    assert.ok(admission.cookies.every(({ name }) => name !== browserCookieName(f.config)));
    const { csrf, expires_at, ...current } = f.db.one(
      "SELECT id,token_hash,created_at,csrf,expires_at FROM sessions WHERE stage='anonymous'",
    )!;
    assert.deepEqual(current, { ...prior });
    assert.equal(csrf, browser['x-csrf-token']);
    assert.ok(expires_at >= now() + 629 && expires_at <= prior.created_at + 1800);
    const expectedClaim = claim.json();
    const status = await f.app.inject({
      url: '/api/auth/recover/status',
      headers: { ...browser, 'x-recovery-claim': expectedClaim.claim_id },
    });
    assert.equal(status.statusCode, 200, status.body);
    const { claim_id, recovery_expires_in_ms } = status.json();
    assert.equal(claim_id, expectedClaim.claim_id);
    assert.ok(
      recovery_expires_in_ms > 0 && recovery_expires_in_ms <= expectedClaim.recovery_expires_in_ms,
    );
    assert.equal(f.db.one('SELECT COUNT(*) AS n FROM guest_sessions')!.n, 1);
  } finally {
    await f.close();
  }
});

test('guest admission at the anonymous cap reserves upload time and preserves delivery on rollover', async () => {
  const f = await fixture();
  try {
    const browser = await browserBootstrap(f.app, f.config);
    const user = f.db.one("SELECT id FROM users WHERE username='operator'")!;
    const code = f.db.transaction(() => issuePasswordReset(f.db, user.id));
    const claim = await f.app.inject({
      method: 'POST',
      url: '/api/auth/recover/claim',
      headers: browser,
      payload: { code },
    });
    assert.equal(claim.statusCode, 200, claim.body);
    f.db.run(
      "UPDATE sessions SET created_at=?,expires_at=? WHERE stage='anonymous'",
      now() - 1300,
      now() + 500,
    );
    const admit = (headers: typeof browser) =>
      f.app.inject({ method: 'POST', url: '/api/guest/session', headers, payload: {} });
    const admission = await admit(browser);
    assert.equal(admission.statusCode, 201, admission.body);
    const freshCookie = admission.cookies.find(({ name }) => name === browserCookieName(f.config));
    assert.ok(freshCookie);
    assert.equal((await admit(browser)).statusCode, 403);
    const current = f.db.one("SELECT id,expires_at FROM sessions WHERE stage='anonymous'")!;
    assert.ok(current.expires_at >= now() + 629);
    const delivery = f.db.one('SELECT owner_id,browser_session_id FROM guest_sessions')!;
    assert.equal(delivery.browser_session_id, current.id);

    // Neither cookie from the initial reply arrived. Bootstrap can redeliver
    // the successor, then retry the guest delivery under its normal limit.
    const recovered = await browserBootstrap(f.app, f.config, browser.cookie);
    assert.ok(recovered.cookie.split('; ').includes(freshCookie.name + '=' + freshCookie.value));
    const expectedClaim = claim.json();
    const status = await f.app.inject({
      url: '/api/auth/recover/status',
      headers: { ...recovered, 'x-recovery-claim': expectedClaim.claim_id },
    });
    assert.equal(status.statusCode, 200, status.body);
    const { claim_id, recovery_expires_in_ms } = status.json();
    assert.equal(claim_id, expectedClaim.claim_id);
    assert.ok(
      recovery_expires_in_ms > 0 && recovery_expires_in_ms <= expectedClaim.recovery_expires_in_ms,
    );
    assert.equal((await admit(recovered)).statusCode, 429);
    f.db.run('UPDATE guest_sessions SET delivery_retry_at=?', now());
    assert.equal((await admit(recovered)).statusCode, 201);
    assert.equal(f.db.one('SELECT COUNT(*) AS n FROM guest_sessions')!.n, 1);
    assert.equal(f.db.one('SELECT 1 FROM users WHERE id=?', delivery.owner_id), undefined);
  } finally {
    await f.close();
  }
});

function beforeNextTransaction(db: Store, change: () => void) {
  const transaction = db.transaction.bind(db);
  db.transaction = (work) => {
    db.transaction = transaction;
    change();
    return transaction(work);
  };
}
const longDemoName = 'long-private-demo-'.repeat(8) + 'match.DEM';
const uploadBody = Buffer.concat([
  Buffer.from(
    `--demo-boundary\r\nContent-Disposition: form-data; name="file"; filename="${longDemoName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ),
  Buffer.from('PBDEMS2\0synthetic-not-a-parser-fixture'),
  Buffer.from('\r\n--demo-boundary--\r\n'),
]);

test('guest reservation checks its full stream deadline before charging the final upload allowance', async (t) => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none', GUEST_DEMO_LIMIT: '1' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const browser = await browserBootstrap(f.app, f.config);
    const prepare = (headers: typeof browser) =>
      f.app.inject({ method: 'POST', url: '/api/guest/session', headers, payload: {} });
    const issued = await prepare(browser);
    assert.equal(issued.statusCode, 201, issued.body);
    const capability = issued.cookies.find(({ name }) => name === guestCookieName(f.config))!;
    const headers = {
      ...browser,
      cookie: browser.cookie + '; ' + capability.name + '=' + capability.value,
      'x-csrf-token': issued.json().csrf as string,
    };
    const upload = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/demos',
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=demo-boundary' },
        payload: uploadBody,
      });
    f.db.run("UPDATE sessions SET expires_at=? WHERE stage='anonymous'", now() + 630);
    t.mock.timers.tick(31_000);
    assert.equal((await upload()).statusCode, 409);
    assert.equal(f.db.one('SELECT COUNT(*) AS count FROM guest_upload_grants')!.count, 0);
    assert.equal((await prepare(headers)).statusCode, 200);
    assert.equal((await upload()).statusCode, 202);
  } finally {
    await f.close();
  }
});

for (const [change, expected] of [
  ['maintenance', 202],
  ['sign-in', 401],
  ['sign-out confirmation', 401],
  ['guest expiry', 401],
  ['guest policy change', 401],
  ['deadline', 408],
] as const)
  test(`guest upload after anonymous rollover and ${change}`, { timeout: 5000 }, async (t) => {
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const reserved = Promise.withResolvers<string>();
    const f = await fixture({ MFA_REQUIRED_ROLES: 'none' }, true, (app) => {
      app.addHook('preHandler', async (r) => {
        if (r.url === '/api/demos?wait=1') {
          paused.resolve();
          await resume.promise;
        }
      });
    });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const body = new PassThrough();
    const boundary = uploadBody.lastIndexOf('\r\n--demo-boundary--\r\n');
    const pending: PromiseLike<unknown>[] = [];
    try {
      const browser = await browserBootstrap(f.app, f.config);
      const original = f.db.one("SELECT token_hash FROM sessions WHERE stage='anonymous'")!;
      f.db.run(
        "UPDATE sessions SET created_at=?,expires_at=? WHERE stage='anonymous'",
        now() - 1155,
        now() + 645,
      );
      const prepare = (headers: typeof browser) =>
        f.app.inject({ method: 'POST', url: '/api/guest/session', headers, payload: {} });
      const guest = await prepare(browser);
      assert.equal(guest.statusCode, 201, guest.body);
      const capability = guest.cookies.find(({ name }) => name === guestCookieName(f.config))!;
      const guestHeaders = {
        ...browser,
        cookie: `${browser.cookie}; ${capability.name}=${capability.value}`,
        'x-csrf-token': guest.json().csrf as string,
      };
      const uploadHeaders = {
        ...guestHeaders,
        'content-type': 'multipart/form-data; boundary=demo-boundary',
      };
      const run = f.db.run.bind(f.db);
      f.db.run = (sql, ...args) => {
        const result = run(sql, ...args);
        if (sql.startsWith('INSERT INTO demos(')) reserved.resolve(args[0]);
        return result;
      };
      body.write(uploadBody.subarray(0, boundary));
      const active = f.app
        .inject({ method: 'POST', url: '/api/demos', headers: uploadHeaders, payload: body })
        .then((response) => response);
      pending.push(active);
      const id = await reserved.promise;
      const owner = f.db.one('SELECT owner_id FROM demos WHERE id=?', id)!.owner_id;
      assert.equal(f.db.one('SELECT status FROM demos WHERE id=?', id)!.status, 'uploading');

      const waiting =
        change === 'maintenance'
          ? f.app
              .inject({
                method: 'POST',
                url: '/api/demos?wait=1',
                headers: uploadHeaders,
                payload: uploadBody,
              })
              .then((response) => response)
          : null;
      if (waiting) {
        pending.push(waiting);
        await paused.promise;
      }

      // A second tab now needs more time than the original grant has left.
      t.mock.timers.tick(20_000);
      const rollover = await prepare(guestHeaders);
      assert.equal(rollover.statusCode, 200, rollover.body);
      const replacement = rollover.cookies.find(({ name }) => name === browserCookieName(f.config));
      const binding = rollover.cookies.find(
        ({ name }) => name === browserBindingCookieName(f.config),
      );
      assert.ok(replacement);
      assert.ok(binding);
      assert.ok(browser.cookie.split('; ').includes(`${binding.name}=${binding.value}`));
      assert.equal(binding.maxAge, f.config.sessionDays * 86400 + 1800 + 600);
      assert.notEqual(digest(replacement.value), original.token_hash);
      assert.equal(
        f.db.one('SELECT 1 FROM sessions WHERE token_hash=?', original.token_hash),
        undefined,
      );
      if (waiting) {
        resume.resolve();
        const stale = await waiting;
        assert.equal(stale.statusCode, 401, stale.body);
        const late = await f.app.inject({
          method: 'POST',
          url: '/api/demos',
          headers: uploadHeaders,
          payload: uploadBody,
        });
        assert.equal(late.statusCode, 409, late.body);
        assert.equal(late.headers['x-session-changed'], '1');
        assert.equal(f.db.one('SELECT count(*) AS n FROM demos')!.n, 1);
      }

      if (change === 'sign-in' || change === 'sign-out confirmation') {
        const fresh = await browserBootstrap(f.app, f.config, guestHeaders.cookie);
        const transition = await f.app.inject({
          method: 'POST',
          url: change === 'sign-in' ? '/api/auth/login' : '/api/auth/logout',
          headers: fresh,
          payload:
            change === 'sign-in'
              ? { username: 'operator', password: 'synthetic-operator-password' }
              : { preserve_anonymous_operations: true },
        });
        assert.equal(transition.statusCode, 200, transition.body);
        assert.equal(transition.json().session.stage, change === 'sign-in' ? 'full' : 'anonymous');
      } else if (change === 'guest expiry') {
        f.db.run('UPDATE guest_sessions SET expires_at=? WHERE owner_id=?', now(), owner);
      } else if (change === 'guest policy change') {
        f.db.run("INSERT INTO settings VALUES('guest_uploads_enabled',0)");
      }

      // Finish after the short cookie redelivery grace and at the edge of the stream deadline.
      t.mock.timers.tick(change === 'deadline' ? 580_000 : 579_000);
      body.end(uploadBody.subarray(boundary));
      const result = await active;
      assert.equal(result.statusCode, expected, result.body);
      assert.equal(f.db.one('SELECT 1 FROM guest_upload_grants WHERE demo_id=?', id), undefined);
      const demo = f.db.one('SELECT owner_id,status,public FROM demos WHERE id=?', id);
      if (expected === 202) {
        assert.equal(result.json().id, id);
        assert.deepEqual({ ...demo }, { owner_id: owner, status: 'queued', public: 0 });
      } else {
        assert.equal(demo, undefined);
        assert.ok(!existsSync(join(f.dir, 'demos', id)));
      }
    } finally {
      resume.resolve();
      if (!body.writableEnded) body.end(uploadBody.subarray(boundary));
      await Promise.allSettled(pending);
      await f.close();
    }
  });

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
      const browser = await browserBootstrap(f.app, f.config);
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
            headers: browser,
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
        ['admin_one', 'admin_two'].map(async (username) =>
          f.app.inject({
            method: 'POST',
            url: '/api/setup',
            headers: await browserBootstrap(f.app, f.config),
            payload: { username, password: 'synthetic-admin-password', setupToken: code },
          }),
        ),
      );
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
      assert.equal(f.db.one("SELECT count(*) AS n FROM users WHERE role='admin'")!.n, 1);
      const success = results.find((r) => r.statusCode === 201)!;
      const cookie = success.cookies.find((cookie) => cookie.name === sessionCookieName(f.config))!;
      assert.equal(success.json().session.stage, 'enroll');
      assert.equal(
        f.db.one("SELECT scope FROM audit WHERE action='instance.configured'")!.scope,
        'operator',
      );
      assert.equal(success.json().user, null);
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
            headers: await browserBootstrap(f.app, f.config),
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
    const row = f.db.one("SELECT * FROM users WHERE role='admin'")!;
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
    const create = async () =>
      f.app.inject({
        method: 'POST',
        url: '/api/guest/session',
        headers: await browserBootstrap(f.app, f.config),
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
    assert.equal(own.name, longDemoName.slice(0, 116) + '.DEM');
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
    f.db.run(
      "UPDATE demos SET status='ready',metadata=? WHERE id=?",
      JSON.stringify({ replayVersion: 3 }),
      id,
    );
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
    const boundConfig = () =>
      f.app.inject({ url: '/api/config', headers: { host, cookie, 'x-guest-context': csrf } });
    assert.equal((await boundConfig()).statusCode, 200);
    f.db.run('UPDATE guest_sessions SET expires_at=? WHERE owner_id=?', now() - 1, owner);
    const changedConfig = await boundConfig();
    assert.equal(changedConfig.statusCode, 409);
    assert.equal(changedConfig.headers['x-session-changed'], '1');
    assert.equal(
      (await f.app.inject({ url: `/api/demos/${id}`, headers: { host, cookie } })).statusCode,
      404,
    );
    cleanupExpiredGuests(f.db, f.config);
    cleanupDeletedDemos(f.db);
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
        headers: await browserBootstrap(f.app, f.config),
        payload: {},
      });
      assert.equal(result.statusCode, env.PUBLIC_ACCESS ? 401 : 403);
    } finally {
      await f.close();
    }
  });

test('guest issuance rechecks browser validity and policy when reserving an owner', async () => {
  const f = await fixture();
  try {
    for (const [change, status] of [
      ["UPDATE sessions SET expires_at=0 WHERE stage='anonymous'", 401],
      ["INSERT INTO settings VALUES('guest_uploads_enabled',0)", 403],
    ] as const) {
      const headers = await browserBootstrap(f.app, f.config);
      const budgets = f.db.all('SELECT * FROM rate_limits ORDER BY key');
      beforeNextTransaction(f.db, () => f.db.run(change));
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/guest/session',
        headers,
        payload: {},
      });
      assert.equal(response.statusCode, status, response.body);
      assert.equal(response.cookies.length, 0);
      assert.equal(f.db.one('SELECT count(*) AS n FROM users')!.n, 1);
      assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions')!.n, 0);
      assert.deepEqual(f.db.all('SELECT * FROM rate_limits ORDER BY key'), budgets);
    }
  } finally {
    await f.close();
  }
});

test('reusing a guest session returns only a live capability without renewing it', async () => {
  const f = await fixture();
  try {
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: await browserBootstrap(f.app, f.config),
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    const [guestCookie] = created.cookies;
    const reuse = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/guest/session',
        headers: {
          host,
          origin,
          cookie: `${guestCookie.name}=${guestCookie.value}`,
          'x-csrf-token': created.json().csrf,
        },
        payload: {},
      });
    const active = await reuse();
    assert.equal(active.statusCode, 200, active.body);
    assert.deepEqual(active.json(), created.json());
    assert.equal(active.cookies.length, 0);

    beforeNextTransaction(f.db, () => f.db.run('UPDATE guest_sessions SET expires_at=0'));
    const expired = await reuse();
    assert.equal(expired.statusCode, 401, expired.body);
    assert.equal(expired.cookies.length, 0);
    assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions')!.n, 1);
    assert.equal(f.db.one('SELECT expires_at FROM guest_sessions')!.expires_at, 0);
  } finally {
    await f.close();
  }
});

test('concurrent uploads preparing from one browser establish a single guest capability', async () => {
  const f = await fixture();
  try {
    const browser = await browserBootstrap(f.app, f.config);
    const create = (headers = browser) =>
      f.app.inject({ method: 'POST', url: '/api/guest/session', headers, payload: {} });
    const results = await Promise.all([create(), create()]);
    assert.deepEqual(results.map((response) => response.statusCode).sort(), [201, 429]);
    const created = results.find((response) => response.statusCode === 201)!;
    const [cookie] = created.cookies;
    const waiting = results.find((response) => response.statusCode === 429)!;
    assert.equal(waiting.cookies.length, 0);
    assert.equal(waiting.json().csrf, undefined);
    assert.ok(Number(waiting.headers['retry-after']) > 0);
    assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions')!.n, 1);

    const resumed = await create({
      ...browser,
      cookie: `${browser.cookie}; ${cookie.name}=${cookie.value}`,
      'x-csrf-token': created.json().csrf,
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.cookies.length, 0);
    assert.deepEqual(resumed.json(), created.json());
  } finally {
    await f.close();
  }
});

test('a lost guest cookie can be replaced once after the delivery grace', async () => {
  const f = await fixture();
  try {
    const browser = await browserBootstrap(f.app, f.config);
    const create = () =>
      f.app.inject({ method: 'POST', url: '/api/guest/session', headers: browser, payload: {} });
    const original = await create();
    assert.equal(original.statusCode, 201, original.body);
    const [lostCookie] = original.cookies;
    const previous = f.db.one('SELECT owner_id FROM guest_sessions')!;
    f.db.run('UPDATE guest_sessions SET delivery_retry_at=?', now() - 1);
    const responses = await Promise.all([create(), create()]);
    assert.deepEqual(responses.map(({ statusCode }) => statusCode).sort(), [201, 429]);
    const replacement = responses.find(({ statusCode }) => statusCode === 201)!;
    assert.notEqual(replacement.cookies[0].value, lostCookie.value);
    assert.notEqual(replacement.json().csrf, original.json().csrf);
    assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions')!.n, 1);
    assert.equal(f.db.one('SELECT id FROM users WHERE id=?', previous.owner_id), undefined);
    const staleJar = `${browser.cookie}; ${lostCookie.name}=${lostCookie.value}`;
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: { host, cookie: staleJar } })).json()
        .guest_session,
      null,
    );
    const exhausted = await create();
    assert.equal(exhausted.statusCode, 429, exhausted.body);
    assert.equal(exhausted.cookies.length, 0);
  } finally {
    await f.close();
  }
});

test('guest issuance cannot replace a capability with a reservation or confirmed delivery', async () => {
  const f = await fixture();
  try {
    const browser = await browserBootstrap(f.app, f.config);
    const create = (headers = browser) =>
      f.app.inject({ method: 'POST', url: '/api/guest/session', headers, payload: {} });
    const issued = await create();
    assert.equal(issued.statusCode, 201, issued.body);
    const [guestCookie] = issued.cookies;
    const owner = f.db.one('SELECT owner_id FROM guest_sessions')!.owner_id;
    const { reserve, abandonUpload } = await import('../src/ingestion.js');
    const pending = reserve(f.db, f.config, owner, 'reserved.dem', 'guest');
    f.db.run('UPDATE guest_sessions SET delivery_retry_at=?', now() - 1);

    const denied = await create();
    assert.equal(denied.statusCode, 429, denied.body);
    assert.equal(denied.cookies.length, 0);
    assert.equal(f.db.one('SELECT owner_id FROM demos WHERE id=?', pending.id)!.owner_id, owner);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/demos/' + pending.id,
          headers: { host, cookie: browser.cookie },
        })
      ).statusCode,
      404,
    );
    const received = await create({
      ...browser,
      cookie: `${browser.cookie}; ${guestCookie.name}=${guestCookie.value}`,
      'x-csrf-token': issued.json().csrf,
    });
    assert.equal(received.statusCode, 200, received.body);
    assert.deepEqual(received.json(), issued.json());
    abandonUpload(f.db, pending.id);
    assert.equal((await create()).statusCode, 429);
    assert.equal(f.db.one('SELECT owner_id FROM guest_sessions')!.owner_id, owner);
  } finally {
    await f.close();
  }
});

test('bound config reads signal guest or member session expiry across request hooks', async () => {
  let expireGuest: (() => void) | undefined;
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' }, true, (app) => {
    app.addHook('preValidation', async (request) => {
      if (request.routeOptions.url === '/api/config') expireGuest?.();
    });
  });
  try {
    const guest = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: await browserBootstrap(f.app, f.config),
      payload: {},
    });
    assert.equal(guest.statusCode, 201, guest.body);
    const [guestCookie] = guest.cookies;
    expireGuest = () => f.db.run('UPDATE guest_sessions SET expires_at=0');
    const staleGuest = await f.app.inject({
      url: '/api/config',
      headers: {
        host,
        cookie: `${guestCookie.name}=${guestCookie.value}`,
        'x-guest-context': guest.json().csrf,
      },
    });
    assert.equal(staleGuest.statusCode, 409, staleGuest.body);
    assert.equal(staleGuest.headers['x-session-changed'], '1');
    expireGuest = undefined;

    const member = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: await browserBootstrap(f.app, f.config),
      payload: { username: 'operator', password: 'synthetic-operator-password' },
    });
    assert.equal(member.statusCode, 200, member.body);
    const memberCookie = member.cookies.find(
      (cookie) => cookie.name === sessionCookieName(f.config),
    )!;
    f.db.run("UPDATE sessions SET last_used_at=? WHERE stage='full'", now() - 61);
    beforeNextTransaction(f.db, () =>
      f.db.run("UPDATE sessions SET expires_at=0 WHERE stage='full'"),
    );
    const staleMember = await f.app.inject({
      method: 'HEAD',
      url: '/api/config',
      headers: {
        host,
        cookie: `${memberCookie.name}=${memberCookie.value}`,
        'x-session-context': member.json().session.csrf,
      },
    });
    assert.equal(staleMember.statusCode, 409);
    assert.equal(staleMember.headers['x-session-changed'], '1');
  } finally {
    await f.close();
  }
});

test('guest access is revoked by policy, internal owners stay out of admin accounts, and guest cookies do not block member login', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const guest = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: await browserBootstrap(f.app, f.config),
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
      headers: await browserBootstrap(f.app, f.config, cookie),
      payload: { username: 'operator', password: 'synthetic-operator-password' },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(
      f.db.one("SELECT scope FROM audit WHERE action='instance.admin_provisioned'")!.scope,
      'operator',
    );
    const memberCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const users = await f.app.inject({
      url: '/api/admin/users',
      headers: { host, cookie: memberCookie, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(users.statusCode, 200, users.body);
    assert.deepEqual(
      users.json().users.map((user: { username: string }) => user.username),
      ['operator'],
    );
    const both = memberCookie + '; ' + cookie;
    assert.equal(
      (await f.app.inject({ url: '/api/demos/' + id, headers: { host, cookie: both } })).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'DELETE',
          url: '/api/demos/' + id,
          headers: { host, origin, cookie: both, 'x-csrf-token': login.json().user.csrf },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject({ url: '/api/demos/' + id, headers: { host, cookie } })).statusCode,
      200,
    );
    assert.equal(
      f.db.one("SELECT actor FROM audit WHERE action='demo.uploaded' ORDER BY id DESC LIMIT 1")!
        .actor,
      null,
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
    const disabledGuest = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: await browserBootstrap(f.app, f.config, cookie),
      payload: {},
    });
    assert.equal(disabledGuest.statusCode, 403);
    assert.equal(disabledGuest.json().detail, 'Guest uploads are disabled.');
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
      headers: await browserBootstrap(f.app, f.config),
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
      "WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<4096) INSERT INTO users(id,username,created_at) SELECT 'quota-guest-'||n,'$quota_guest_'||n,? FROM ids",
      now(),
    );
    f.db.run(
      "INSERT INTO guest_sessions(owner_id,token_hash,csrf,expires_at) SELECT id,'fixture-hash-'||id,'fixture-csrf',? FROM users WHERE id LIKE 'quota-guest-%'",
      now() + 3600,
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: await browserBootstrap(f.app, f.config),
      payload: {},
    });
    assert.equal(response.statusCode, 503);
    assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions')!.n, 4096);
    assert.equal(f.db.one('SELECT count(*) AS n FROM users')!.n, 4097);
    assert.equal(response.cookies.length, 0);
    f.db.run(
      'UPDATE guest_sessions SET expires_at=0 WHERE owner_id IN (SELECT owner_id FROM guest_sessions LIMIT 150)',
    );
    const renewed = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: await browserBootstrap(f.app, f.config),
      payload: {},
    });
    assert.equal(renewed.statusCode, 201, renewed.body);
    assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions')!.n, 4096);
    assert.equal(f.db.one('SELECT count(*) AS n FROM guest_sessions WHERE expires_at=0')!.n, 149);
  } finally {
    await f.close();
  }
});

test('guest expiry keeps the disk reservation of a bounded writer until close', async () => {
  const f = await fixture();
  try {
    const guest = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: await browserBootstrap(f.app, f.config),
      payload: {},
    });
    assert.equal(guest.statusCode, 201, guest.body);
    const owner = f.db.one(
      'SELECT owner_id FROM guest_sessions WHERE csrf=?',
      guest.json().csrf,
    )!.owner_id;
    const { reserve, abandonUpload } = await import('../src/ingestion.js');
    const pending = reserve(f.db, f.config, owner, 'fixture.dem', 'guest');
    f.db.run('UPDATE guest_sessions SET expires_at=0 WHERE owner_id=?', owner);
    cleanupExpiredGuests(f.db, f.config);
    cleanupDeletedDemos(f.db);
    assert.equal(f.db.one('SELECT id FROM users WHERE id=?', owner), undefined);
    assert.ok(f.db.one('SELECT size FROM pending_demo_deletions WHERE id=?', pending.id)!.size > 0);
    assert.ok(existsSync(pending.folder));
    abandonUpload(f.db, pending.id);
    assert.equal(
      f.db.one('SELECT 1 FROM pending_demo_deletions WHERE id=?', pending.id),
      undefined,
    );
    assert.ok(!existsSync(pending.folder));
  } finally {
    await f.close();
  }
});
