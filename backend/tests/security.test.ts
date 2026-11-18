import { initializeFixture } from './fixtures/initialized.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { hashPassword, COOKIE } from '../src/security.js';
import { reserve } from '../src/ingestion.js';
const origin = 'http://localhost:8000';
async function setup(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-test-')),
    config = loadConfig({
      APP_URL: origin,
      COOKIE_SECURE: 'false',
      DATA_DIR: dir,
      LOG_LEVEL: 'silent',
      ...overrides,
    });
  const db = new Store(dir);
  initializeFixture(db);
  const app = await createApp(config, db);
  await app.ready();
  async function register(username = 'reviewer') {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { host: 'localhost:8000', origin },
      payload: { username, password: 'a-long-test-password' },
    });
    assert.equal(r.statusCode, 201, r.body);
    return {
      cookie: `${COOKIE}=${r.cookies.find((c) => c.name === COOKIE)!.value}`,
      csrf: r.json().user.csrf,
      id: r.json().user.id,
    };
  }
  return {
    app,
    db,
    config,
    dir,
    register,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('CSP permits local embedded model textures while restricting network and executable content', async () => {
  const s = await setup();
  try {
    const response = await s.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:8000' },
    });
    assert.equal(response.statusCode, 200);
    const directives = new Map(
      String(response.headers['content-security-policy'])
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .filter((parts) => parts[0])
        .map(([key, ...values]) => [key, values]),
    );
    assert.deepEqual(directives.get('connect-src'), ["'self'", 'blob:']);
    assert.deepEqual(directives.get('script-src'), ["'self'", "'wasm-unsafe-eval'"]);
    assert.deepEqual(directives.get('object-src'), ["'none'"]);
    assert.deepEqual(directives.get('base-uri'), ["'none'"]);
  } finally {
    await s.close();
  }
});
test('registration hashes passwords, sessions rotate, logout requires CSRF', async () => {
  const s = await setup();
  try {
    const u = await s.register();
    const row = s.db.one('SELECT * FROM users WHERE id=?', u.id)!;
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { host: 'localhost:8000', origin, cookie: u.cookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: {
            host: 'localhost:8000',
            origin,
            cookie: u.cookie,
            'x-csrf-token': 'é' + u.csrf.slice(1),
          },
        })
      ).statusCode,
      403,
    );
    const login = await s.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'localhost:8000', origin, cookie: u.cookie },
      payload: { username: 'reviewer', password: 'a-long-test-password' },
    });
    assert.equal(login.statusCode, 200);
    const newCookie = `${COOKIE}=${login.cookies.find((c) => c.name === COOKIE)!.value}`;
    assert.notEqual(newCookie, u.cookie);
    assert.equal(
      (
        await s.app.inject({
          url: '/api/auth/me',
          headers: { host: 'localhost:8000', cookie: u.cookie },
        })
      ).json().user,
      null,
    );
    const raw = newCookie.split('=')[1];
    assert.equal(s.db.one('SELECT * FROM sessions WHERE token_hash=?', raw), undefined);
  } finally {
    await s.close();
  }
});
test('verified Steam subject creates independent ownership when a local username was preclaimed; state cannot replay', async () => {
  const s = await setup({ STEAM_ENABLED: 'true' });
  const originalFetch = globalThis.fetch;
  try {
    const subject = '76561198000000001';
    const preclaimed = await s.register(`steam_${subject}`);
    const start = await s.app.inject({
      url: '/api/auth/steam?returnTo=%2Faccount%2Fconnections',
      headers: { host: 'localhost:8000' },
    });
    assert.equal(start.statusCode, 303);
    const upstream = new URL(start.headers.location!);
    const returnTo = upstream.searchParams.get('openid.return_to')!;
    const state = new URL(returnTo).searchParams.get('state')!;
    const query = new URLSearchParams({
      state,
      'openid.mode': 'id_res',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.return_to': returnTo,
      'openid.identity': `https://steamcommunity.com/openid/id/${subject}`,
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${subject}`,
      'openid.response_nonce': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + 'test-nonce',
      'openid.assoc_handle': 'test-assoc',
      'openid.signed': 'op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity',
      'openid.sig': 'test-signature',
    });
    let verifications = 0;
    globalThis.fetch = async (input, options) => {
      assert.equal(input, 'https://steamcommunity.com/openid/login');
      assert.equal(
        new URLSearchParams(String(options?.body)).get('openid.mode'),
        'check_authentication',
      );
      verifications++;
      return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
    };
    const callback = () =>
      s.app.inject({
        url: '/api/auth/steam/callback?' + query,
        headers: { host: 'localhost:8000', cookie: `steam_state=${state}` },
      });
    const result = await callback();
    assert.equal(result.statusCode, 303, result.body);
    assert.equal(result.headers.location, '/account/connections');
    const identity = s.db.one(
      "SELECT user_id FROM identities WHERE provider='steam' AND subject=?",
      subject,
    )!;
    assert.notEqual(identity.user_id, preclaimed.id);
    assert.match(
      s.db.one('SELECT username FROM users WHERE id=?', identity.user_id)!.username,
      /^steam_76561198000000001_[a-f0-9]{8}$/,
    );
    assert.equal((await callback()).statusCode, 400);
    assert.equal(verifications, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await s.close();
  }
});

test('HTTPS sessions and Steam state use host-only cookie prefixes, including rotation and clearing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-host-cookie-'));
  const config = loadConfig({
    APP_URL: 'https://cswatch.test',
    COOKIE_SECURE: 'true',
    STEAM_ENABLED: 'true',
    DATA_DIR: dir,
  });
  const db = new Store(dir);
  initializeFixture(db);
  const app = await createApp(config, db);
  const fetchBefore = globalThis.fetch;
  const headers = { host: 'cswatch.test', origin: 'https://cswatch.test' };
  const assertCookie = (header: string, name: string) => {
    assert.ok(header.startsWith(name + '='), header);
    assert.match(header, /; Path=\/(?:;|$)/);
    assert.match(header, /; Secure(?:;|$)/);
    assert.match(header, /; HttpOnly(?:;|$)/);
    assert.match(header, /; SameSite=Lax(?:;|$)/);
    assert.doesNotMatch(header, /; Domain=/i);
  };
  try {
    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: { username: 'secure_review', password: 'a-long-secure-test-password' },
    });
    assert.equal(registration.statusCode, 201);
    assertCookie(String(registration.headers['set-cookie']), '__Host-cswatch_session');
    const session = registration.cookies.find(
      (cookie) => cookie.name === '__Host-cswatch_session',
    )!;
    const sessionCookie = `${session.name}=${session.value}`;
    const legacy = await app.inject({
      url: '/api/auth/me',
      headers: { ...headers, cookie: `${COOKIE}=${session.value}` },
    });
    assert.equal(legacy.json().user, null);
    const start = await app.inject({
      url: '/api/auth/steam',
      headers: { ...headers, cookie: sessionCookie },
    });
    assertCookie(String(start.headers['set-cookie']), '__Host-cswatch_steam_state');
    const state = start.cookies.find(
      (cookie) => cookie.name === '__Host-cswatch_steam_state',
    )!.value;
    const returnTo = new URL(start.headers.location!).searchParams.get('openid.return_to')!;
    const claimed = 'https://steamcommunity.com/openid/id/76561198000000002';
    const query = new URLSearchParams({
      state,
      'openid.mode': 'id_res',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.return_to': returnTo,
      'openid.identity': claimed,
      'openid.claimed_id': claimed,
      'openid.response_nonce': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + 'test-secure',
      'openid.assoc_handle': 'test',
      'openid.signed': 'op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity',
      'openid.sig': 'test',
    });
    const url = '/api/auth/steam/callback?' + query;
    const wrongCookie = await app.inject({
      url,
      headers: { ...headers, cookie: `${sessionCookie}; steam_state=${state}` },
    });
    assert.equal(wrongCookie.statusCode, 400);
    globalThis.fetch = async (input) => {
      assert.equal(input, 'https://steamcommunity.com/openid/login');
      return new Response('is_valid:true\n');
    };
    const linked = await app.inject({
      url,
      headers: { ...headers, cookie: `${sessionCookie}; __Host-cswatch_steam_state=${state}` },
    });
    assert.equal(linked.statusCode, 303, linked.body);
    for (const header of linked.headers['set-cookie'] as string[])
      assertCookie(header, header.split('=')[0]);
    assert.equal(
      linked.cookies.find((cookie) => cookie.name === '__Host-cswatch_steam_state')!.value,
      '',
    );
    const next = linked.cookies.find((cookie) => cookie.name === '__Host-cswatch_session')!;
    assert.notEqual(next.value, session.value);
    const cookie = `${next.name}=${next.value}`;
    const me = await app.inject({ url: '/api/auth/me', headers: { ...headers, cookie } });
    assert.equal(me.json().user.id, registration.json().user.id);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...headers, cookie, 'x-csrf-token': me.json().user.csrf },
    });
    assert.equal(logout.statusCode, 200);
    assertCookie(String(logout.headers['set-cookie']), '__Host-cswatch_session');
    assert.equal(
      (await app.inject({ url: '/api/auth/me', headers: { ...headers, cookie } })).json().user,
      null,
    );
  } finally {
    globalThis.fetch = fetchBefore;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('private storage permissions apply to fresh and existing database volumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-volume-permissions-'));
  try {
    chmodSync(dir, 0o755);
    const first = new Store(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'replay.db')).mode & 0o777, 0o600);
    first.close();
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'replay.db'), 0o644);
    const second = new Store(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'replay.db')).mode & 0o777, 0o600);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('origin, host, anonymous authorization, and admin boundaries', async () => {
  const s = await setup();
  try {
    const u = await s.register();
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/auth/register',
          headers: { host: 'localhost:8000', origin: 'https://evil.example' },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await s.app.inject({ url: '/api/health', headers: { host: 'evil.example' } })).statusCode,
      400,
    );
    assert.equal(
      (await s.app.inject({ url: '/api/demos', headers: { host: 'localhost:8000' } })).statusCode,
      401,
    );
    assert.equal(
      (
        await s.app.inject({
          url: '/api/admin',
          headers: { host: 'localhost:8000', cookie: u.cookie },
        })
      ).statusCode,
      403,
    );
  } finally {
    await s.close();
  }
});
test('demo ownership, explicit sharing, private notes, and deletion', async () => {
  const s = await setup();
  try {
    const a = await s.register('alice'),
      b = await s.register('bobby');
    const d = reserve(s.db, s.config, a.id, 'match.dem', 'upload');
    s.db.run(
      "UPDATE demos SET status='ready',metadata=? WHERE id=?",
      JSON.stringify({ firstTick: 0, lastTick: 1000 }),
      d.id,
    );
    const get = (cookie?: string) =>
      s.app.inject({
        url: '/api/demos/' + d.id,
        headers: { host: 'localhost:8000', ...(cookie ? { cookie } : {}) },
      });
    assert.equal((await get(b.cookie)).statusCode, 404);
    assert.equal((await get()).statusCode, 404);
    assert.equal((await get(a.cookie)).statusCode, 200);
    assert.equal(
      (
        await s.app.inject({
          method: 'PATCH',
          url: '/api/demos/' + d.id,
          headers: { host: 'localhost:8000', origin, cookie: b.cookie, 'x-csrf-token': b.csrf },
          payload: { public: true },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'PATCH',
          url: '/api/demos/' + d.id,
          headers: { host: 'localhost:8000', origin, cookie: a.cookie, 'x-csrf-token': a.csrf },
          payload: { public: true },
        })
      ).statusCode,
      200,
    );
    assert.equal((await get()).statusCode, 200);
    const note = await s.app.inject({
      method: 'POST',
      url: `/api/demos/${d.id}/bookmarks`,
      headers: { host: 'localhost:8000', origin, cookie: a.cookie, 'x-csrf-token': a.csrf },
      payload: { tick: 20, label: 'Review this angle' },
    });
    assert.equal(note.statusCode, 201);
    const other = await s.app.inject({
      url: `/api/demos/${d.id}/bookmarks`,
      headers: { host: 'localhost:8000', cookie: b.cookie },
    });
    assert.deepEqual(other.json(), []);
  } finally {
    await s.close();
  }
});
test('environment wins over admin settings, private access gates public demos', async () => {
  const s = await setup({
    PUBLIC_ACCESS: 'false',
    REGISTRATIONS_ENABLED: 'false',
    STEAM_ENABLED: 'false',
  });
  try {
    s.db.run("INSERT INTO settings VALUES('public_access',1)");
    assert.equal(s.db.flag(s.config, 'public_access'), false);
    assert.equal(
      (await s.app.inject({ url: '/api/demos?scope=public', headers: { host: 'localhost:8000' } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/auth/register',
          headers: { host: 'localhost:8000', origin },
          payload: { username: 'someone', password: 'a-long-test-password' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await s.app.inject({ url: '/api/auth/steam', headers: { host: 'localhost:8000' } }))
        .statusCode,
      403,
    );
  } finally {
    await s.close();
  }
});
test('invalid uploads leave no queue rows; streamed quota reservations are atomic', async () => {
  const s = await setup({ MAX_UPLOAD_MB: '1', USER_STORAGE_MB: '1' });
  try {
    const u = await s.register();
    const body = Buffer.from(
      '--boundary\r\nContent-Disposition: form-data; name="file"; filename="bad.dem"\r\nContent-Type: application/octet-stream\r\n\r\nnot a demo\r\n--boundary--\r\n',
    );
    const r = await s.app.inject({
      method: 'POST',
      url: '/api/demos',
      headers: {
        host: 'localhost:8000',
        origin,
        cookie: u.cookie,
        'x-csrf-token': u.csrf,
        'content-type': 'multipart/form-data; boundary=boundary',
      },
      payload: body,
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(s.db.one('SELECT count(*) AS n FROM demos')!.n, 0);
    reserve(s.db, s.config, u.id, 'a.dem', 'upload');
    assert.throws(() => reserve(s.db, s.config, u.id, 'b.dem', 'upload'), /storage limit/);
  } finally {
    await s.close();
  }
});
test('Steam callback fails before network without matching one-use state', async () => {
  const s = await setup({ STEAM_ENABLED: 'true' });
  try {
    const r = await s.app.inject({
      url: '/api/auth/steam/callback?state=forged',
      headers: { host: 'localhost:8000', cookie: 'steam_state=forged' },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(s.db.one('SELECT count(*) AS n FROM users WHERE is_admin=0')!.n, 0);
  } finally {
    await s.close();
  }
});
