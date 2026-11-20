import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { COOKIE } from '../src/security.js';
import { createApp } from '../src/server.js';
import { initializeFixture } from './fixtures/initialized.js';

test('FACEIT verification, history and download lookup use current verified identity and fixed APIs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-providers-'));
  const origin = 'http://localhost:8000';
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    FACEIT_ENABLED: 'true',
    FACEIT_API_KEY: 'fixture-faceit-key',
    FACEIT_DOWNLOAD_TOKEN: 'fixture-faceit-download-token',
    LOG_LEVEL: 'silent',
  });
  const db = new Store(root);
  initializeFixture(db);
  const app = await createApp(config, db);
  const fetchBefore = globalThis.fetch;
  try {
    const headers = { host: 'localhost:8000', origin };
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: { username: 'provider_fixture', password: 'disposable-fixture-password' },
    });
    assert.equal(registered.statusCode, 201);
    const { id, csrf } = registered.json().user;
    const authenticated = {
      ...headers,
      cookie: `${COOKIE}=${registered.cookies.find((cookie) => cookie.name === COOKIE)!.value}`,
      'x-csrf-token': csrf,
    };
    const steam = '76561198000000001',
      faceit = 'd999aa66-f0df-41ba-857f-50de9f9b7af6',
      match = '1-d999aa66-f0df-41ba-857f-50de9f9b7af8';
    db.run("INSERT INTO identities VALUES('steam',?,?)", steam, id);
    const requests: string[] = [];
    let malformed = false,
      revoke = false;
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://open.faceit.com');
      assert.deepEqual(options?.headers, { Authorization: 'Bearer fixture-faceit-key' });
      assert.equal(options?.redirect, 'error');
      requests.push(url.pathname);
      if (url.pathname === '/data/v4/players') {
        assert.equal(url.searchParams.get('game_player_id'), steam);
        assert.equal(url.searchParams.get('game'), 'cs2');
        if (malformed) return new Response('invalid JSON');
        if (revoke) db.run('DELETE FROM sessions WHERE user_id=?', id);
        return Response.json({
          player_id: faceit,
          nickname: 'Fixture player',
          games: { cs2: { game_player_id: steam } },
        });
      }
      if (url.pathname === `/data/v4/players/${faceit}/history`) {
        assert.equal(url.searchParams.get('game'), 'cs2');
        return Response.json({ items: [{ match_id: match }] });
      }
      assert.equal(url.pathname, `/data/v4/matches/${match}`);
      return Response.json({ demo_url: [] });
    };
    const link = () =>
      app.inject({ method: 'POST', url: '/api/connections/faceit/link', headers: authenticated });
    assert.equal((await link()).statusCode, 200);
    const history = await app.inject({
      url: '/api/connections/faceit/matches',
      headers: authenticated,
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.json(), { items: [{ match_id: match }] });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/connections/faceit/import',
      headers: authenticated,
      payload: { match_id: match },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(db.one('SELECT id FROM demos'), undefined);
    malformed = true;
    assert.equal((await link()).statusCode, 502);
    malformed = false;
    revoke = true;
    db.run("DELETE FROM identities WHERE user_id=? AND provider='faceit'", id);
    assert.equal((await link()).statusCode, 401);
    assert.equal(db.one("SELECT subject FROM identities WHERE provider='faceit'"), undefined);
    assert.equal(requests.length, 5);
  } finally {
    globalThis.fetch = fetchBefore;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
