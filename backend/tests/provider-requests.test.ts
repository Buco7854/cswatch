import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { HttpError } from '../src/errors.js';
import { requestProvider, readUpstreamJson } from '../src/upstream.js';
import { ProviderRequests } from '../src/provider-requests.js';
import {
  prepareSteamImports,
  queueSteamMatches,
  setSteamAutoImport,
  SteamAutoImporter,
} from '../src/steam-auto-import.js';

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'provider-admission-'));
  const db = new Store(root);
  const c = loadConfig({
    APP_URL: 'https://example.test',
    STEAM_API_KEY: 'fixture-key',
    STEAM_ENABLED: 'true',
    STEAM_COORDINATOR_ENABLED: 'true',
    STEAM_COORDINATOR_USERNAME: 'fixture',
    STEAM_COORDINATOR_PASSWORD: 'fixture',
    STEAM_REQUESTS_PER_MINUTE: '3',
    STEAM_MAX_CONCURRENT: '2',
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, c };
}

test('all members share provider request budgets and download slots for the full stream', async (t) => {
  const { db, c } = fixture(t);
  const requests = new ProviderRequests(db, c.providerLimits);
  const wait = Promise.withResolvers<void>();
  const file = requests.run('steamFiles', () => wait.promise);
  let entries = 0;
  const enter = async () => {
    entries++;
  };
  await assert.rejects(requests.run('steamFiles', enter), { statusCode: 429 });
  const history = requests.run('steamHistory', () => wait.promise);
  await assert.rejects(requests.run('steamOpenId', enter), { statusCode: 429 });
  await requests.run('faceitData', enter);
  wait.resolve();
  await Promise.all([history, file]);
  await requests.run('steamFiles', enter);
  await assert.rejects(requests.run('steamProfile', enter), { statusCode: 429 });
  assert.equal(entries, 2);
  const stamp = Date.now();
  t.mock.method(Date, 'now', () => stamp + 61000);
  await requests.run('steamHistory', enter);
  assert.equal(entries, 3);
});

test('service cooldowns survive restart, preserve longer retry dates and grow on repeated outages', async (t) => {
  const { db, c } = fixture(t);
  let time = Date.UTC(2025, 1, 1);
  t.mock.method(Date, 'now', () => time);
  const r = new ProviderRequests(db, c.providerLimits);
  const later = new Date(time + 180000).toUTCString();
  await r.run('faceitStats', async (report) => {
    report(503, later);
    report(429, '2');
  });
  await assert.rejects(
    new ProviderRequests(db, c.providerLimits).run('faceitStats', async () => assert.fail()),
    { statusCode: 429, retryAfter: 180 },
  );
  await r.run('faceitData', async (report) => report(200));
  await r.run('steamGc', async (report) => report(503));
  assert.equal(r.retryAt('steamGc'), now() + c.providerLimits.coordinator.backoff);
  time += 120000;
  await r.run('steamGc', async (report) => report(503, 'bad date'));
  assert.equal(r.retryAt('steamGc'), now() + 240);
  time += 240000;
  await r.run('steamGc', async (report) => report(200));
  await r.run('steamGc', async (report) => report(503));
  assert.equal(r.retryAt('steamGc'), now() + 120);
});

function queueFixture(t: import('node:test').TestContext) {
  const { db, c } = fixture(t);
  prepareSteamImports(db);
  const user = 'private-fixture';
  const subject = '76561198000000001';
  db.run('INSERT INTO users(id,username,created_at) VALUES(?,?,?)', user, user, now());
  db.run("INSERT INTO identities VALUES('steam',?,?)", subject, user);
  db.run(
    'INSERT INTO steam_history VALUES(?,?,?,?,?,0)',
    user,
    subject,
    Buffer.alloc(10),
    'cursor',
    'generation1',
  );
  return { db, c, user, subject };
}

test('opt-in jobs deduplicate, honor backoff, prioritize recent matches and retire with the grant', async (t) => {
  const { db, c, user, subject } = queueFixture(t);
  for (const id of ['1', '2', '3']) {
    db.run('INSERT INTO steam_matches(user_id,match_id,code) VALUES(?,?,?)', user, id, 'code' + id);
    queueSteamMatches(db, user, id);
  }
  assert.equal(db.all('SELECT * FROM steam_auto_jobs').length, 0);
  setSteamAutoImport(db, user, subject, 'generation1', true);
  const attempts: string[] = [];
  const syncs: string[] = [];
  const bg = new SteamAutoImporter(
    db,
    c,
    async (id) => syncs.push(id),
    async (id, match, grant) => {
      assert.equal(id, user);
      assert.ok(grant.grantId);
      attempts.push(match);
      if (match === '3') throw new HttpError(429, 'busy', 600);
      return { id: 'demo' };
    },
  );
  await Promise.all([bg.tick(), bg.tick()]);
  assert.deepEqual(syncs, [user]);
  await bg.tick();
  await bg.tick();
  assert.deepEqual(attempts, ['3', '2']);
  assert.ok(
    db.one("SELECT retry_at FROM steam_auto_jobs WHERE match_id='3'")!.retry_at >= now() + 599,
  );
  const original = db.one('SELECT grant_id FROM steam_auto_imports')!.grant_id;
  setSteamAutoImport(db, user, subject, 'generation1', true);
  assert.equal(db.one('SELECT grant_id FROM steam_auto_imports')!.grant_id, original);
  setSteamAutoImport(db, user, subject, 'generation1', false);
  assert.equal(db.all('SELECT * FROM steam_auto_jobs').length, 0);
  await bg.tick();
  assert.equal(attempts.length, 2);
  setSteamAutoImport(db, user, subject, 'generation1', true);
  assert.notEqual(db.one('SELECT grant_id FROM steam_auto_imports')!.grant_id, original);
  db.run('DELETE FROM steam_history WHERE user_id=?', user);
  assert.equal(db.all('SELECT * FROM steam_auto_jobs').length, 0);
  await bg.close();
});

test('receiving successful headers before a broken body preserves the provider failure streak', async (t) => {
  const { db, c } = fixture(t);
  const r = new ProviderRequests(db, c.providerLimits);
  let time = Date.UTC(2025, 1, 1);
  t.mock.method(Date, 'now', () => time);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('socket closed'));
          },
        }),
      ),
  );
  const read = () =>
    requestProvider(
      r,
      'faceitData',
      'https://open.faceit.com/',
      {},
      'unavailable',
      readUpstreamJson,
    );
  await assert.rejects(read(), { statusCode: 502, retryAfter: 30 });
  time += 30000;
  await assert.rejects(read(), { statusCode: 502, retryAfter: 60 });
});

test('a foreground upload in progress keeps the automatic job until a file is committed', async (t) => {
  const { db, c, user, subject } = queueFixture(t);
  db.run("INSERT INTO steam_matches(user_id,match_id,code) VALUES(?,'1','code')", user);
  db.run(
    "INSERT INTO demos(id,owner_id,name,source,status,size,created_at,source_ref) VALUES('manual',?,'file','upload','uploading',1,?,'steam:1')",
    user,
    now(),
  );
  setSteamAutoImport(db, user, subject, 'generation1', true);
  db.run('UPDATE steam_auto_imports SET next_sync=?', now() + 10000);
  let calls = 0;
  const bg = new SteamAutoImporter(
    db,
    c,
    async () => assert.fail(),
    async () => {
      calls++;
      if (calls === 1) throw new HttpError(409, 'already added', undefined, 'steam_already_added');
      return { id: 'retried' };
    },
  );
  await bg.tick();
  assert.equal(calls, 1);
  assert.ok(db.one('SELECT retry_at FROM steam_auto_jobs')!.retry_at > now());
  db.run("DELETE FROM demos WHERE id='manual'");
  db.run('UPDATE steam_auto_jobs SET retry_at=0');
  await bg.tick();
  assert.equal(calls, 2);
  assert.equal(db.one('SELECT 1 FROM steam_auto_jobs'), undefined);
  await bg.close();
});

test('a superseded auto-import grant cancels a running transfer on the next check', async (t) => {
  const { db, c, user, subject } = queueFixture(t);
  db.run("INSERT INTO steam_matches(user_id,match_id,code) VALUES(?,'1','code')", user);
  setSteamAutoImport(db, user, subject, 'generation1', true);
  db.run('UPDATE steam_auto_imports SET next_sync=?', now() + 10000);
  const started = Promise.withResolvers<void>();
  const bg = new SteamAutoImporter(
    db,
    c,
    async () => assert.fail(),
    async (_user, _match, _grant, signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw signal.reason;
    },
  );
  const transfer = bg.tick();
  await started.promise;
  db.run("UPDATE steam_history SET generation='new'");
  await Promise.all([bg.tick(), transfer]);
  await bg.close();
});
