import { initializeFixture } from './fixtures/initialized.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../src/server.js';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { digest, COOKIE } from '../src/security.js';
import { writeReplay } from '../src/replay.js';
import { sample } from '../../frontend/src/sample.js';

test('library search spans pages, treats wildcards literally, and respects ownership and sharing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-library-'));
  const db = new Store(dir);
  initializeFixture(db);
  const app = await createApp(
    loadConfig({ APP_URL: 'http://localhost:8000', COOKIE_SECURE: 'false', DATA_DIR: dir }),
    db,
  );
  const headers = { host: 'localhost:8000', cookie: `${COOKIE}=library-test-session` };
  try {
    for (const id of ['owner', 'other'])
      db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, id, null, 0, now());
    db.run(
      'INSERT INTO sessions VALUES(?,?,?,?)',
      digest('library-test-session'),
      'owner',
      'csrf',
      now() + 60,
    );
    for (let i = 0; i < 105; i++)
      db.run(
        'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,public,map) VALUES(?,?,?,?,?,?,?,?,?)',
        `demo-${i}`,
        'owner',
        i === 104 ? 'literal_100% final.dem' : `review ${i}.dem`,
        'upload',
        'ready',
        10,
        now() - i,
        0,
        'de_mirage',
      );
    db.run(
      'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,public) VALUES(?,?,?,?,?,?,?,?)',
      'hidden',
      'other',
      'literal_100% private.dem',
      'upload',
      'ready',
      10,
      now(),
      0,
    );
    db.run(
      'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,public) VALUES(?,?,?,?,?,?,?,?)',
      'shared',
      'other',
      'publicfinal.dem',
      'upload',
      'ready',
      10,
      now(),
      1,
    );
    const get = (url: string, authenticated = true) =>
      app.inject({ method: 'GET', url, headers: authenticated ? headers : { host: headers.host } });
    const first = await get('/api/demos');
    assert.equal(first.json().demos.length, 50);
    assert.equal(first.json().total, 105);
    const last = await get('/api/demos?offset=100');
    assert.equal(last.json().demos.length, 5);
    const search = await get('/api/demos?q=' + encodeURIComponent('literal_100%'));
    assert.equal(search.json().total, 1);
    assert.equal(search.json().demos[0].id, 'demo-104');
    const injection = await get('/api/demos?q=' + encodeURIComponent("' OR 1=1 --"));
    assert.equal(injection.json().total, 0);
    const publicList = await get('/api/demos?scope=public&q=final', false);
    assert.equal(publicList.statusCode, 400);
    assert.equal((await get('/api/demos/shared', false)).statusCode, 200);
    assert.equal((await get('/api/demos', false)).statusCode, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every replay slice enforces demo access, readiness, strict indices and private instance policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-slices-'));
  const db = new Store(dir);
  initializeFixture(db);
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: dir,
  });
  const app = await createApp(config, db);
  const headers = { host: 'localhost:8000', cookie: `${COOKIE}=slice-test-session` };
  try {
    db.run('INSERT INTO users VALUES(?,?,?,?,?)', 'owner', 'owner', null, 0, now());
    db.run(
      'INSERT INTO sessions VALUES(?,?,?,?)',
      digest('slice-test-session'),
      'owner',
      'csrf',
      now() + 60,
    );
    db.run(
      'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,public) VALUES(?,?,?,?,?,?,?,?)',
      'demo',
      'owner',
      'match.dem',
      'upload',
      'ready',
      10,
      now(),
      0,
    );
    const folder = join(dir, 'demos', 'demo');
    mkdirSync(folder);
    await writeReplay(folder, sample);
    const get = (suffix: string, authenticated = true) =>
      app.inject({
        method: 'GET',
        url: '/api/demos/demo/playback' + suffix,
        headers: authenticated ? headers : { host: headers.host },
      });
    assert.equal((await get('/chunks/0', false)).statusCode, 404);
    const manifest = await get('');
    assert.equal(JSON.parse(gunzipSync(manifest.rawPayload).toString()).version, 2);
    assert.equal((await get('/chunks/0')).statusCode, 200);
    for (const invalid of ['00', '-1', '512', 'NaN', '0.json.gz', '%2e%2e'])
      assert.equal((await get('/chunks/' + invalid)).statusCode, 404);
    db.run('UPDATE demos SET public=1 WHERE id=?', 'demo');
    assert.equal((await get('/chunks/0', false)).statusCode, 200);
    db.run("UPDATE demos SET status='processing' WHERE id=?", 'demo');
    assert.equal((await get('/chunks/0')).statusCode, 409);
    db.run('INSERT INTO settings VALUES(?,?)', 'public_access', 0);
    assert.equal((await get('/chunks/0', false)).statusCode, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
