import { initializeFixture } from './fixtures/initialized.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { digest, hashPassword, COOKIE, steamStateCookie } from '../src/security.js';
import { reserve } from '../src/ingestion.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';
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
      headers: await browserBootstrap(app, config),
      payload: { username, password: 'a-long-test-password' },
    });
    assert.equal(r.statusCode, 201, r.body);
    return {
      cookie: `${COOKIE}=${r.cookies.find((c) => c.name === COOKIE)!.value}`,
      csrf: r.json().user.csrf,
      id: r.json().user.id,
      username: r.json().user.username,
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
    assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
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
    const logout = await s.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { host: 'localhost:8000', origin, cookie: u.cookie, 'x-csrf-token': u.csrf },
      payload: {},
    });
    assert.equal(logout.statusCode, 200);
    const login = await s.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: await browserBootstrap(s.app, s.config),
      payload: { username: u.username, password: 'a-long-test-password' },
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
    s.db.run('UPDATE users SET username=? WHERE id=?', 'steam_' + subject, preclaimed.id);
    assert.equal(
      s.db.one('SELECT username FROM users WHERE id=?', preclaimed.id)!.username,
      'steam_' + subject,
    );
    const browser = await browserBootstrap(s.app, s.config);
    const start = await s.app.inject({
      method: 'POST',
      url: '/api/auth/steam',
      headers: browser,
      payload: { return_to: '/account/connections' },
    });
    assert.equal(start.statusCode, 200);
    const upstream = new URL(start.json().location);
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
      if (input === `https://steamcommunity.com/profiles/${subject}/?xml=1`)
        return new Response('', { status: 503 });
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
        headers: {
          host: 'localhost:8000',
          cookie:
            browser.cookie +
            '; ' +
            steamStateCookie({ cookieSecure: false }, state).name +
            '=' +
            state,
        },
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
      /^steam_76561198000000001-[a-f0-9]{16}$/,
    );
    assert.equal((await callback()).statusCode, 400);
    assert.equal(verifications, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await s.close();
  }
});

test('Steam-created accounts retain a sign-in handle and update their display name until a password fixes it', async () => {
  const s = await setup({ STEAM_ENABLED: 'true' });
  const originalFetch = globalThis.fetch;
  let name = '';
  let nonce = 0;
  globalThis.fetch = async (input) => {
    const profile = /^https:\/\/steamcommunity\.com\/profiles\/(\d{17})\/\?xml=1$/.exec(
      String(input),
    );
    if (profile)
      return new Response(
        `<?xml version="1.0"?><profile><steamID64>${profile[1]}</steamID64><steamID><![CDATA[${name}]]></steamID></profile>`,
      );
    assert.equal(input, 'https://steamcommunity.com/openid/login');
    return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
  };
  const host = 'localhost:8000';
  async function signIn(subject: string, session?: { cookie: string; csrf: string }) {
    const browser = session
      ? { host, origin, cookie: session.cookie, 'x-csrf-token': session.csrf }
      : await browserBootstrap(s.app, s.config);
    const start = await s.app.inject({
      method: 'POST',
      url: session ? '/api/auth/steam/link' : '/api/auth/steam',
      headers: browser,
      payload: {},
    });
    assert.equal(start.statusCode, 200, start.body);
    const upstream = new URL(start.json().location);
    const returnTo = upstream.searchParams.get('openid.return_to')!;
    const state = new URL(returnTo).searchParams.get('state')!;
    const id = `https://steamcommunity.com/openid/id/${subject}`;
    const query = new URLSearchParams({
      state,
      'openid.mode': 'id_res',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.return_to': returnTo,
      'openid.identity': id,
      'openid.claimed_id': id,
      'openid.response_nonce': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + 'n' + nonce++,
      'openid.assoc_handle': 'test-assoc',
      'openid.signed': 'op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity',
      'openid.sig': 'test-signature',
    });
    const result = await s.app.inject({
      url: '/api/auth/steam/callback?' + query,
      headers: {
        host,
        cookie:
          browser.cookie +
          '; ' +
          steamStateCookie({ cookieSecure: false }, state).name +
          '=' +
          state,
      },
    });
    assert.equal(result.statusCode, 303, result.body);
    const cookie = `${COOKIE}=${result.cookies.find((c) => c.name === COOKIE)!.value}`;
    const me = await s.app.inject({ url: '/api/auth/me', headers: { host, cookie } });
    return { cookie, ...me.json().user } as {
      cookie: string;
      csrf: string;
      username: string;
      display_name: string;
    };
  }
  try {
    name = "Подсосник blick'a";
    const first = await signIn('76561198000000011');
    assert.equal(first.display_name, name);
    const twin = await signIn('76561198000000012');
    assert.equal(twin.display_name, name);
    assert.notEqual(twin.username, first.username);

    name = 'New name';
    assert.equal((await signIn('76561198000000011')).display_name, 'New name');
    name = '';
    const kept = await signIn('76561198000000011');
    assert.equal(kept.display_name, 'New name', 'A missing Steam name keeps the previous one.');

    const password = 'a-long-test-password';
    const set = await s.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { host, origin, cookie: kept.cookie, 'x-csrf-token': kept.csrf },
      payload: { new_password: password },
    });
    assert.equal(set.statusCode, 200, set.body);
    name = 'Renamed again';
    assert.equal((await signIn('76561198000000011')).display_name, 'New name');
    const login = await s.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: await browserBootstrap(s.app, s.config),
      payload: { username: kept.username.toUpperCase(), password },
    });
    assert.equal(login.statusCode, 200, login.body);

    const local = await s.register('local_owner');
    const linked = await signIn('76561198000000013', local);
    assert.equal(linked.username, local.username, 'Linking never renames a local account.');
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
      headers: await browserBootstrap(app, config),
      payload: { username: 'secure_review', password: 'a-long-secure-test-password' },
    });
    assert.equal(registration.statusCode, 201);
    assertCookie(String(registration.headers['set-cookie']), '__Host-cswatch_session');
    const session = registration.cookies.find(
      (cookie) => cookie.name === '__Host-cswatch_session',
    )!;
    const sessionCookie = `${session.name}=${session.value}`;
    const nonHostCookie = await app.inject({
      url: '/api/auth/me',
      headers: { ...headers, cookie: `${COOKIE}=${session.value}` },
    });
    assert.equal(nonHostCookie.json().user, null);
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/steam/link',
      headers: { ...headers, cookie: sessionCookie, 'x-csrf-token': registration.json().user.csrf },
      payload: {},
    });
    assert.equal(start.statusCode, 200);
    assert.ok(start.cookies[0].name.startsWith('__Host-cswatch_steam_state_'));
    assertCookie(String(start.headers['set-cookie']), start.cookies[0].name);
    const state = start.cookies.find((cookie) =>
      cookie.name.startsWith('__Host-cswatch_steam_state_'),
    )!.value;
    const returnTo = new URL(start.json().location).searchParams.get('openid.return_to')!;
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
      return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
    };
    const linked = await app.inject({
      url,
      headers: {
        ...headers,
        cookie: `${sessionCookie}; ${steamStateCookie({ cookieSecure: true }, state).name}=${state}`,
      },
    });
    assert.equal(linked.statusCode, 303, linked.body);
    assertCookie(String(linked.headers['set-cookie']), '__Host-cswatch_session');
    assert.equal(
      linked.cookies.some((cookie) => cookie.name.startsWith('__Host-cswatch_steam_state_')),
      false,
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
      payload: {},
    });
    assert.equal(logout.statusCode, 200);
    assertCookie(String(logout.headers['set-cookie']), '__Host-cswatch_browser');
    assert.ok(logout.cookies.every((row) => row.name !== '__Host-cswatch_session'));
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
    const memberHeaders = ({ cookie, csrf }: typeof a) => ({
      host: 'localhost:8000',
      origin,
      cookie,
      'x-csrf-token': csrf,
    });
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
          headers: memberHeaders(b),
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
          headers: memberHeaders(a),
          payload: { public: true },
        })
      ).statusCode,
      200,
    );
    assert.equal((await get()).statusCode, 200);
    assert.equal((await get(b.cookie)).statusCode, 200);

    const bookmarksUrl = `/api/demos/${d.id}/bookmarks`;
    const bookmarks = (member: typeof a) =>
      s.app.inject({ url: bookmarksUrl, headers: memberHeaders(member) });
    const note = await s.app.inject({
      method: 'POST',
      url: bookmarksUrl,
      headers: memberHeaders(a),
      payload: { tick: 20, label: 'Review this angle' },
    });
    assert.equal(note.statusCode, 201);
    assert.deepEqual((await bookmarks(b)).json(), []);
    const other = await s.app.inject({
      method: 'POST',
      url: bookmarksUrl,
      headers: memberHeaders(b),
      payload: { tick: 30, label: 'Check the rotation' },
    });
    assert.equal(other.statusCode, 201, other.body);
    assert.deepEqual((await bookmarks(a)).json(), [note.json()]);
    const bookmarkUrl = `/api/bookmarks/${other.json().id}`;
    const deleteBookmark = (member: typeof a) =>
      s.app.inject({ method: 'DELETE', url: bookmarkUrl, headers: memberHeaders(member) });
    assert.equal((await deleteBookmark(a)).statusCode, 200);
    assert.deepEqual((await bookmarks(b)).json(), [other.json()]);
    assert.equal((await deleteBookmark(b)).statusCode, 200);
    assert.deepEqual((await bookmarks(b)).json(), []);

    const list = await s.app.inject({ url: '/api/auth/sessions', headers: memberHeaders(b) });
    assert.equal(list.statusCode, 200, list.body);
    const [session] = list.json<{ sessions: { id: string; current: boolean }[] }>().sessions;
    assert.equal(session.current, true);
    const revokeSession = (member: typeof a) =>
      s.app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${session.id}`,
        headers: memberHeaders(member),
      });
    const denied = await revokeSession(a);
    assert.equal(denied.statusCode, 404, denied.body);
    const sessionUser = async () =>
      (await s.app.inject({ url: '/api/auth/me', headers: memberHeaders(b) })).json().user;
    assert.equal((await sessionUser())?.id, b.id);
    const revoked = await revokeSession(b);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(await sessionUser(), null);

    s.db.run(
      "UPDATE demos SET transcription_status='processing',transcription_started_at=? WHERE id=?",
      Math.floor(Date.now() / 1000),
      d.id,
    );
    const removed = await s.app.inject({
      method: 'DELETE',
      url: '/api/demos/' + d.id,
      headers: memberHeaders(a),
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((await get(a.cookie)).statusCode, 404);
    assert.ok(s.db.one('SELECT size FROM pending_demo_deletions WHERE id=?', d.id)!.size > 0);
  } finally {
    await s.close();
  }
});
test('external navigation does not extend the account idle deadline', async () => {
  const s = await setup();
  try {
    const member = await s.register();
    const previous = now() - 120;
    s.db.run('UPDATE sessions SET last_used_at=? WHERE user_id=?', previous, member.id);
    const get = (site: string) =>
      s.app.inject({
        url: '/api/auth/me',
        headers: { host: 'localhost:8000', cookie: member.cookie, 'sec-fetch-site': site },
      });
    assert.equal((await get('cross-site')).statusCode, 200);
    assert.equal(
      s.db.one('SELECT last_used_at FROM sessions WHERE user_id=?', member.id)!.last_used_at,
      previous,
    );
    assert.equal((await get('same-origin')).statusCode, 200);
    assert.ok(
      s.db.one('SELECT last_used_at FROM sessions WHERE user_id=?', member.id)!.last_used_at >
        previous,
    );
  } finally {
    await s.close();
  }
});

test('Steam match reads and sync removal revalidate the account under their own lock', async () => {
  const s = await setup();
  try {
    for (const method of ['GET', 'DELETE'] as const) {
      const member = await s.register();
      const transaction = s.db.transaction.bind(s.db);
      s.db.transaction = (work) => {
        s.db.transaction = transaction;
        s.db.run('DELETE FROM sessions WHERE user_id=?', member.id);
        return transaction(work);
      };
      const response = await s.app.inject({
        method,
        url: '/api/connections/steam/' + (method === 'GET' ? 'matches' : 'history'),
        headers: {
          host: 'localhost:8000',
          origin,
          cookie: member.cookie,
          'x-csrf-token': member.csrf,
        },
      });
      assert.equal(response.statusCode, 401, response.body);
    }
  } finally {
    await s.close();
  }
});

test('private reads cannot renew a session which expired before its activity write', async () => {
  const s = await setup();
  try {
    const member = await s.register();
    s.db.run('UPDATE sessions SET last_used_at=? WHERE user_id=?', now() - 61, member.id);
    const transaction = s.db.transaction.bind(s.db);
    s.db.transaction = (work) => {
      s.db.transaction = transaction;
      s.db.run('UPDATE sessions SET last_used_at=? WHERE user_id=?', now() - 86401, member.id);
      return transaction(work);
    };
    const response = await s.app.inject({
      url: '/api/demos?scope=mine',
      headers: { host: 'localhost:8000', cookie: member.cookie, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.ok(
      s.db.one('SELECT last_used_at FROM sessions WHERE user_id=?', member.id)!.last_used_at <=
        now() - 86400,
    );
  } finally {
    await s.close();
  }
});

test('a member revoked before the demo deletion transaction retains no write authority', async () => {
  const s = await setup();
  try {
    const member = await s.register();
    const demo = reserve(s.db, s.config, member.id, 'session-lock-fixture.dem', 'upload');
    s.db.run("UPDATE demos SET status='ready' WHERE id=?", demo.id);
    const transaction = s.db.transaction.bind(s.db);
    s.db.transaction = (work) => {
      s.db.transaction = transaction;
      s.db.run('DELETE FROM sessions WHERE user_id=?', member.id);
      return transaction(work);
    };
    const response = await s.app.inject({
      method: 'DELETE',
      url: '/api/demos/' + demo.id,
      headers: {
        host: 'localhost:8000',
        origin,
        cookie: member.cookie,
        'x-csrf-token': member.csrf,
      },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.ok(s.db.one('SELECT id FROM demos WHERE id=?', demo.id));
    assert.equal(s.db.one('SELECT id FROM pending_demo_deletions WHERE id=?', demo.id), undefined);
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
          headers: await browserBootstrap(s.app, s.config),
          payload: { username: 'someone', password: 'a-long-test-password' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/auth/steam',
          headers: await browserBootstrap(s.app, s.config),
          payload: {},
        })
      ).statusCode,
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
    assert.equal(s.db.one("SELECT count(*) AS n FROM users WHERE role='member'")!.n, 0);
  } finally {
    await s.close();
  }
});

test('Steam browser callbacks show action errors and retain the saved return intent', async (t) => {
  const s = await setup({ STEAM_ENABLED: 'true' });
  const linkedSubject = '76561198000000301';
  const unlinkedSubject = '76561198000000302';
  const returnTo = '/watch/private-review?t=128#round-3';
  let nonce = 0;
  let verified = true;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    if (input === `https://steamcommunity.com/profiles/${unlinkedSubject}/?xml=1`)
      return new Response(null, { status: 503 });
    assert.equal(input, 'https://steamcommunity.com/openid/login');
    return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${verified}\n`);
  });
  try {
    const owner = await s.register('steam_fixture_owner');
    const member = await s.register('steam_fixture_member');
    s.db.run("INSERT INTO identities VALUES('steam',?,?)", linkedSubject, owner.id);
    s.db.run("INSERT INTO settings VALUES('registrations_enabled',0)");
    const complete = async (subject: string, accept: string, link = false) => {
      const browser = link
        ? { host: s.config.host, origin, cookie: member.cookie, 'x-csrf-token': member.csrf }
        : await browserBootstrap(s.app, s.config);
      const started = await s.app.inject({
        method: 'POST',
        url: link ? '/api/auth/steam/link' : '/api/auth/steam',
        headers: browser,
        payload: link ? {} : { return_to: returnTo },
      });
      assert.equal(started.statusCode, 200, started.body);
      const upstream = new URL(started.json().location);
      const callback = new URL(upstream.searchParams.get('openid.return_to')!);
      const claimed = `https://steamcommunity.com/openid/id/${subject}`;
      for (const [key, value] of Object.entries({
        'openid.mode': 'id_res',
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
        'openid.return_to': callback.href,
        'openid.identity': claimed,
        'openid.claimed_id': claimed,
        'openid.response_nonce':
          new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + 'browser-result-' + nonce++,
        'openid.assoc_handle': 'fixture-handle',
        'openid.signed': 'op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity',
        'openid.sig': 'fixture-signature',
      }))
        callback.searchParams.set(key, value);
      return s.app.inject({
        url: callback.pathname + callback.search,
        headers: {
          host: s.config.host,
          accept,
          cookie:
            browser.cookie +
            '; ' +
            started.cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
        },
      });
    };

    const closed = await complete(unlinkedSubject, 'text/html');
    assert.equal(closed.statusCode, 303);
    assert.equal(
      closed.headers.location,
      '/login?' + new URLSearchParams({ steam: 'registration-closed', returnTo }),
    );
    assert.equal(closed.headers['set-cookie'], undefined);
    const closedApi = await complete(unlinkedSubject, 'application/json');
    assert.equal(closedApi.statusCode, 403);
    assert.deepEqual(closedApi.json(), { detail: 'New registrations are disabled.' });
    const existing = await complete(linkedSubject, 'text/html');
    assert.equal(existing.statusCode, 303);
    assert.equal(existing.headers.location, returnTo);

    const conflict = await complete(linkedSubject, 'text/html', true);
    assert.equal(conflict.statusCode, 303);
    assert.equal(conflict.headers.location, '/account/connections?steam=link-conflict');
    assert.equal(conflict.headers['set-cookie'], undefined);
    const conflictApi = await complete(linkedSubject, 'application/json', true);
    assert.equal(conflictApi.statusCode, 409);
    assert.deepEqual(conflictApi.json(), {
      detail: 'This Steam account is already linked to another account.',
    });

    verified = false;
    const unavailable = await complete(linkedSubject, 'text/html', true);
    assert.equal(unavailable.statusCode, 303);
    assert.equal(
      unavailable.headers.location,
      '/account/connections?steam=link-verification-failed',
    );
    assert.deepEqual(
      s.db
        .all("SELECT subject,user_id FROM identities WHERE provider='steam'")
        .map(({ subject, user_id }) => [subject, user_id]),
      [[linkedSubject, owner.id]],
    );
  } finally {
    await s.close();
  }
});

test('Steam rejects malformed and stale assertions, cross-state nonce reuse, and revoked linking sessions', async () => {
  const s = await setup({ STEAM_ENABLED: 'true' });
  const originalFetch = globalThis.fetch;
  const headers = { host: 'localhost:8000', origin };
  const validReply = 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n';
  const claimed = 'http://steamcommunity.com/openid/id/76561198000000222';
  let counter = 0;
  let verifications = 0;
  let upstream = () => new Response(validReply);
  globalThis.fetch = async (input, options) => {
    verifications++;
    assert.equal(input, 'https://steamcommunity.com/openid/login');
    assert.equal(options?.redirect, 'error');
    return upstream();
  };
  try {
    const member = await s.register('steam_linking_member');
    const authenticated = { ...headers, cookie: member.cookie, 'x-csrf-token': member.csrf };
    const start = async (link = false) => {
      const browser = link ? authenticated : await browserBootstrap(s.app, s.config);
      const response = await s.app.inject({
        method: 'POST',
        url: link ? '/api/auth/steam/link' : '/api/auth/steam',
        headers: browser,
        payload: link ? {} : { return_to: '//evil.test' },
      });
      assert.equal(response.statusCode, 200, response.body);
      const endpoint = new URL(response.json().location);
      const returnTo = endpoint.searchParams.get('openid.return_to')!;
      const state = new URL(returnTo).searchParams.get('state')!;
      const query = new URLSearchParams({
        state,
        'openid.mode': 'id_res',
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
        'openid.return_to': returnTo,
        'openid.identity': claimed,
        'openid.claimed_id': claimed,
        'openid.response_nonce':
          new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + 'case-' + counter++,
        'openid.assoc_handle': 'fixture-handle',
        'openid.signed': 'op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity',
        'openid.sig': 'fixture-signature',
      });
      return {
        query,
        callback: () =>
          s.app.inject({
            url: '/api/auth/steam/callback?' + query,
            headers: {
              ...headers,
              cookie:
                browser.cookie +
                '; ' +
                steamStateCookie({ cookieSecure: false }, state).name +
                '=' +
                state,
            },
          }),
      };
    };
    for (const changes of [
      { 'openid.identity': claimed + '0' },
      { 'openid.return_to': origin + '/library' },
      { 'openid.op_endpoint': 'https://other.example/openid/login' },
      { 'openid.signed': 'op_endpoint,return_to,response_nonce,assoc_handle,claimed_id' },
      { 'openid.response_nonce': '2000-01-01T00:00:00Zexpired' },
      { 'openid.response_nonce': '2026-02-29T00:00:00Zmalformed' },
      { 'openid.sig': '' },
    ]) {
      const flow = await start();
      for (const [name, value] of Object.entries(changes)) flow.query.set(name, value);
      assert.equal((await flow.callback()).statusCode, 400);
    }
    const cancelled = await start();
    cancelled.query.set('openid.mode', 'cancel');
    const refusal = await cancelled.callback();
    assert.equal(refusal.statusCode, 303);
    assert.equal(refusal.headers.location, '/login?steam=cancelled&returnTo=%2Flibrary');
    assert.equal(refusal.headers['set-cookie'], undefined);
    const expired = await start();
    s.db.run('UPDATE auth_states SET expires_at=0');
    assert.match((await expired.callback()).body, /expired/);
    assert.equal(verifications, 0);
    for (const body of [
      validReply.replace('true', 'false'),
      validReply + 'is_valid:false\n',
      'nonsense\nis_valid:true\n',
      validReply + 'x'.repeat(16384),
    ]) {
      upstream = () => new Response(body);
      assert.equal((await (await start()).callback()).statusCode, 400);
    }
    upstream = () => new Response(null, { status: 302 });
    assert.equal((await (await start()).callback()).statusCode, 400);
    upstream = () => new Response(validReply);
    const valid = await start();
    const signedIn = await valid.callback();
    assert.equal(signedIn.statusCode, 303, signedIn.body);
    assert.equal(signedIn.headers.location, '/library');
    const replay = await start();
    replay.query.set('openid.response_nonce', valid.query.get('openid.response_nonce')!);
    assert.equal((await replay.callback()).statusCode, 400);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/auth/steam/link',
          headers: { ...authenticated, origin: 'https://other.example' },
        })
      ).statusCode,
      403,
    );
    const conflict = await (await start(true)).callback();
    assert.equal(conflict.statusCode, 409);
    const link = await start(true);
    link.query.set('openid.identity', claimed.slice(0, -1) + '3');
    link.query.set('openid.claimed_id', claimed.slice(0, -1) + '3');
    upstream = () => {
      s.db.run('DELETE FROM sessions WHERE user_id=?', member.id);
      return new Response(validReply);
    };
    assert.match((await link.callback()).body, /Session expired/);
    assert.equal(
      s.db.one("SELECT subject FROM identities WHERE user_id=? AND provider='steam'", member.id),
      undefined,
    );
    s.db.run("INSERT INTO settings VALUES('registrations_enabled',0)");
    upstream = () => new Response(validReply);
    const closed = await start();
    closed.query.set('openid.identity', claimed.slice(0, -1) + '4');
    closed.query.set('openid.claimed_id', claimed.slice(0, -1) + '4');
    assert.equal((await closed.callback()).statusCode, 403);
    assert.equal((await (await start()).callback()).statusCode, 303);
  } finally {
    globalThis.fetch = originalFetch;
    await s.close();
  }
});

for (const purpose of ['login', 'step-up'] as const) {
  test(`a superseded Steam ${purpose} callback loses its destination and preserves the newer attempt cookie`, async () => {
    const s = await setup({ STEAM_ENABLED: 'true' });
    const originalFetch = globalThis.fetch;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    try {
      const user = purpose === 'step-up' ? await s.register('step_up_return') : null;
      const subject = '76561198000000222';
      if (user) s.db.run("INSERT INTO identities VALUES('steam',?,?)", subject, user.id);
      const browser = user
        ? { host: s.config.host, origin, cookie: user.cookie, 'x-csrf-token': user.csrf }
        : await browserBootstrap(s.app, s.config);
      async function start() {
        const response = await s.app.inject({
          method: 'POST',
          url: user ? '/api/auth/step-up/steam' : '/api/auth/steam',
          headers: browser,
          payload: { return_to: '/account/sessions?proofFor=sessions' },
        });
        assert.equal(response.statusCode, 200, response.body);
        const returnTo = new URL(response.json().location).searchParams.get('openid.return_to')!;
        const state = response.cookies.find(({ name }) => name.startsWith('steam_state_'))!;
        const callback = (query: URLSearchParams, accept?: string) =>
          s.app.inject({
            url: '/api/auth/steam/callback?' + query,
            headers: {
              ...browser,
              cookie: browser.cookie + '; ' + state.name + '=' + state.value,
              ...(accept ? { accept } : {}),
            },
          });
        return { returnTo, state: state.value, callback };
      }
      const preceding = await start();
      const claimed = 'https://steamcommunity.com/openid/id/' + subject;
      globalThis.fetch = async (input) => {
        assert.equal(input, 'https://steamcommunity.com/openid/login');
        entered.resolve();
        return release.promise;
      };
      const began = preceding.callback(
        new URLSearchParams({
          state: preceding.state,
          'openid.mode': 'id_res',
          'openid.ns': 'http://specs.openid.net/auth/2.0',
          'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
          'openid.return_to': preceding.returnTo,
          'openid.identity': claimed,
          'openid.claimed_id': claimed,
          'openid.response_nonce': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + 'delayed',
          'openid.assoc_handle': 'fixture',
          'openid.signed': 'op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity',
          'openid.sig': 'fixture-signature',
        }),
        'text/html',
      );
      await entered.promise;
      const replacement = await start();
      assert.notEqual(
        steamStateCookie(s.config, preceding.state).name,
        steamStateCookie(s.config, replacement.state).name,
      );
      release.resolve(new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
      const superseded = await began;
      assert.equal(superseded.statusCode, 303);
      assert.equal(superseded.headers.location, '/login?steam=verification-failed');
      assert.equal(superseded.headers['set-cookie'], undefined);
      const cancel = new URLSearchParams({ state: replacement.state, 'openid.mode': 'cancel' });
      assert.equal((await replacement.callback(cancel)).statusCode, 303);
      assert.equal((await replacement.callback(cancel)).statusCode, 400);
    } finally {
      release.resolve(new Response(null, { status: 400 }));
      globalThis.fetch = originalFetch;
      await s.close();
    }
  });
}

test('Steam starts charge only the matching browser stage, and an expired browser step-up returns to local sign-in', async () => {
  const s = await setup({ STEAM_ENABLED: 'true' });
  try {
    const browser = await browserBootstrap(s.app, s.config);
    const count = () =>
      s.db.one('SELECT count FROM rate_limits WHERE key=?', digest('steam-instance:instance'))
        ?.count ?? 0;
    const before = count();
    const denied = await s.app.inject({
      method: 'POST',
      url: '/api/auth/step-up/steam',
      headers: browser,
      payload: {},
    });
    assert.ok([401, 403].includes(denied.statusCode));
    assert.equal(count(), before);
    const user = await s.register('steam_step_up_fixture');
    s.db.run("INSERT INTO identities VALUES('steam',?,?)", '76561198000000228', user.id);
    const start = await s.app.inject({
      method: 'POST',
      url: '/api/auth/step-up/steam',
      headers: { host: s.config.host, origin, cookie: user.cookie, 'x-csrf-token': user.csrf },
      payload: { return_to: '/account?proof=password' },
    });
    assert.equal(start.statusCode, 200, start.body);
    assert.equal(count(), before + 1);
    const callback = new URL(new URL(start.json().location).searchParams.get('openid.return_to')!);
    const state = start.cookies.find((c) => c.name.startsWith('steam_state_'))!;
    s.db.run('UPDATE sessions SET expires_at=0 WHERE user_id=?', user.id);
    const returned = await s.app.inject({
      url: callback.pathname + callback.search,
      headers: {
        host: s.config.host,
        cookie: user.cookie + '; ' + state.name + '=' + state.value,
        accept: 'text/html',
      },
    });
    assert.equal(returned.statusCode, 303);
    assert.equal(returned.headers.location, '/login?steam=verification-failed');
    assert.equal(
      returned.cookies.some((c) => c.name === COOKIE && c.value !== ''),
      false,
    );
  } finally {
    await s.close();
  }
});
