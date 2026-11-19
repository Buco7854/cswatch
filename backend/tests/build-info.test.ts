import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseBuildInfo } from '../src/build-info.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';

test('build identity accepts only a complete source revision and canonical UTC timestamp', () => {
  const value = { revision: 'a'.repeat(40), builtAt: '2026-11-19T02:00:00.000Z' };
  assert.deepEqual(parseBuildInfo(value), value);
  assert.deepEqual(parseBuildInfo({ revision: null, builtAt: null }), {
    revision: null,
    builtAt: null,
  });
  for (const invalid of [
    null,
    { ...value, revision: 'not-a-source-commit' },
    { ...value, builtAt: '2026-02-31T00:00:00Z' },
    { ...value, builtAt: 'private-runtime-data' },
    { ...value, secret: 'must-not-be-published' },
  ])
    assert.deepEqual(parseBuildInfo(invalid), { revision: null, builtAt: null });
});

test('build stage writes explicit provenance and never infers revision from runtime credentials', async () => {
  const { createBuildInfo, writeBuildInfo } = await import(
    new URL('../scripts/build-info.mjs', import.meta.url).href
  );
  assert.deepEqual(
    createBuildInfo(
      { ADMIN_PASSWORD: 'private-fixture-not-a-revision' },
      new Date('2026-11-19T00:00:00Z'),
    ),
    { revision: null, builtAt: '2026-11-19T00:00:00.000Z' },
  );
  for (const env of [
    { CSWATCH_REVISION: 'secret-not-a-commit' },
    { CSWATCH_BUILD_TIMESTAMP: '2026-02-31T00:00:00Z' },
  ])
    assert.throws(() => createBuildInfo(env));
  const root = await mkdtemp(join(tmpdir(), 'cswatch-build-identity-'));
  try {
    const output = join(root, 'build-info.json');
    writeBuildInfo(output, {
      CSWATCH_REVISION: 'b'.repeat(40),
      CSWATCH_BUILD_TIMESTAMP: '2026-11-19T02:00:00Z',
    });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
      revision: 'b'.repeat(40),
      builtAt: '2026-11-19T02:00:00.000Z',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public instance configuration exposes bounded immutable build identity without caching policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-build-config-'));
  const db = new Store(root),
    app = await createApp(
      loadConfig({ APP_URL: 'http://localhost:8000', COOKIE_SECURE: 'false', DATA_DIR: root }),
      db,
    );
  try {
    const response = await app.inject({ url: '/api/config', headers: { host: 'localhost:8000' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const value = response.json().build;
    assert.deepEqual(Object.keys(value).sort(), ['builtAt', 'revision']);
    assert.deepEqual(parseBuildInfo(value), value);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
