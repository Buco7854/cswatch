import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { loadConfig } from '../src/config.js';
import { now, Store } from '../src/db.js';
import { ProviderRequests } from '../src/provider-requests.js';
import type { downloadSteamReplay } from '../src/remote-download.js';
import { createApp } from '../src/server.js';
import { steamImportRoutes } from '../src/steam-import.js';
import {
  SteamCoordinatorError,
  type SteamCoordinator,
  type SteamReplaySource,
} from '../src/steam-coordinator.js';
import { initializeFixture } from './fixtures/initialized.js';
import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';

const code = 'CSGO-iOTv7-GGzpW-4roMX-MPEhk-OijDA';
const matchId = '9007199254740993';
const outcomeId = '18014398509482039';
const source = {
  matchId,
  outcomeId,
  token: 99,
  accountIds: [100, 200],
  url: 'http://replay120.valve.net/730/' + outcomeId.padStart(21, '0') + '_0000065635.dem.bz2',
};
const archive = Buffer.from(
  'QlpoOTFBWSZTWcpvTW0AAANOgMAAEAAWAkgAAEAACCAAMQAwCqIGJNVzvrucQAzQgB8XckU4UJDKb01t',
  'base64',
);
const binding = {
  steamId: '76561197960265828',
  generation: 'verified-history',
  grantId: 'grant-1',
};

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-steam-import-'));
  const origin = 'http://localhost:8000';
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    LOG_LEVEL: 'silent',
    STEAM_ENABLED: 'true',
    STEAM_COORDINATOR_ENABLED: 'true',
    STEAM_API_KEY: 'fixture-api',
    STEAM_COORDINATOR_USERNAME: 'fixture-gc',
    STEAM_COORDINATOR_PASSWORD: 'fixture-only',
    MAX_UPLOAD_MB: '1',
  });
  const db = new Store(root);
  initializeFixture(db);
  const activity = { lookups: 0, downloads: 0 };
  const hooks = {
    resolve: async (): Promise<SteamReplaySource> => source,
    download: async (_path: string): Promise<Buffer> => archive,
  };
  const coordinator: SteamCoordinator = {
    async resolve(savedCode, signal) {
      assert.equal(savedCode, code);
      signal.throwIfAborted();
      activity.lookups++;
      return hooks.resolve();
    },
    async close() {},
  };
  const download: typeof downloadSteamReplay = async (url, path, options) => {
    assert.equal(url, source.url);
    assert.equal(options.expected.outcome_id, outcomeId);
    assert.equal(options.expected.token, source.token);
    assert.equal(options.maxBytes, 1024 ** 2);
    assert.equal(options.signal.aborted, false);
    activity.downloads++;
    options.onResponse?.(200);
    const bytes = await hooks.download(path);
    writeFileSync(path, bytes, { flag: 'wx' });
    return { bytes: bytes.length };
  };
  const app = await createApp(config, db, undefined, {
    steamCoordinator: coordinator,
    steamDownload: download,
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  function member(name: string, account: number) {
    db.run('INSERT INTO users(id,username,created_at) VALUES(?,?,?)', name, name, now());
    db.run(
      "INSERT INTO identities VALUES('steam',?,?)",
      String(76561197960265728n + BigInt(account)),
      name,
    );
    insertFixtureSession(db, name, name, name + '-csrf', now() + 3600);
    return {
      host: 'localhost:8000',
      origin,
      cookie: fixtureCookie(name),
      'x-csrf-token': name + '-csrf',
    };
  }
  const owner = member('owner', 100),
    other = member('other', 200);
  function sync(name: string) {
    const steamId = db.one(
      "SELECT subject FROM identities WHERE user_id=? AND provider='steam'",
      name,
    )!.subject;
    db.run(
      'INSERT INTO steam_history(user_id,steam_id,encrypted_code,cursor,generation) VALUES(?,?,?,?,?)',
      name,
      steamId,
      Buffer.alloc(16),
      code,
      binding.generation,
    );
    db.run('INSERT INTO steam_matches(user_id,match_id,code) VALUES(?,?,?)', name, matchId, code);
  }
  sync('owner');
  const post = (
    headers: Record<string, string> = owner,
    payload: Record<string, string> = { match_id: matchId },
  ) => app.inject({ method: 'POST', url: '/api/connections/steam/import', headers, payload });
  const noReservation = () => {
    assert.equal(db.one('SELECT 1 FROM demos'), undefined);
    assert.deepEqual(readdirSync(join(root, 'demos')), []);
  };
  return {
    app,
    db,
    root,
    config,
    owner,
    other,
    post,
    activity,
    hooks,
    sync,
    noReservation,
    coordinator,
    download,
  };
}

test('only a member with their saved code can request a private server import; users of the same instance share a lookup account', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ ...f.owner, origin: 'https://other.invalid' })).statusCode, 403);
  assert.equal((await f.post({ ...f.owner, 'x-csrf-token': 'wrong' })).statusCode, 403);
  assert.ok(
    [401, 403].includes((await f.post({ origin: f.owner.origin, host: f.owner.host })).statusCode),
  );
  assert.equal((await f.post(f.other)).statusCode, 404);
  assert.equal((await f.post(f.owner, { match_id: matchId, url: source.url })).statusCode, 400);
  assert.equal((await f.post(f.owner, { match_id: matchId, share_code: code })).statusCode, 400);
  assert.equal((await f.post(f.owner, { match_id: '32' })).statusCode, 404);
  assert.deepEqual(f.activity, { lookups: 0, downloads: 0 });
  const result = await f.post();
  assert.equal(result.statusCode, 202, result.body);
  const id = result.json().id;
  assert.deepEqual(Object.keys(result.json()), ['id']);
  const row = f.db.one('SELECT * FROM demos WHERE id=?', id)!;
  assert.equal(row.owner_id, 'owner');
  assert.equal(row.source_ref, 'steam:' + matchId);
  assert.equal(row.source, 'steam');
  assert.equal(row.faceit_match_id, null);
  assert.equal(row.public, 0);
  assert.equal(row.status, 'queued');
  assert.equal(row.size, archive.length);
  assert.deepEqual(readFileSync(join(f.root, 'demos', id, 'input.bz2')), archive);
  assert.equal((await f.post()).json().code, 'steam_already_added');
  assert.deepEqual(f.activity, { lookups: 1, downloads: 1 });
  assert.equal((await f.app.inject({ url: '/api/demos/' + id, headers: f.other })).statusCode, 404);
  const listing = await f.app.inject({
    url: '/api/connections/steam/matches?filter=downloaded',
    headers: f.owner,
  });
  assert.equal(listing.json().items[0].demos[0].id, id);
  f.db.run("UPDATE demos SET status='failed' WHERE id=?", id);
  const retried = await f.post();
  assert.equal(retried.statusCode, 202, retried.body);
  const afterRetry = await f.app.inject({
    url: '/api/connections/steam/matches?filter=downloaded',
    headers: f.owner,
  });
  assert.equal(afterRetry.json().items[0].demos[0].id, retried.json().id);
  f.sync('other');
  const ownCopy = await f.post(f.other);
  assert.equal(ownCopy.statusCode, 202, ownCopy.body);
  assert.notEqual(ownCopy.json().id, id);
  assert.deepEqual(f.activity, { lookups: 3, downloads: 3 });
});

test('exact GC match, roster, reservation and token are checked before downloading, with bounded, safe errors', async (t) => {
  const f = await fixture(t);
  for (const result of [
    { ...source, matchId: '1' },
    { ...source, outcomeId: '1' },
    { ...source, token: 100 },
    { ...source, url: source.url.replace(outcomeId, '18014398509482040') },
    { ...source, url: source.url.replace('0000065635', '0000065636') },
    { ...source, url: 'http://localhost/fixture' },
  ]) {
    f.hooks.resolve = async () => result;
    assert.equal((await f.post()).statusCode, 502);
    f.noReservation();
  }
  f.hooks.resolve = async () => ({ ...source, accountIds: [200] });
  assert.equal((await f.post()).json().code, 'steam_not_participant');
  f.hooks.resolve = async () => {
    throw new SteamCoordinatorError('unavailable');
  };
  assert.equal((await f.post()).json().code, 'steam_no_demo');
  assert.equal(f.activity.downloads, 0);
  f.hooks.resolve = async () => source;
  f.hooks.download = async () => Buffer.from('not a replay');
  assert.equal((await f.post()).statusCode, 400);
  f.noReservation();
});

test('server import failures tell members when the administrator must act and preserve automatic retries', async (t) => {
  const f = await fixture(t);
  for (const [cause, detail] of [
    ['guard_email', /Steam Guard/],
    ['guard_mobile', /Steam Guard/],
    ['guard', /Steam Guard/],
    ['credentials', /Steam refused/],
  ] as const) {
    f.hooks.resolve = async () => {
      throw new SteamCoordinatorError(cause);
    };
    const response = await f.post();
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'steam_coordinator_setup');
    assert.match(response.json().detail, detail);
    f.noReservation();
  }
  f.config.steamCoordinatorEnabled = false;
  const disabled = await f.post();
  assert.equal(disabled.statusCode, 503);
  assert.equal(disabled.json().code, 'steam_coordinator_setup');
  assert.match(disabled.json().detail, /disabled/);
  assert.deepEqual(f.activity, { lookups: 4, downloads: 0 });
  f.noReservation();
});

test('an atomic reservation protects quota and concurrent imports before the first provider call', async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<SteamReplaySource>();
  f.hooks.resolve = () => {
    entered.resolve();
    return release.promise;
  };
  const first = f.post().then((r) => r);
  await entered.promise;
  assert.equal((await f.post()).json().code, 'steam_already_added');
  assert.equal(f.activity.lookups, 1);
  f.sync('other');
  f.config.globalStorageMb = 1;
  assert.equal((await f.post(f.other)).statusCode, 503);
  assert.equal(f.activity.lookups, 1);
  release.resolve(source);
  const complete = await first;
  assert.equal(complete.statusCode, 202, complete.body);
  f.db.run('UPDATE demos SET source_ref=NULL');
  f.config.userDemoLimit = 1;
  assert.equal((await f.post()).statusCode, 413);
  assert.equal(f.activity.lookups, 1);
});

test('session, verified history, demo reservation, and linked identity must survive all asynchronous stages', async (t) => {
  const scenarios = [
    ['UPDATE steam_history SET needs_codes=1', 409, 'resolve'],
    ["DELETE FROM identities WHERE provider='steam'", 409, 'resolve'],
    ['DELETE FROM steam_matches', 409, 'download'],
    ["UPDATE steam_history SET generation='replaced'", 409, 'download'],
    ['DELETE FROM sessions', 401, 'download'],
    ["DELETE FROM demos WHERE status='uploading'", 409, 'download'],
    ["DELETE FROM users WHERE id='owner'", 401, 'download'],
  ] as const;
  for (const [sql, status, stage] of scenarios)
    await t.test(sql, async (t) => {
      const f = await fixture(t);
      if (stage === 'resolve')
        f.hooks.resolve = async () => {
          f.db.run(sql);
          return source;
        };
      else
        f.hooks.download = async () => {
          f.db.run(sql);
          return archive;
        };
      assert.equal((await f.post()).statusCode, status);
      assert.equal(f.activity.downloads, stage === 'resolve' ? 0 : 1);
      f.noReservation();
    });
});

test('automatic imports require the exact durable opt-in grant through publication and can run without a browser session', async (t) => {
  const f = await fixture(t);
  const routes = Fastify();
  t.after(() => routes.close());
  const api = steamImportRoutes(
    routes,
    f.db,
    f.config,
    f.coordinator,
    new ProviderRequests(f.db, f.config.providerLimits),
    f.download,
  );
  const run = (grantId = binding.grantId) =>
    api.importAutomatic('owner', matchId, { ...binding, grantId }, AbortSignal.timeout(5000));
  f.db.run('DELETE FROM sessions');
  await assert.rejects(run(), { code: 'steam_import_changed' });
  assert.equal(f.activity.lookups, 0);
  f.db.run(
    'INSERT INTO steam_auto_imports(user_id,steam_id,generation,grant_id,next_sync) VALUES(?,?,?,?,?)',
    'owner',
    binding.steamId,
    binding.generation,
    binding.grantId,
    now() + 3600,
  );
  f.hooks.download = async () => {
    f.db.run("UPDATE steam_auto_imports SET grant_id='replacement'");
    return archive;
  };
  await assert.rejects(run(), { code: 'steam_import_changed' });
  f.noReservation();
  f.hooks.download = async () => archive;
  const imported = await run('replacement');
  assert.equal(f.db.one('SELECT status FROM demos WHERE id=?', imported.id)?.status, 'queued');
});
