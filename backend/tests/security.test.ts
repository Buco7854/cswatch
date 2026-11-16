import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
    assert.equal(s.db.one('SELECT count(*) AS n FROM users')!.n, 0);
  } finally {
    await s.close();
  }
});
