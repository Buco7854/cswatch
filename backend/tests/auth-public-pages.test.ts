import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';

test('private instances serve direct authentication pages and the exact provider notice without exposing private APIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-private-pages-'));
  const frontend = join(root, 'frontend');
  await mkdir(join(frontend, 'licenses'), { recursive: true });
  await mkdir(join(frontend, 'assets'));
  await writeFile(
    join(frontend, 'index.html'),
    '<!doctype html><title>Original authentication test shell</title>',
  );
  await writeFile(join(frontend, 'assets/fixture.js'), 'void 0;');
  const appScript = 'console.log("static fixture");';
  await writeFile(join(frontend, 'assets/index-a1b2c3d4.js'), appScript);
  await writeFile(join(frontend, 'assets/index-a1b2c3d4.js.gz'), gzipSync(appScript));
  const notice = 'Original test provider attribution notice, not provider artwork.';
  await writeFile(join(frontend, 'licenses/provider-brands.txt'), notice);
  const db = new Store(join(root, 'data'));
  const app = await createApp(
    loadConfig({
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      DATA_DIR: join(root, 'data'),
      FRONTEND_DIR: frontend,
      PUBLIC_ACCESS: 'false',
      ADMIN_USERNAME: 'page_fixture_admin',
      ADMIN_PASSWORD: 'Synthetic-private-page-password',
    }),
    db,
  );
  const headers = { host: 'localhost:8000', origin: 'http://localhost:8000' };
  const readMethods = ['GET', 'HEAD'] as const;
  const denied = [
    '/recover//',
    '/recover%2F',
    '/%72ecover/',
    '/account/sessions//',
    '/account/sessions%2f',
    '/watch/fixture_demo//',
    '/unlisted/',
    '/licenses/other.txt',
    '/licenses/provider-brands.txt/',
    '/api/demos',
    '/api/auth/sessions',
    '/api/auth/sessions/',
    '/api/admin',
  ];
  try {
    const expectShell = async (url: string, cookie = '') => {
      for (const method of readMethods) {
        const response = await app.inject({ url, method, headers: { ...headers, cookie } });
        assert.equal(response.statusCode, 200, `${method} ${url}`);
        assert.match(String(response.headers['content-type']), /^text\/html/, url);
      }
    };
    for (const url of [
      '/login?returnTo=%2Fadmin',
      '/register',
      '/recover',
      '/recover/?source=fixture',
      '/account/sessions/',
      '/account/connections/',
      '/watch/fixture_demo-1/',
    ])
      await expectShell(url);

    const admin = db.one('SELECT id FROM users WHERE username=?', 'page_fixture_admin')!;
    for (const stage of ['challenge', 'enroll'] as const) {
      const label = `page-${stage}`;
      insertFixtureSession(db, label, admin.id, `${label}-csrf`, now() + 300);
      db.run('UPDATE sessions SET stage=? WHERE csrf=?', stage, `${label}-csrf`);
      const cookie = fixtureCookie(label);
      for (const url of ['/recover', '/recover/?source=fixture', '/account/'])
        await expectShell(url, cookie);
      for (const method of readMethods) {
        const url = '/account/sessions/?source=fixture';
        const response = await app.inject({ url, method, headers: { ...headers, cookie } });
        assert.equal(response.statusCode, 303);
        const location = new URL(String(response.headers.location), 'http://localhost:8000');
        assert.equal(location.pathname, stage === 'enroll' ? '/account' : '/login');
        assert.equal(location.searchParams.get('returnTo'), url);
      }
    }

    for (const cookie of ['', fixtureCookie('page-challenge'), fixtureCookie('page-enroll')]) {
      const get = (url: string) => app.inject({ url, headers: { ...headers, cookie } });
      const response = await get('/licenses/provider-brands.txt');
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type']), /^text\/plain/);
      assert.equal(response.body, notice);
      assert.equal((await get('/assets/fixture.js')).body, 'void 0;');
      const script = await get('/assets/index-a1b2c3d4.js');
      assert.equal(script.body, appScript);
      assert.match(String(script.headers['cache-control']), /immutable/);
      assert.match(String(script.headers.vary), /accept-encoding/i);
      const compressed = await app.inject({
        url: '/assets/index-a1b2c3d4.js',
        headers: { ...headers, cookie, 'accept-encoding': 'gzip' },
      });
      assert.equal(compressed.headers['content-encoding'], 'gzip');
      assert.match(String(compressed.headers['content-type']), /javascript/);
      assert.deepEqual(compressed.rawPayload, gzipSync(appScript));
      assert.equal((await get('/assets/missing.js')).headers['cache-control'], 'no-store');
      assert.equal((await get('/assets/missing.js')).statusCode, 404);
      for (const url of denied) assert.equal((await get(url)).statusCode, cookie ? 403 : 401, url);
      assert.equal(
        (await app.inject({ url: '/recover/', method: 'POST', headers: { ...headers, cookie } }))
          .statusCode,
        cookie ? 403 : 401,
      );
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
