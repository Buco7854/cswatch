import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

test('private instances serve direct authentication pages and the exact provider notice without exposing private APIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-private-pages-'));
  const frontend = join(root, 'frontend');
  await mkdir(join(frontend, 'licenses'), { recursive: true });
  await writeFile(
    join(frontend, 'index.html'),
    '<!doctype html><title>Original authentication test shell</title>',
  );
  const notice = 'Original test provider attribution notice, not provider artwork.';
  await writeFile(join(frontend, 'licenses/provider-brands.txt'), notice);
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
  );
  const headers = { host: 'localhost:8000', origin: 'http://localhost:8000' };
  try {
    for (const url of ['/login?returnTo=%2Fadmin', '/register'])
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await app.inject({ url, method, headers });
        assert.equal(response.statusCode, 200);
        assert.match(String(response.headers['content-type']), /^text\/html/);
      }
    const response = await app.inject({ url: '/licenses/provider-brands.txt', headers });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/plain/);
    assert.equal(response.body, notice);
    for (const url of ['/licenses/other.txt', '/api/demos', '/api/admin'])
      assert.equal((await app.inject({ url, headers })).statusCode, 401);
    assert.equal((await app.inject({ url: '/login', method: 'POST', headers })).statusCode, 401);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
