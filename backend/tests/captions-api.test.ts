import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';
import { initializeFixture } from './fixtures/initialized.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createApp } from '../src/server.js';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';

test('captions and retries enforce demo access, owner mutation, Origin/CSRF, status and safe artifact paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-caption-api-'));
  const db = new Store(dir);
  initializeFixture(db);
  const origin = 'http://localhost:8000';
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: dir,
    TRANSCRIPTION_ENABLED: 'true',
    TRANSCRIPTION_MODEL_DIR: join(dir, 'models'),
  });
  for (const id of ['owner', 'other']) {
    db.run(
      'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
      id,
      id,
      null,
      'member',
      now(),
    );
    insertFixtureSession(db, 'caption-session-' + id, id, 'csrf-' + id, now() + 120);
  }
  db.run(
    'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,metadata,transcription_status) VALUES(?,?,?,?,?,?,?,?,?)',
    'demo',
    'owner',
    'match.dem',
    'upload',
    'ready',
    10,
    now(),
    JSON.stringify({ replayVersion: 3, communications: { voice: 'available' } }),
    'failed',
  );
  const app = await createApp(config, db);
  const headers = (id?: string) => ({
    host: 'localhost:8000',
    ...(id ? { cookie: fixtureCookie(`caption-session-${id}`) } : {}),
  });
  const get = (id?: string) =>
    app.inject({ method: 'GET', url: '/api/demos/demo/captions', headers: headers(id) });
  const retry = (id?: string, valid = true) =>
    app.inject({
      method: 'POST',
      url: '/api/demos/demo/captions/retry',
      headers: { ...headers(id), origin, ...(valid ? { 'x-csrf-token': 'csrf-' + id } : {}) },
      payload: {},
    });
  try {
    assert.equal((await get()).statusCode, 404);
    assert.equal((await get('other')).statusCode, 404);
    assert.equal((await get('owner')).json().status, 'failed');
    assert.equal((await retry('owner', false)).statusCode, 403);
    db.run('UPDATE demos SET public=1 WHERE id=?', 'demo');
    assert.equal((await get()).statusCode, 200);
    assert.equal((await retry('other')).statusCode, 404);
    assert.equal((await retry('owner')).statusCode, 202);
    assert.equal(
      db.one('SELECT transcription_status FROM demos WHERE id=?', 'demo')?.transcription_status,
      'queued',
    );
    const folder = join(dir, 'demos', 'demo');
    mkdirSync(folder);
    const filename = 'captions-' + 'a'.repeat(32) + '.json.gz';
    writeFileSync(
      join(folder, filename),
      gzipSync(
        JSON.stringify({
          status: 'partial',
          cues: [
            {
              id: 'test',
              speaker: null,
              startTick: 1.25,
              endTick: 100.75,
              text: 'Explicit fixture caption',
              source: 'local-transcription',
            },
          ],
        }),
      ),
    );
    db.run(
      "UPDATE demos SET transcription_status='ready',transcription_artifact=? WHERE id=?",
      filename,
      'demo',
    );
    const captions = await get();
    assert.equal(captions.statusCode, 200);
    assert.equal(JSON.parse(gunzipSync(captions.rawPayload).toString()).cues[0].startTick, 1.25);
    db.run('UPDATE demos SET transcription_artifact=? WHERE id=?', '../../replay.db', 'demo');
    assert.equal((await get('owner')).statusCode, 503);
    db.run('INSERT INTO settings VALUES(?,?)', 'public_access', 0);
    assert.equal((await get()).statusCode, 401);
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/demos/demo/captions/retry',
      headers: { ...headers('owner'), 'x-csrf-token': 'csrf-owner' },
      payload: {},
    });
    assert.equal(noOrigin.statusCode, 403);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
