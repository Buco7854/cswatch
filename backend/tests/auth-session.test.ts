import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { now, Store } from '../src/db.js';
import { issuePasswordReset } from '../src/recovery.js';
import {
  browserBindingCookieName,
  confirmAnonymousSignOut,
  currentSession,
  digest,
  sessionCookieName,
} from '../src/security.js';
import { createApp } from '../src/server.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';

import { withRouteInventory } from './fixtures/route-inventory.js';

const password = 'synthetic-operator-password';
async function fixture(
  settings: Record<string, string> = {},
  register?: Parameters<typeof withRouteInventory>[1],
) {
  const dir = await mkdtemp(join(tmpdir(), 'cswatch-account-session-'));
  await mkdir(join(dir, 'frontend', 'assets'), { recursive: true });
  await writeFile(join(dir, 'frontend', 'assets', 'fixture.js'), 'void 0;');
  const c = loadConfig({
    FRONTEND_DIR: join(dir, 'frontend'),
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: dir,
    ADMIN_USERNAME: 'operator',
    ADMIN_PASSWORD: password,
    ...settings,
  });
  const db = new Store(dir);
  const { app, routes } = await withRouteInventory(() => createApp(c, db), register);
  const login = async (guestCookie = '', requestHeaders: Record<string, string> = {}) => {
    const headers = await browserBootstrap(app, c);
    return app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...headers, ...requestHeaders, cookie: headers.cookie + guestCookie },
      payload: { username: 'operator', password },
    });
  };
  return {
    app,
    db,
    c,
    login,
    routes,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const stage of ['enroll', 'challenge'] as const)
  for (const publicAccess of [true, false])
    test(`${stage} has only its limited routes with public access ${publicAccess}`, async () => {
      const f = await fixture({
        PUBLIC_ACCESS: String(publicAccess),
        GUEST_UPLOADS_ENABLED: 'true',
      });
      try {
        if (stage === 'challenge')
          f.db.run("INSERT INTO auth_totp SELECT id,X'01',0,0 FROM users WHERE role='admin'");
        let guestCookie = '';
        if (publicAccess) {
          const g = await f.app.inject({
            method: 'POST',
            url: '/api/guest/session',
            headers: await browserBootstrap(f.app, f.c),
            payload: {},
          });
          assert.equal(g.statusCode, 201, g.body);
          guestCookie = '; ' + g.cookies[0].name + '=' + g.cookies[0].value;
        }
        const entered = await f.login(guestCookie);
        assert.equal(entered.statusCode, 200, entered.body);
        assert.equal(entered.json().user, null);
        assert.equal(entered.json().session.stage, stage);
        assert.equal(entered.json().guest_session, null);
        const cookie = entered.cookies.find(({ name }) => name === sessionCookieName(f.c))!;
        const headers = {
          host: f.c.host,
          origin: f.c.appUrl,
          cookie: cookie.name + '=' + cookie.value + guestCookie,
          'x-csrf-token': entered.json().session.csrf,
        };
        const allow = new Set([
          'GET /api/config',
          'HEAD /api/config',
          'GET /api/auth/me',
          'HEAD /api/auth/me',
          'POST /api/auth/logout',
          ...(stage === 'enroll'
            ? [
                'GET /api/auth/security',
                'HEAD /api/auth/security',
                'POST /api/auth/factors/passkeys/options',
                'POST /api/auth/factors/passkeys/verify',
                'POST /api/auth/factors/passkeys/confirm',
                'POST /api/auth/factors/passkeys/cancel',
                'POST /api/auth/factors/totp/options',
                'POST /api/auth/factors/totp/verify',
              ]
            : [
                'POST /api/auth/mfa/passkey/options',
                'POST /api/auth/mfa/passkey/verify',
                'POST /api/auth/mfa/totp',
                'POST /api/auth/mfa/recovery',
              ]),
          'GET /assets/*',
          'HEAD /assets/*',
          'GET /licenses/provider-brands.txt',
          'HEAD /licenses/provider-brands.txt',
        ]);
        const visited = new Set<string>();
        for (const { method, path } of f.routes) {
          const key = method + ' ' + path;
          visited.add(key);
          if (allow.has(key)) continue;
          const url = path
            .replace(/:[\w-]+/g, '0123456789abcdef0123456789abcdef')
            .replace(/\*/g, 'fixture');
          const result = await f.app.inject({
            method,
            url,
            headers,
            ...(['POST', 'PATCH', 'PUT'].includes(method) ? { payload: {} } : {}),
          });
          assert.equal(result.statusCode, 403, key);
          if (method !== 'HEAD') assert.match(result.body, /Complete sign-in to continue/, key);
        }
        for (const expected of allow) assert.ok(visited.has(expected), expected + ' must exist');
        assert.ok(visited.has('POST /api/demos'));
        assert.ok(visited.has('GET /api/admin/users'));
        assert.equal((await f.app.inject({ url: '/assets/fixture.js', headers })).statusCode, 200);
        const library = await f.app.inject({ url: '/library', headers });
        assert.equal(library.statusCode, 303);
        assert.equal(
          library.headers.location,
          (stage === 'enroll' ? '/account' : '/login') + '?returnTo=%2Flibrary',
        );
        const me = await f.app.inject({ url: '/api/auth/me', headers });
        assert.equal(me.json().session.stage, stage);
        assert.equal(me.json().session.username, stage === 'enroll' ? 'operator' : null);
        const logout = await f.app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers,
          payload: {},
        });
        assert.equal(logout.json().session.stage, 'anonymous');
        assert.ok(
          logout.cookies.every((row) => row.name !== sessionCookieName(f.c)),
          'a delayed anonymous response cannot erase a newer sign-in',
        );
        assert.equal(
          f.db.one('SELECT 1 FROM sessions WHERE token_hash=?', digest(cookie.value)),
          undefined,
        );
      } finally {
        await f.close();
      }
    });

test('session management rotates proof, preserves the absolute limit, and revokes other browsers', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const two = await f.login();
    const one = await f.login();
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(two.statusCode, 200, two.body);
    const header = (r: typeof one) => ({
      host: f.c.host,
      origin: f.c.appUrl,
      cookie:
        sessionCookieName(f.c) +
        '=' +
        r.cookies.find(({ name }) => name === sessionCookieName(f.c))!.value,
      'x-csrf-token': r.json().session.csrf,
    });
    const secondProof = await f.app.inject({
      method: 'POST',
      url: '/api/auth/step-up/password',
      headers: header(two),
      payload: { password },
    });
    assert.equal(secondProof.statusCode, 200, secondProof.body);
    const list = await f.app.inject({ url: '/api/auth/sessions', headers: header(one) });
    assert.equal(list.statusCode, 200, list.body);
    const sessions = list.json().sessions;
    assert.equal(sessions.length, 2);
    const current = sessions.find((row: { current: boolean }) => row.current);
    const other = sessions.find((row: { current: boolean }) => !row.current);
    assert.equal(typeof other.device, 'string');
    assert.doesNotMatch(JSON.stringify(sessions), /token_hash|csrf|proof_kind/);
    f.db.run('UPDATE sessions SET proof_at=? WHERE id=?', now() - 301, current.id);
    const denied = await f.app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/' + other.id,
      headers: header(one),
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const proof = await f.app.inject({
      method: 'POST',
      url: '/api/auth/step-up/password',
      headers: header(one),
      payload: { password },
    });
    assert.equal(proof.statusCode, 200, proof.body);
    assert.equal(
      f.db.one(
        'SELECT count FROM rate_limits WHERE key=?',
        digest('password-step-up:' + one.json().user.id),
      )?.count,
      2,
      'both signed-in browsers share the account password proof budget',
    );
    assert.notEqual(header(proof).cookie, header(one).cookie);
    assert.equal(proof.json().session.expires_at, one.json().session.expires_at);
    const revoked = await f.app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/' + other.id,
      headers: header(proof),
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: header(secondProof) })).json().user,
      null,
    );
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: header(one) })).json().user,
      null,
    );
    const result = await f.app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke-all',
      headers: header(proof),
      payload: {},
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().session.stage, 'anonymous');
    assert.equal(f.db.one('SELECT count(*) AS n FROM sessions WHERE user_id IS NOT NULL')!.n, 0);
  } finally {
    await f.close();
  }
});

test('a status-only browser read never allocates a grant', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  const read = (cookie?: string) =>
    f.app.inject({
      url: '/api/auth/me',
      headers: {
        host: f.c.host,
        'x-browser-session-probe': '1',
        ...(cookie && { cookie }),
      },
    });
  try {
    const probe = await read();
    assert.equal(probe.statusCode, 204);
    assert.equal(probe.headers['x-browser-bootstrap-required'], '1');
    assert.equal(probe.headers['set-cookie'], undefined);
    assert.equal(probe.body, '');
    assert.equal(f.db.one('SELECT count(*) AS count FROM sessions')!.count, 0);

    const browser = await browserBootstrap(f.app, f.c);
    const anonymous = await read(browser.cookie);
    assert.equal(anonymous.statusCode, 200);
    assert.equal(anonymous.headers['set-cookie'], undefined);
    assert.equal(anonymous.json().session.csrf, browser['x-csrf-token']);

    const signedIn = await f.login();
    const session = signedIn.cookies.find(({ name }) => name === sessionCookieName(f.c))!;
    const member = await read(session.name + '=' + session.value);
    assert.equal(member.statusCode, 200);
    assert.equal(member.headers['set-cookie'], undefined);
    assert.equal(member.json().user.username, 'operator');
  } finally {
    await f.close();
  }
});

test('registration requires bootstrap and unique email while display names can be shared', async () => {
  const f = await fixture();
  const register = (
    headers: Record<string, string>,
    email = 'Operator@Example.Test',
    displayName = 'Ope\u0301rateur 東京',
  ) =>
    f.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: { display_name: displayName, email, password },
    });
  try {
    assert.equal((await register({ host: f.c.host, origin: f.c.appUrl })).statusCode, 403);
    const firstBrowser = await browserBootstrap(f.app, f.c);
    const wrongFormat = await f.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...firstBrowser, 'content-type': 'text/plain' },
      payload: '{}',
    });
    assert.equal(wrongFormat.statusCode, 415);
    for (const name of ['\u202eTest', '\u200b', '\u3164']) {
      const invalid = await register(firstBrowser, 'invalid@example.test', name);
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    const first = await register(firstBrowser);
    const second = await register(await browserBootstrap(f.app, f.c), 'other@example.test');
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.match(first.json().user.username, /^Operateur-[0-9a-f]{16}$/);
    assert.notEqual(first.json().user.username, second.json().user.username);
    assert.equal(first.json().user.display_name, second.json().user.display_name);
    assert.equal(first.json().user.display_name, 'Opérateur 東京');
    assert.equal(first.json().user.role, 'member');
    assert.equal(first.json().user.email, 'operator@example.test');
    assert.equal(first.json().user.email_verified_at, null);
    assert.equal(first.json().user.email_verification_required, false);
    const duplicate = await register(await browserBootstrap(f.app, f.c), 'operator@EXAMPLE.TEST');
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(duplicate.json().code, 'email_unavailable');
    const signedIn = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: await browserBootstrap(f.app, f.c),
      payload: { username: 'OPERATOR@example.test', password },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(signedIn.json().user.username, first.json().user.username);
  } finally {
    await f.close();
  }
});

test('self-service email changes use fresh proof and retire old sessions and recovery', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none', ADMIN_EMAIL: 'Original@Example.Test' });
  try {
    const { app, db, c } = f;
    const jsonHeaders = (response: Awaited<ReturnType<typeof f.login>>) => {
      const signedIn = response.cookies.find(({ name }) => name === sessionCookieName(c))!;
      return {
        host: c.host,
        origin: c.appUrl,
        cookie: `${signedIn.name}=${signedIn.value}`,
        'x-csrf-token': response.json().session.csrf,
      };
    };
    const initiator = await f.login();
    const other = await f.login();
    const { id, username } = initiator.json().user;
    const verifiedAt = initiator.json().user.email_verified_at;
    assert.equal(verifiedAt, db.one('SELECT created_at FROM users WHERE id=?', id)!.created_at);
    issuePasswordReset(db, id);
    const change = (email: string, headers = jsonHeaders(initiator)) =>
      app.inject({ method: 'POST', url: '/api/auth/profile', headers, payload: { email } });
    const sameEmail = await change(' ORIGINAL@example.test ');
    assert.equal(sameEmail.statusCode, 200, sameEmail.body);
    assert.equal(sameEmail.json().user.email_verified_at, verifiedAt);
    assert.equal(sameEmail.headers['set-cookie'], undefined);
    assert.ok(db.one('SELECT 1 FROM password_resets WHERE user_id=?', id));

    const otherHeaders = jsonHeaders(other);
    db.run(
      'UPDATE sessions SET proof_at=? WHERE token_hash=?',
      now() - 301,
      digest(otherHeaders.cookie.split('=')[1]),
    );
    assert.equal((await change('blocked@example.test', otherHeaders)).statusCode, 403);
    assert.equal(
      (
        await change('blocked@example.test', {
          ...jsonHeaders(initiator),
          origin: 'https://other.test',
        })
      ).statusCode,
      403,
    );
    const changedEmail = await change('Replacement@Example.Test');
    assert.equal(changedEmail.statusCode, 200, changedEmail.body);
    assert.equal(changedEmail.json().user.username, username);
    assert.equal(changedEmail.json().user.email, 'replacement@example.test');
    assert.equal(changedEmail.json().user.email_verified_at, null);
    assert.equal(db.one('SELECT email_revision FROM users WHERE id=?', id)!.email_revision, 1);
    assert.equal(db.one('SELECT 1 FROM password_resets WHERE user_id=?', id), undefined);
    assert.equal((await change('blocked@example.test', otherHeaders)).statusCode, 403);
    const audit = db.one("SELECT target FROM audit WHERE action='account.email_changed'");
    assert.equal(audit?.target, id);

    const login = async (username: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: await browserBootstrap(app, c),
        payload: { username, password },
      });
    assert.equal((await login('original@example.test')).statusCode, 401);
    assert.equal((await login('replacement@example.test')).json().user.id, id);
  } finally {
    await f.close();
  }
});

test('startup validates primary access, relying-party binding and durable policy tightening', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none', STEAM_ENABLED: 'true' });
  const host = f.c.appUrl;
  const root = f.db.root;
  try {
    const startSteam = async () => {
      const started = await f.app.inject({
        method: 'POST',
        url: '/api/auth/steam',
        headers: await browserBootstrap(f.app, f.c),
        payload: {},
      });
      assert.equal(started.statusCode, 200, started.body);
      assert.ok(f.db.one('SELECT 1 FROM auth_states'));
    };
    for (const changedConfig of [
      { ...f.c, flags: { ...f.c.flags, steam_enabled: false } },
      { ...f.c, mfaRequiredRoles: ['admin'] as const },
    ]) {
      await startSteam();
      f.db.transaction(() => f.db.retireIneligibleSessions(changedConfig));
      f.db.transaction(() => f.db.retireIneligibleSessions(f.c));
      assert.equal(f.db.one('SELECT 1 FROM auth_states'), undefined);
    }
    const grant = await f.login();
    assert.equal(grant.json().session.stage, 'full');
    const id = grant.json().user.id;
    f.db.transaction(() => f.db.retireIneligibleSessions({ ...f.c, mfaRequiredRoles: ['admin'] }));
    f.db.transaction(() => f.db.retireIneligibleSessions(f.c));
    assert.equal(f.db.one('SELECT id FROM sessions WHERE user_id=?', id), undefined);
    f.db.run(
      "INSERT INTO auth_passkeys VALUES('example-key',?,'Fixture',X'01',0,'singleDevice',0,1,NULL)",
      id,
    );
    const other = loadConfig({ APP_URL: 'https://new.example', DATA_DIR: root });
    await assert.rejects(createApp(other, f.db), /relying party/);
    f.db.run('DELETE FROM auth_passkeys WHERE user_id=?', id);
    f.db.run('UPDATE users SET password_hash=NULL WHERE id=?', id);
    f.db.run("INSERT INTO identities VALUES('steam','76561198000000001',?)", id);
    const noSteam = loadConfig({
      APP_URL: host,
      COOKIE_SECURE: 'false',
      DATA_DIR: root,
      STEAM_ENABLED: 'false',
    });
    await assert.rejects(createApp(noSteam, f.db), /No administrator can sign in/);
  } finally {
    await f.close();
  }
});

test('a delayed anonymous bootstrap cannot replace the authenticated cookie or expose guest authority', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const first = await browserBootstrap(f.app, f.c);
    const guest = await f.app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: first,
      payload: {},
    });
    assert.equal(guest.statusCode, 201, guest.body);
    const guestCookie = guest.cookies[0].name + '=' + guest.cookies[0].value;
    const delayed = await browserBootstrap(f.app, f.c, guestCookie);
    const before = await f.app.inject({ url: '/api/auth/me', headers: delayed });
    assert.equal(before.json().guest_session.csrf, guest.json().csrf);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: first,
      payload: { username: 'operator', password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const authenticated = login.cookies.find((c) => c.name === sessionCookieName(f.c))!;
    const current = await f.app.inject({
      url: '/api/auth/me',
      headers: {
        host: f.c.host,
        cookie: authenticated.name + '=' + authenticated.value + '; ' + delayed.cookie,
      },
    });
    assert.equal(current.json().user.username, 'operator');
    assert.equal(current.json().session.csrf, login.json().session.csrf);
    assert.equal(current.json().guest_session, null);
  } finally {
    await f.close();
  }
});

test('additional primary sign-ins leave other pending browsers active through their TTL', async () => {
  const f = await fixture();
  try {
    const first = await f.login();
    const value = first.cookies.find((c) => c.name === sessionCookieName(f.c))!.value;
    for (let i = 0; i < 5; i++) assert.equal((await f.login()).statusCode, 200);
    const status = await f.app.inject({
      url: '/api/auth/me',
      headers: { host: f.c.host, cookie: sessionCookieName(f.c) + '=' + value },
    });
    assert.equal(status.json().session.stage, 'enroll');
    assert.equal(status.json().session.csrf, first.json().session.csrf);
  } finally {
    await f.close();
  }
});
test('logout can revoke a browser without publishing a replacement cookie', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const signedIn = await f.login();
    const raw = signedIn.cookies.find((c) => c.name === sessionCookieName(f.c))!.value;
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        host: f.c.host,
        origin: f.c.appUrl,
        cookie: sessionCookieName(f.c) + '=' + raw,
        'x-csrf-token': signedIn.json().session.csrf,
        'x-omit-anonymous-cookie': '1',
      },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().session.stage, 'anonymous');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(f.db.one('SELECT 1 FROM sessions WHERE token_hash=?', digest(raw)), undefined);
  } finally {
    await f.close();
  }
});

test('explicit anonymous logout retires the preceding bootstrap and its proof', async () => {
  const f = await fixture();
  try {
    const browser = await browserBootstrap(f.app, f.c);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: browser,
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().session.stage, 'anonymous');
    assert.notEqual(response.json().session.csrf, browser['x-csrf-token']);
    assert.ok(response.cookies.every((cookie) => cookie.name !== sessionCookieName(f.c)));
    const outdated = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: browser,
      payload: { username: 'operator', password },
    });
    assert.equal(outdated.statusCode, 403, outdated.body);
    assert.equal(outdated.headers['set-cookie'], undefined);
  } finally {
    await f.close();
  }
});

test('anonymous sign-out confirmation invalidates pending login proofs in the surviving grant', async () => {
  let revalidated = false;
  const f = await fixture({ STEAM_ENABLED: 'true' }, (app) =>
    app.addHook('preHandler', async (request) => {
      if (request.routeOptions.url !== '/api/auth/login') return;
      const live = currentSession(f.db, request, f.c);
      if (live?.stage !== 'anonymous') return;
      const transaction = f.db.transaction.bind(f.db);
      let admitted = false;
      f.db.transaction = (fn) => {
        if (admitted) {
          f.db.transaction = transaction;
          revalidated = true;
          transaction(() => confirmAnonymousSignOut(f.db, f.c, live));
        }
        admitted = true;
        return transaction(fn);
      };
    }),
  );
  try {
    const browser = await browserBootstrap(f.app, f.c);
    const start = (path: string) =>
      f.app.inject({ method: 'POST', url: '/api/auth/' + path, headers: browser, payload: {} });
    assert.equal((await start('passkeys/login/options')).statusCode, 200);
    assert.equal((await start('steam')).statusCode, 200);
    assert.ok(f.db.one('SELECT 1 FROM auth_passkey_challenges'));
    assert.ok(f.db.one('SELECT 1 FROM auth_states'));

    const response = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: browser,
      payload: { username: 'operator', password },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.ok(revalidated);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(f.db.one('SELECT 1 FROM auth_passkey_challenges'), undefined);
    assert.equal(f.db.one('SELECT 1 FROM auth_states'), undefined);
    assert.equal(f.db.one("SELECT 1 FROM sessions WHERE stage<>'anonymous'"), undefined);
    const current = await f.app.inject({ url: '/api/auth/me', headers: browser });
    assert.equal(current.json().session.stage, 'anonymous');
    assert.notEqual(current.json().session.csrf, browser['x-csrf-token']);
  } finally {
    await f.close();
  }
});

for (const action of ['sign in', 'sign out'] as const)
  test(`a delayed account response cannot restore access after a later ${action} in the same browser`, async () => {
    const f = await fixture({ MFA_REQUIRED_ROLES: 'none', PUBLIC_ACCESS: 'false' });
    try {
      f.db.run(
        `INSERT INTO users(id,username,password_hash,created_at)
         SELECT 'other-member','other_member',password_hash,created_at FROM users WHERE username='operator'`,
      );
      const browser = await browserBootstrap(f.app, f.c);
      const jar = new Map(
        browser.cookie.split('; ').map((pair) => pair.split('=') as [string, string]),
      );
      function apply(response: Awaited<ReturnType<typeof f.login>>) {
        for (const { name, value } of response.cookies) jar.set(name, value);
      }
      let csrf = browser['x-csrf-token'];
      const headers = () => ({
        host: f.c.host,
        origin: f.c.appUrl,
        cookie: [...jar].map(([name, value]) => name + '=' + value).join('; '),
        'x-csrf-token': csrf,
      });
      const first = await f.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: headers(),
        payload: { username: 'operator', password },
      });
      assert.equal(first.statusCode, 200, first.body);
      apply(first);
      csrf = first.json().session.csrf;
      const delayed = await f.app.inject({
        method: 'POST',
        url: '/api/auth/step-up/password',
        headers: headers(),
        payload: { password },
      });
      assert.equal(delayed.statusCode, 200, delayed.body);
      const lateCookie = delayed.cookies.find(({ name }) => name === sessionCookieName(f.c))!;
      const lateHash = digest(lateCookie.value);
      assert.ok(f.db.one('SELECT 1 FROM sessions WHERE token_hash=?', lateHash));
      const otherBrowser = await f.login();
      assert.equal(otherBrowser.statusCode, 200, otherBrowser.body);

      // The other tab sends the cookie jar before the step-up response arrives.
      const originalBinding = jar.get(browserBindingCookieName(f.c));
      const fallback = await f.app.inject({ url: '/api/auth/me', headers: headers() });
      assert.equal(fallback.json().session.stage, 'anonymous');
      assert.equal(
        fallback.cookies.find(({ name }) => name === browserBindingCookieName(f.c))?.value,
        originalBinding,
      );
      assert.ok(f.db.one('SELECT 1 FROM sessions WHERE token_hash=?', lateHash));
      apply(fallback);
      csrf = fallback.json().session.csrf;
      const next = await f.app.inject({
        method: 'POST',
        url: action === 'sign in' ? '/api/auth/login' : '/api/auth/logout',
        headers: headers(),
        payload:
          action === 'sign in'
            ? { username: 'other_member', password }
            : { preserve_anonymous_operations: true },
      });
      assert.equal(next.statusCode, 200, next.body);
      apply(next);
      const latest = await f.app.inject({ url: '/api/auth/me', headers: headers() });
      assert.equal(
        latest.json().user?.username ?? null,
        action === 'sign in' ? 'other_member' : null,
      );

      // Now let the older account response overwrite the shared account cookie.
      apply(delayed);
      assert.equal(f.db.one('SELECT 1 FROM sessions WHERE token_hash=?', lateHash), undefined);
      const rejected = await f.app.inject({ url: '/api/auth/me', headers: headers() });
      assert.equal(rejected.json().user, null);
      assert.equal(rejected.json().session.stage, 'anonymous');
      assert.equal(
        (await f.app.inject({ url: '/api/auth/sessions', headers: headers() })).statusCode,
        401,
      );

      const independent = otherBrowser.cookies.find(({ name }) => name === sessionCookieName(f.c))!;
      const current = await f.app.inject({
        url: '/api/auth/me',
        headers: { host: f.c.host, cookie: independent.name + '=' + independent.value },
      });
      assert.equal(current.json().user.username, 'operator');
    } finally {
      await f.close();
    }
  });

test('a chosen browser binding cannot revoke sessions in a different browser', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const target = await browserBootstrap(f.app, f.c);
    const member = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: target,
      payload: { username: 'operator', password },
    });
    assert.equal(member.statusCode, 200, member.body);
    const bindingName = browserBindingCookieName(f.c);
    const binding = target.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith(bindingName + '='))!;
    const chosenValue = bindingName + '=' + digest(binding.split('=')[1]);
    const chosen = await browserBootstrap(f.app, f.c, chosenValue);
    assert.ok(!chosen.cookie.split('; ').includes(chosenValue));
    // The live anonymous session also wins over a conflicting cookie in a
    // mutation, even if that cookie was actually issued to a different browser.
    const unrelated = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        ...chosen,
        cookie: chosen.cookie
          .split('; ')
          .filter((cookie) => !cookie.startsWith(bindingName + '='))
          .concat(binding)
          .join('; '),
      },
      payload: { username: 'operator', password },
    });
    assert.equal(unrelated.statusCode, 200, unrelated.body);
    const original = member.cookies.find(({ name }) => name === sessionCookieName(f.c))!;
    const status = await f.app.inject({
      url: '/api/auth/me',
      headers: { host: f.c.host, cookie: original.name + '=' + original.value },
    });
    assert.equal(status.json().session.csrf, member.json().session.csrf);
  } finally {
    await f.close();
  }
});

test('logout rechecks the initiating grant after acquiring its write lock', async () => {
  const f = await fixture();
  try {
    const signedIn = await f.login();
    const cookie = signedIn.cookies.find(({ name }) => name === sessionCookieName(f.c))!;
    const transaction = f.db.transaction.bind(f.db);
    f.db.transaction = (fn) => {
      f.db.transaction = transaction;
      f.db.run('DELETE FROM sessions WHERE token_hash=?', digest(cookie.value));
      return transaction(fn);
    };
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        host: f.c.host,
        origin: f.c.appUrl,
        cookie: cookie.name + '=' + cookie.value,
        'x-csrf-token': signedIn.json().session.csrf,
      },
      payload: {},
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(f.db.one("SELECT 1 FROM audit WHERE action='session.signed_out'"), undefined);
  } finally {
    await f.close();
  }
});

test('a read bound to a previous tab session never returns data for the active session', async () => {
  const f = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const previous = await f.login(),
      active = await f.login();
    const cookie = active.cookies.find((c) => c.name === sessionCookieName(f.c))!;
    const headers = { host: f.c.host, cookie: cookie.name + '=' + cookie.value };
    for (const url of [
      '/api/auth/sessions',
      '/api/auth/security',
      '/api/config',
      '/api/admin/users',
      '/api/demos?scope=mine',
    ]) {
      const read = await f.app.inject({
        url,
        headers: { ...headers, 'x-session-context': previous.json().session.csrf },
      });
      assert.equal(read.statusCode, 409, url);
      assert.equal(read.headers['x-session-changed'], '1');
      assert.equal(
        (
          await f.app.inject({
            url,
            headers: { ...headers, 'x-session-context': active.json().session.csrf },
          })
        ).statusCode,
        200,
        url,
      );
    }
  } finally {
    await f.close();
  }
});

test('account audit and session origin use the direct socket, and leave incomplete forwarding unknown', async (t) => {
  for (const [name, headers, auditAddress, sessionNetwork] of [
    ['direct connection', {}, '127.0.0.1', '127.0.0.0/24'],
    ['incomplete forwarding', { 'x-forwarded-proto': 'https' }, null, null],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture({ MFA_REQUIRED_ROLES: 'none', TRUSTED_PROXY_IPS: '127.0.0.1' });
      try {
        const entered = await f.login('', headers);
        assert.equal(entered.statusCode, 200, entered.body);
        const user = entered.json().user.id;
        assert.equal(
          f.db.one("SELECT address FROM audit WHERE action='password.sign_in' AND target=?", user)!
            .address,
          auditAddress,
        );
        assert.equal(
          f.db.one('SELECT address FROM sessions WHERE user_id=?', user)!.address,
          sessionNetwork,
        );
      } finally {
        await f.close();
      }
    });
  }
});
