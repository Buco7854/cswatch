import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { guestCookieName } from '../src/guest.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { COOKIE, digest, HttpError } from '../src/security.js';
import { createApp } from '../src/server.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';
import { initializeFixture } from './fixtures/initialized.js';
import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';

test('FACEIT verification, history and download lookup use current verified identity and fixed APIs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-providers-'));
  const origin = 'http://localhost:8000';
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    FACEIT_ENABLED: 'true',
    FACEIT_REQUESTS_PER_MINUTE: '600',
    FACEIT_API_KEY: 'fixture-faceit-key',
    FACEIT_DOWNLOAD_TOKEN: 'fixture-faceit-download-token',
    LOG_LEVEL: 'silent',
  });
  const db = new Store(root);
  initializeFixture(db);
  let downloadBehavior = 'success';
  const app = await createApp(config, db, async (value, destination, options) => {
    const url = new URL(value);
    assert.ok(
      options.allowedHosts.includes(url.hostname),
      'only a fixed signed host reaches the transport',
    );
    assert.match(destination, /input\.(?:gz|zst)$/);
    if (downloadBehavior === 'oversized')
      throw new HttpError(413, 'Demo exceeds the upload limit.');
    if (downloadBehavior === 'expired')
      throw new HttpError(
        502,
        'The demo download is unavailable or has expired. Try again or upload manually.',
      );
    if (downloadBehavior === 'changed') db.run("DELETE FROM identities WHERE provider='faceit'");
    const bytes = destination.endsWith('.gz')
      ? Buffer.from([0x1f, 0x8b])
      : Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    writeFileSync(destination, bytes);
    if (downloadBehavior === 'late publication') {
      const wallTime = Date.now();
      t.mock.method(Date, 'now', () => wallTime + 600_001);
    }
    return { bytes: bytes.length };
  });
  const fetchBefore = globalThis.fetch;
  try {
    const headers = { host: 'localhost:8000', origin };
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: await browserBootstrap(app, config),
      payload: {
        display_name: 'provider_fixture',
        email: 'provider_fixture@example.test',
        password: 'disposable-fixture-password',
      },
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
    const emptyMatch = match + '-empty';
    const sources = async () =>
      (await app.inject({ url: '/api/auth/me', headers: authenticated })).json().user.match_sources;
    assert.equal((await sources()).faceit_verification, 'steam_required');
    db.run("INSERT INTO identities VALUES('steam',?,?)", steam, id);
    assert.equal((await sources()).faceit_verification, 'ready');
    const faceitKey = config.faceitApiKey;
    config.faceitApiKey = '';
    assert.equal((await sources()).faceit_verification, 'unavailable');
    assert.equal((await sources()).faceit, false);
    config.faceitApiKey = faceitKey;
    let malformed = false,
      revoke = false;
    let lookupStatus = 200;
    let signerStatus = 200;
    let signerCalls = 0;
    let signedHost = 'demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com';
    let participant = true;
    let demoUrls: string[] = [];
    const resources = [
      'https://demos.faceit.com/cs2/match-one.dem.gz',
      'https://demos.faceit.com/cs2/match-two.dem.zst',
    ];
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.origin === 'https://api.faceit.com') {
        signerCalls++;
        assert.equal(url.pathname, '/download/v2/demos/download');
        assert.equal(options?.method, 'POST');
        assert.equal(options?.redirect, 'error');
        assert.equal(
          (options?.headers as Record<string, string>).Authorization,
          'Bearer fixture-faceit-download-token',
        );
        assert.ok(resources.includes(JSON.parse(String(options?.body)).resource_url));
        return Response.json(
          { payload: { download_url: 'https://' + signedHost + '/file?signature=synthetic' } },
          { status: signerStatus },
        );
      }
      assert.equal(url.origin, 'https://open.faceit.com');
      assert.deepEqual(options?.headers, { Authorization: 'Bearer fixture-faceit-key' });
      assert.equal(options?.redirect, 'error');
      if (lookupStatus !== 200)
        return new Response('upstream fixture detail must stay private', { status: lookupStatus });
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
        assert.equal(url.searchParams.get('limit'), '100');
        return Response.json({
          items: Array.from({ length: 20 }, (_, index) => ({
            match_id: index === 0 ? match : index === 1 ? emptyMatch : 'fixture_' + index,
            demo_url: ['private'],
          })),
        });
      }
      const match_id = url.pathname.split('/').at(-1);
      assert.ok(match_id === match || match_id === emptyMatch);
      return Response.json({
        match_id,
        game: 'cs2',
        demo_url: match_id === emptyMatch ? [] : demoUrls,
        teams: { faction1: { roster: participant ? [{ player_id: faceit }] : [] } },
      });
    };
    const link = () =>
      app.inject({
        method: 'POST',
        url: '/api/connections/faceit/link',
        headers: authenticated,
        payload: {},
      });
    const linked = await link();
    assert.equal(linked.statusCode, 200, linked.body);
    authenticated.cookie = COOKIE + '=' + linked.cookies.find((c) => c.name === COOKIE)!.value;
    authenticated['x-csrf-token'] = linked.json().session.csrf;
    const history = await app.inject({
      url: '/api/connections/faceit/matches?cursor=1700000000.0',
      headers: authenticated,
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().items[0].match_id, match);
    assert.equal(history.json().next, null);
    assert.equal((await sources()).faceit_download, true);
    assert.doesNotMatch(history.body, /demo_url|private/);
    const details = (id = match) =>
      app.inject({
        url: '/api/connections/faceit/match-demos?match_id=' + id,
        headers: authenticated,
      });
    const importDemo = (resource_id?: string, match_id = match) =>
      app.inject({
        method: 'POST',
        url: '/api/connections/faceit/import',
        headers: authenticated,
        payload: { match_id, resource_id },
      });
    assert.equal((await importDemo(undefined, emptyMatch)).statusCode, 404);
    lookupStatus = 503;
    assert.equal((await details(emptyMatch)).json().code, 'faceit_no_demo');
    const retained = await app.inject({
      url: '/api/connections/faceit/matches?cursor=1700000000.0',
      headers: authenticated,
    });
    assert.equal(
      retained.json().items.find((item: { match_id: string }) => item.match_id === emptyMatch)
        .no_demo,
      true,
    );
    lookupStatus = 200;
    assert.equal(db.one('SELECT id FROM demos'), undefined);
    for (const [upstream, mapped] of [
      [400, 502],
      [401, 502],
      [403, 502],
      [404, 404],
      [429, 429],
      [503, 503],
      [500, 502],
      [302, 502],
    ]) {
      lookupStatus = upstream;
      const response = await details();
      assert.equal(response.statusCode, mapped);
      assert.doesNotMatch(response.body, /upstream fixture detail/);
      if ([429, 503].includes(upstream)) {
        assert.equal((await details()).statusCode, 429);
        db.run("DELETE FROM settings WHERE key='provider_retry_faceitData'");
      }
    }
    lookupStatus = 200;
    demoUrls = resources;
    participant = false;
    assert.equal((await details()).statusCode, 403);
    participant = true;
    demoUrls = ['https://untrusted.fixture/file.dem'];
    assert.equal((await details()).statusCode, 502);
    demoUrls = resources;
    const fileList = (await details()).json().files;
    assert.deepEqual(
      fileList.map((file: { file: number }) => file.file),
      [1, 2],
    );
    assert.equal((await importDemo()).statusCode, 409);
    signerStatus = 403;
    const deniedDownload = await importDemo(fileList[0].id);
    assert.equal(deniedDownload.statusCode, 502, deniedDownload.body);
    assert.deepEqual(deniedDownload.json(), {
      detail: 'This instance cannot download FACEIT demos. Upload the demo file from your device.',
    });
    assert.equal(db.one('SELECT id FROM demos'), undefined);
    signerStatus = 200;
    signedHost = 'arbitrary-bucket.s3.amazonaws.com';
    assert.match((await importDemo(fileList[0].id)).body, /unsupported download host/);
    signedHost = 'demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com';
    downloadBehavior = 'expired';
    assert.match((await importDemo(fileList[0].id)).body, /expired/);
    downloadBehavior = 'oversized';
    assert.equal((await importDemo(fileList[0].id)).statusCode, 413);
    assert.equal(db.one('SELECT id FROM demos'), undefined);
    downloadBehavior = 'late publication';
    const late = await importDemo(fileList[0].id);
    assert.equal(late.statusCode, 408, late.body);
    assert.equal(db.one('SELECT id FROM demos'), undefined);
    t.mock.restoreAll();
    downloadBehavior = 'success';
    for (const [index, file] of fileList.entries()) {
      const imported = await importDemo(file.id);
      assert.equal(imported.statusCode, 202, imported.body);
      const row = db.one('SELECT owner_id,public,status FROM demos WHERE id=?', imported.json().id);
      assert.deepEqual({ ...row }, { owner_id: id, public: 0, status: 'queued' });
      const input = readFileSync(
        join(root, 'demos', imported.json().id, index === 0 ? 'input.gz' : 'input.zst'),
      );
      assert.ok(input.byteLength > 0);
    }
    assert.equal((await importDemo(fileList[0].id)).statusCode, 409);
    assert.equal(signerCalls, 7);
    assert.ok(
      (await details()).json().files.every((file: { demo: { id: string } }) => !!file.demo?.id),
    );
    db.run('DELETE FROM demos');
    downloadBehavior = 'changed';
    assert.equal((await importDemo(fileList[0].id)).statusCode, 429);
    // Test identity revalidation in a new import window with the same signed-in account.
    const time = Date.now();
    const importClock = t.mock.method(Date, 'now', () => time + 3_600_000);
    try {
      const changed = await importDemo(fileList[0].id);
      assert.equal(changed.statusCode, 409, changed.body);
      assert.match(changed.json().detail, /FACEIT connection changed/);
    } finally {
      importClock.mock.restore();
    }
    assert.equal(db.one('SELECT id FROM demos'), undefined);
    malformed = true;
    assert.equal((await link()).statusCode, 502);
    malformed = false;
    revoke = true;
    db.run("DELETE FROM identities WHERE user_id=? AND provider='faceit'", id);
    assert.equal((await link()).statusCode, 401);
    assert.equal(db.one("SELECT subject FROM identities WHERE provider='faceit'"), undefined);
  } finally {
    globalThis.fetch = fetchBefore;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Steam share-code vector preserves unsigned IDs and token', async () => {
  const { decodeSteamShareCode } = await import('../src/steam-share-code.js');
  assert.deepEqual(decodeSteamShareCode('CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK'), {
    match_id: '3230642215713767580',
    outcome_id: '3230647599455273103',
    token: 55788,
  });
  assert.equal(decodeSteamShareCode('CSGO-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA'), null);
  assert.equal(decodeSteamShareCode('CSGO-00000-AAAAA-AAAAA-AAAAA-AAAAB'), null);
  assert.equal(decodeSteamShareCode('CSGO-99999-99999-99999-99999-99999'), null);
});

test('Steam match sync needs only the operator API key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-steam-key-'));
  const origin = 'http://localhost:8000';
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    STEAM_ENABLED: 'true',
    STEAM_API_KEY: 'synthetic-operator-key',
  });
  const db = new Store(root);
  initializeFixture(db);
  const app = await createApp(config, db);
  const fetchBefore = globalThis.fetch;
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: await browserBootstrap(app, config),
      payload: {
        display_name: 'steam_key_fixture',
        email: 'steam_key_fixture@example.test',
        password: 'disposable-fixture-password',
      },
    });
    const { id, csrf } = registered.json().user;
    const headers = {
      origin,
      host: 'localhost:8000',
      'x-csrf-token': csrf,
      cookie: `${COOKIE}=${registered.cookies.find((cookie) => cookie.name === COOKIE)!.value}`,
    };
    db.run("INSERT INTO identities VALUES('steam',?,?)", '76561198000011002', id);
    const configured = await app.inject({
      url: '/api/config',
      headers: { host: 'localhost:8000' },
    });
    assert.equal(configured.json().steam_discovery, undefined);
    const path = join(root, 'encryption.key');
    assert.match(readFileSync(path, 'utf8'), /^[a-f0-9]{64}\n$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    globalThis.fetch = async () => Response.json({ result: { nextcode: 'n/a' } }, { status: 202 });
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/connections/steam/history',
      headers,
      payload: { auth_code: 'ABCD-EFGHI-JKLM', share_code: 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK' },
    });
    assert.equal(saved.statusCode, 200);
    const sync = await app.inject({
      method: 'POST',
      url: '/api/connections/steam/history/sync',
      headers,
    });
    assert.deepEqual(sync.json(), { up_to_date: true });
  } finally {
    globalThis.fetch = fetchBefore;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Steam match sync verifies before saving, resumes and protects user credentials and upload associations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-steam-sync-'));
  const origin = 'http://localhost:8000';
  const config = loadConfig({
    APP_URL: origin,
    COOKIE_SECURE: 'false',
    DATA_DIR: root,
    MAX_UPLOAD_MB: '1',
    STEAM_ENABLED: 'true',
    STEAM_API_KEY: 'synthetic-operator-key',
    // Deterministic synthetic key for a temporary test database only.
    ENCRYPTION_KEY: '11'.repeat(32),
  });
  const db = new Store(root);
  initializeFixture(db);
  const app = await createApp(config, db);
  const fetchBefore = globalThis.fetch;
  try {
    async function member(username: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: await browserBootstrap(app, config),
        payload: {
          display_name: username,
          email: `${username}@example.test`,
          password: 'disposable-fixture-password',
        },
      });
      assert.equal(response.statusCode, 201);
      const { id, csrf } = response.json().user;
      const headers = {
        origin,
        host: 'localhost:8000',
        'x-csrf-token': csrf,
        cookie: `${COOKIE}=${response.cookies.find((cookie) => cookie.name === COOKIE)!.value}`,
      };
      return { id, headers };
    }
    const owner = await member('steam_fixture');
    const other = await member('unrelated_fixture');
    const steamID = '76561198000011001';
    db.run("INSERT INTO identities VALUES('steam',?,?)", steamID, owner.id);
    const start = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
    const next = 'CSGO-Etr2P-HoO4N-itwhn-H2dyP-iwa3K';
    const later = 'CSGO-CcWD9-ornnc-nLVPi-fFjW2-wVC7K';
    const authCode = 'ABCD-EFGHI-JKLM';
    let upstream: (cursor: string) => Response = () => new Response(null, { status: 403 });
    let calls = 0;
    globalThis.fetch = async (input, options) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.steampowered.com');
      assert.equal(url.pathname, '/ICSGOPlayers_730/GetNextMatchSharingCode/v1/');
      assert.equal(url.searchParams.get('steamid'), steamID);
      assert.equal(url.searchParams.get('steamidkey'), authCode);
      assert.equal(url.searchParams.get('key'), config.steamApiKey);
      assert.equal(options?.redirect, 'error');
      return upstream(url.searchParams.get('knowncode')!);
    };
    const base = '/api/connections/steam';
    const save = (headers = owner.headers, auth_code = authCode) =>
      app.inject({
        method: 'PUT',
        url: base + '/history',
        headers,
        payload: { auth_code, share_code: start },
      });
    const sync = () =>
      app.inject({ method: 'POST', url: base + '/history/sync', headers: owner.headers });
    const list = (headers = owner.headers, filter = 'all', offset = 0) =>
      app.inject({ url: base + '/matches?filter=' + filter + '&offset=' + offset, headers });
    const status = () => app.inject({ url: base + '/history', headers: owner.headers });
    const capabilities = () => app.inject({ url: '/api/auth/me', headers: owner.headers });
    const remove = () =>
      app.inject({ method: 'DELETE', url: base + '/history', headers: owner.headers });
    assert.equal((await save({ ...owner.headers, 'x-csrf-token': 'wrong' })).statusCode, 403);
    assert.equal(
      (await save({ ...owner.headers, origin: 'https://unrelated.test' })).statusCode,
      403,
    );
    assert.equal((await save(owner.headers, 'invalid')).statusCode, 400);
    assert.equal((await save(other.headers)).statusCode, 400);
    assert.equal(calls, 0);
    assert.match((await save()).body, /replace your game authentication code/);
    assert.equal((await status()).json().configured, false);
    assert.equal((await capabilities()).json().user.match_sources.steam, false);
    upstream = () => new Response('invalid share code', { status: 412 });
    assert.match((await save()).body, /recent match sharing code/);
    upstream = () => new Response('not JSON');
    assert.equal((await save()).statusCode, 502);
    upstream = () => new Response(JSON.stringify({ result: { nextcode: 'x'.repeat(17000) } }));
    assert.equal((await save()).statusCode, 502);
    upstream = () =>
      new Response(null, { status: 302, headers: { location: 'https://unrelated.test' } });
    assert.equal((await save()).statusCode, 502);
    upstream = () => Response.json({ result: { nextcode: 'n/a' } }, { status: 202 });
    assert.deepEqual((await save()).json(), { up_to_date: true });
    const sealed = db.one(
      'SELECT encrypted_code FROM steam_history WHERE user_id=?',
      owner.id,
    )!.encrypted_code;
    assert.ok(sealed instanceof Uint8Array);
    assert.equal(Buffer.from(sealed).includes(Buffer.from(authCode)), false);
    assert.doesNotMatch(
      (await list()).body,
      /ABCD-EFGHI-JKLM|synthetic-operator-key|encrypted_code/,
    );
    assert.equal((await list(other.headers)).statusCode, 403);
    assert.equal((await capabilities()).json().user.match_sources.steam, true);
    upstream = (cursor) =>
      cursor === start
        ? Response.json({ result: { nextcode: next } })
        : new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
    assert.equal((await sync()).statusCode, 429);
    assert.equal(
      db.one('SELECT cursor FROM steam_history WHERE user_id=?', owner.id)?.cursor,
      next,
    );
    const beforeCooldown = calls;
    assert.match((await sync()).body, /cooling down/);
    assert.equal(calls, beforeCooldown);
    db.run("DELETE FROM settings WHERE key='steam_history_retry_at'");
    upstream = (cursor) => {
      assert.ok(cursor === next || cursor === later);
      return Response.json({ result: { nextcode: cursor === next ? later : 'n/a' } });
    };
    assert.deepEqual((await sync()).json(), { up_to_date: true });
    const items = (await list()).json().items;
    assert.deepEqual(
      items.map((item: { share_code: string }) => item.share_code),
      [later, next, start],
    );
    const { match_id } = items[0];
    const archive = Buffer.from(
      'QlpoOTFBWSZTWZG46yYAAANPgEAAEAAWAkgACmEMICAAIppiZMT0FMABNCZkXrvMjV0BeC7kinChISNx1kw=',
      'base64',
    );
    const upload = (headers: typeof owner.headers, data = archive, paired = true) =>
      app.inject({
        method: 'POST',
        url: '/api/demos' + (paired ? '?steam_match=' + match_id : ''),
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=steam-test' },
        payload: Buffer.concat([
          Buffer.from(
            '--steam-test\r\nContent-Disposition: form-data; name="file"; filename="fixture.dem.BZ2"\r\n\r\n',
          ),
          data,
          Buffer.from('\r\n--steam-test--\r\n'),
        ]),
      });
    assert.equal((await upload(other.headers)).statusCode, 404);
    assert.equal((await upload(owner.headers, archive, false)).statusCode, 400);
    assert.equal((await upload(owner.headers, Buffer.from('PBDEMS2\0'))).statusCode, 400);
    const oversized = Buffer.concat([archive, Buffer.alloc(1024 * 1024)]);
    assert.equal((await upload(owner.headers, oversized)).statusCode, 413);
    const uploaded = await upload(owner.headers);
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    const demoId = uploaded.json().id;
    assert.deepEqual(readFileSync(join(root, 'demos', demoId, 'input.bz2')), archive);
    assert.equal((await list()).json().items[0].demos[0].id, demoId);
    assert.equal((await list(owner.headers, 'downloaded')).json().items[0].match_id, match_id);
    assert.equal((await list(owner.headers, 'missing')).json().items.length, 2);
    assert.equal((await list(owner.headers, 'missing', 25)).json().items.length, 0);
    db.run(
      "UPDATE demos SET status='ready',map='de_ancient',metadata=? WHERE id=?",
      JSON.stringify({ recordedScore: [13, 8] }),
      demoId,
    );
    assert.deepEqual((await list(owner.headers, 'downloaded')).json().items[0].demos[0], {
      id: demoId,
      status: 'ready',
      map: 'de_ancient',
      score: [13, 8],
    });
    db.run("UPDATE demos SET status='failed' WHERE id=?", demoId);
    assert.equal(
      (await list(owner.headers, 'downloaded')).json().items[0].demos[0].status,
      'failed',
    );
    assert.equal((await list(owner.headers, 'downloaded')).json().items[0].demos[0].map, null);
    const mine = await app.inject({ url: '/api/demos?source=steam', headers: owner.headers });
    assert.equal(mine.json().demos[0].source, 'steam');
    db.run('DELETE FROM rate_limits');
    upstream = () => new Response(null, { status: 504 });
    assert.match((await sync()).body, /timed out/);
    assert.equal((await sync()).statusCode, 429);
    db.run("DELETE FROM settings WHERE key='steam_history_retry_at'");
    upstream = () => new Response(null, { status: 500 });
    assert.equal((await sync()).statusCode, 502);
    upstream = () => new Response(null, { status: 503 });
    assert.equal((await sync()).statusCode, 503);
    db.run("DELETE FROM settings WHERE key='steam_history_retry_at'");
    upstream = () => new Response(null, { status: 403 });
    assert.equal((await sync()).statusCode, 403);
    assert.equal((await list()).json().needs_codes, true);
    assert.match((await sync()).body, /Replace your Steam sync codes/);
    db.run('UPDATE steam_history SET needs_codes=0');
    db.run('DELETE FROM rate_limits');
    db.run('UPDATE steam_history SET encrypted_code=?', Buffer.alloc(44));
    assert.match((await sync()).body, /saved Steam code cannot be read/);
    assert.equal((await remove()).statusCode, 200);
    assert.equal(db.one('SELECT * FROM steam_history'), undefined);
    assert.equal((await list()).statusCode, 403);
    assert.equal(
      db.one('SELECT id FROM demos WHERE id=?', uploaded.json().id)?.id,
      uploaded.json().id,
    );
    upstream = () => {
      db.run('DELETE FROM sessions WHERE user_id=?', owner.id);
      return Response.json({ result: { nextcode: 'n/a' } }, { status: 202 });
    };
    assert.equal((await save()).statusCode, 401);
    assert.equal(db.one('SELECT * FROM steam_history'), undefined);
  } finally {
    globalThis.fetch = fetchBefore;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('FACEIT library walks the full history with a timestamp cursor and keeps downloaded pages private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-faceit-history-'));
  const origin = 'http://localhost:8000';
  const config = loadConfig({
    APP_URL: origin,
    DATA_DIR: root,
    COOKIE_SECURE: 'false',
    FACEIT_ENABLED: 'true',
    FACEIT_REQUESTS_PER_MINUTE: '600',
    FACEIT_API_KEY: 'synthetic-key',
    LOG_LEVEL: 'silent',
  });
  const db = new Store(root);
  initializeFixture(db);
  const app = await createApp(config, db);
  const fetchBefore = globalThis.fetch;
  const endpoint = '/api/connections/faceit/matches';
  try {
    async function member(username: string, subject: string) {
      const registered = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: await browserBootstrap(app, config),
        payload: {
          display_name: username,
          email: `${username}@example.test`,
          password: 'disposable-fixture-password',
        },
      });
      assert.equal(registered.statusCode, 201, registered.body);
      const { id, csrf } = registered.json().user;
      const headers = {
        host: 'localhost:8000',
        origin,
        'x-csrf-token': csrf,
        cookie: `${COOKIE}=${registered.cookies.find((cookie) => cookie.name === COOKIE)!.value}`,
      };
      assert.equal(
        (await app.inject({ url: '/api/auth/me', headers })).json().user.match_sources.faceit,
        false,
      );
      db.run("INSERT INTO identities VALUES('faceit',?,?)", subject, id);
      assert.equal(
        (await app.inject({ url: '/api/auth/me', headers })).json().user.match_sources.faceit,
        true,
      );
      return { id, headers };
    }
    const owner = await member('faceit_owner', 'owner-faceit');
    const other = await member('faceit_other', 'other-faceit');
    const newer = 1_700_000_000;
    const history = Array.from({ length: 1278 }, (_, index) => ({
      match_id: 'match-' + index,
      finished_at: newer - Math.floor(index / 30), // repeated seconds cross page boundaries
      competition_name: 'Fixture League',
      teams: {
        faction1: {
          nickname: 'North',
          players: [{ player_id: 'owner-faceit', game_skill_level: 8 }],
        },
        faction2: { nickname: 'South', players: [{ player_id: 'other-faceit' }] },
      },
      results: { winner: 'faction1', score: { faction1: 13, faction2: 9 } },
    }));
    let calls = 0;
    let statsCalls = 0;
    let respond: (() => Response | Promise<Response>) | undefined;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://open.faceit.com');
      if (url.pathname.endsWith('/games/cs2/stats')) {
        assert.ok(Number(url.searchParams.get('from')) >= 1_699_999_000_000);
        if (++statsCalls > 1)
          return new Response(null, { status: 429, headers: { 'retry-after': '120' } });
        return Response.json({
          items: [
            { stats: { Map: 42 } },
            { stats: { 'Match Id': 'match-0', Map: 'de_mirage' } },
            { stats: { 'Match Id': 'match-1', Map: 'de_nuke' } },
            { stats: { 'Match Id': 'match-1', Map: 'de_mirage' } },
          ],
        });
      }
      calls++;
      if (url.pathname.includes('/matches/')) {
        const match_id = url.pathname.split('/').at(-1);
        return Response.json({
          match_id,
          game: 'cs2',
          finished_at: newer,
          teams: { faction1: { nickname: 'North', roster: [{ player_id: 'owner-faceit' }] } },
        });
      }
      assert.match(url.pathname, /\/players\/(owner|other)-faceit(?:-\d+)?\/history$/);
      const q = url.searchParams;
      assert.equal(q.get('from'), '0');
      const offset = Number(q.get('offset'));
      const limit = Number(q.get('limit'));
      assert.ok(offset >= 0 && offset <= 1000 && limit <= 100);
      if (respond) return respond();
      const items = history.filter((entry) => entry.finished_at <= Number(q.get('to')));
      return Response.json({ items: items.slice(offset, offset + limit) });
    };
    const read = (query = '', headers = owner.headers) =>
      app.inject({ url: endpoint + query, headers });
    const first = (await read()).json();
    assert.equal(first.items.length, 25);
    assert.equal(
      (await app.inject({ url: '/api/auth/me', headers: owner.headers })).json().user.match_sources
        .faceit_download,
      false,
    );
    assert.equal(first.items[0].map, 'de_mirage');
    assert.equal(first.items[1].map, null);
    assert.equal(first.items[0].result, 'win');
    assert.equal(first.items[0].faceit_level, 8);
    assert.deepEqual(first.items[0].teams, [
      { name: 'North', score: 13 },
      { name: 'South', score: 9 },
    ]);
    const expected = history.map((item) => item.match_id);
    history.unshift({ ...history[0], match_id: 'new-match', finished_at: newer + 1 });
    const walked = first.items.map((item: { match_id: string }) => item.match_id);
    for (let next = first.next; next;) {
      const page = await read('?cursor=' + next);
      assert.equal(page.statusCode, 200, page.body);
      walked.push(...page.json().items.map((item: { match_id: string }) => item.match_id));
      next = page.json().next;
    }
    assert.deepEqual(walked, expected);
    assert.equal(statsCalls, 2, 'the stats cooldown preserves history paging');
    const beforeCache = calls;
    const cursor = '?cursor=' + (newer - 41) + '.10';
    await read(cursor);
    await read(cursor);
    assert.equal(calls, beforeCache + 1, 'the same provider page is fetched once');
    for (let index = 0; index < 6; index++) await read('?cursor=' + (newer - index) + '.0');
    const beforeEvicted = calls;
    await read(cursor);
    assert.equal(calls, beforeEvicted + 1, 'the oldest cached page was evicted');

    // Populate the global member cache without performing password work for each fixture.
    for (let index = 0; index < 65; index++) {
      const label = 'cache-member-' + index;
      const id = digest(label).slice(0, 32);
      const issued = Math.floor(Date.now() / 1000);
      const provider = index % 2 ? 'owner-faceit' : 'other-faceit';
      db.run('INSERT INTO users(id,username,created_at) VALUES(?,?,?)', id, id, issued);
      db.run("INSERT INTO identities VALUES('faceit',?,?)", provider + '-' + index, id);
      insertFixtureSession(db, label, id, id, issued + 900);
      const cached = await read('?cursor=' + (newer - 100) + '.0', {
        ...owner.headers,
        cookie: fixtureCookie(label),
        'x-csrf-token': id,
      });
      assert.equal(cached.statusCode, 200, cached.body);
    }
    const afterMemberFill = calls;
    assert.equal((await read(cursor)).statusCode, 200);
    assert.equal(calls, afterMemberFill + 1, 'the least recently cached member was evicted');

    for (let index = 0; index < 28; index++) {
      db.run(
        `INSERT INTO demos(id,owner_id,name,source,status,size,created_at,faceit_match_id)
        VALUES(?,?,?,'faceit','failed',1,?,?)`,
        'owned-' + index,
        owner.id,
        'Owned',
        newer - index,
        'match-' + index,
      );
    }
    db.run(
      `INSERT INTO demos(id,owner_id,name,source,status,size,created_at,faceit_match_id)
      VALUES('other-demo',?,'Other','faceit','ready',1,?,'match-28')`,
      other.id,
      newer,
    );
    for (let index = 28; index < 430; index++) {
      db.run(
        `INSERT INTO demos(id,owner_id,name,source,status,size,created_at,faceit_match_id)
         VALUES(?,?,?,'faceit','ready',1,?,?)`,
        'scan-' + index,
        owner.id,
        'Downloaded while scanning',
        newer - index,
        'match-' + index,
      );
    }
    const beforeScan = calls;
    const sparse = (await read('?filter=missing&cursor=' + newer + '.0')).json();
    assert.equal(sparse.items.length, 0);
    assert.ok(sparse.next);
    assert.ok(calls - beforeScan <= 4, 'the scan cannot exceed four history calls');
    const filled = (await read('?filter=missing&cursor=' + sparse.next)).json();
    assert.equal(filled.items.length, 25);
    assert.equal(filled.items[0].match_id, 'match-430');
    db.run("DELETE FROM demos WHERE owner_id=? AND id LIKE 'scan-%'", owner.id);

    const notDownloaded = (await read('?filter=missing&cursor=' + newer + '.0')).json();
    assert.equal(notDownloaded.items.length, 25);
    assert.equal(notDownloaded.items[0].match_id, 'match-28');
    assert.deepEqual(notDownloaded.items[0].demos, []);
    const plain = Buffer.from('PBDEMS2\0synthetic');
    const archive = gzipSync(plain);
    const upload = (
      headers: Record<string, string>,
      filename = 'fixture.dem.gz',
      bytes = archive,
      paired = true,
    ) =>
      app.inject({
        method: 'POST',
        url: '/api/demos' + (paired ? '?faceit_match=match-28' : ''),
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=pair' },
        payload: Buffer.concat([
          Buffer.from(
            '--pair\r\nContent-Disposition: form-data; name="file"; filename="' +
              filename +
              '"\r\n\r\n',
          ),
          bytes,
          Buffer.from('\r\n--pair--\r\n'),
        ]),
      });
    // A valid gzip archive is accepted only for a verified roster member's pairing.
    assert.equal((await upload(other.headers)).statusCode, 403);
    assert.equal((await upload(owner.headers, 'fixture.dem.gz', archive, false)).statusCode, 400);
    const browser = await browserBootstrap(app, config);
    const guest = await app.inject({
      method: 'POST',
      url: '/api/guest/session',
      headers: browser,
      payload: {},
    });
    assert.equal(guest.statusCode, 201, guest.body);
    const grant = guest.cookies.find(({ name }) => name === guestCookieName(config))!;
    const guestHeaders = {
      ...browser,
      cookie: browser.cookie + '; ' + grant.name + '=' + grant.value,
      'x-csrf-token': guest.json().csrf,
    };
    assert.equal((await upload(guestHeaders)).statusCode, 401);
    assert.equal((await upload(guestHeaders, 'fixture.dem.gz', archive, false)).statusCode, 400);
    assert.equal((await upload(owner.headers, 'fixture.gz')).statusCode, 400);
    assert.equal((await upload(owner.headers, 'fixture.dem.gz', plain)).statusCode, 400);
    const original = await upload(owner.headers, 'fixture.dem', plain);
    assert.equal(original.statusCode, 202, original.body);
    const paired = await upload(owner.headers, 'fixture.DEM.GZ');
    assert.equal(paired.statusCode, 202, paired.body);
    const demo = db.one('SELECT * FROM demos WHERE id=?', paired.json().id)!;
    assert.equal(demo.owner_id, owner.id);
    assert.equal(demo.public, 0);
    assert.equal(demo.status, 'queued');
    assert.equal(demo.source, 'faceit');
    assert.equal(demo.faceit_match_id, 'match-28');
    assert.equal(demo.size, archive.length);
    assert.deepEqual(readFileSync(join(root, 'demos', demo.id, 'input.gz')), archive);

    respond = () => new Response('upstream private data', { status: 503 });
    const offline = calls;
    const downloaded = (await read('?filter=downloaded')).json();
    assert.equal(downloaded.items.length, 25);
    assert.equal(downloaded.next, '25');
    assert.deepEqual(
      new Set(downloaded.items[0].demos.map((d: { id: string }) => d.id)),
      new Set([original.json().id, paired.json().id]),
    );
    assert.equal((await read('?filter=downloaded&offset=25')).json().items.length, 4);
    assert.deepEqual(
      (await read('?filter=downloaded', other.headers))
        .json()
        .items.map((match: { match_id: string }) => match.match_id),
      ['match-28'],
    );
    assert.equal(calls, offline, 'downloaded filters make no provider requests');

    for (const [upstream, expected] of [
      [401, 502],
      [403, 502],
      [404, 404],
      [503, 503],
      [500, 502],
      [200, 502],
      [429, 429],
    ]) {
      respond = () =>
        new Response('upstream private data', {
          status: upstream,
          headers: { 'Retry-After': '1' },
        });
      const reply = await read('?cursor=' + (newer - 120) + '.0', other.headers);
      assert.equal(reply.statusCode, expected, reply.body);
      assert.doesNotMatch(reply.body, /private data/);
      if (upstream === 503) db.run("DELETE FROM settings WHERE key='provider_retry_faceitData'");
    }
    const backoff = calls;
    assert.equal((await read('?cursor=' + (newer - 121) + '.0', other.headers)).statusCode, 429);
    assert.equal(calls, backoff);
    await new Promise((resolve) => setTimeout(resolve, 1050));

    const inFlight = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<Response>();
    respond = () => {
      inFlight.resolve();
      return finish.promise;
    };
    const retiredHeaders = { ...other.headers };
    const pending = read('?cursor=' + (newer - 122) + '.0', retiredHeaders);
    await inFlight.promise;
    const unlinked = await app.inject({
      method: 'DELETE',
      url: '/api/connections/faceit/link',
      headers: other.headers,
      payload: {},
    });
    finish.resolve(Response.json({ items: [] }));
    assert.equal(unlinked.statusCode, 200, unlinked.body);
    other.headers.cookie =
      COOKIE + '=' + unlinked.cookies.find((cookie) => cookie.name === COOKIE)!.value;
    other.headers['x-csrf-token'] = unlinked.json().session.csrf;
    assert.equal((await pending).statusCode, 401, 'unlink retires the session that began history');
    assert.equal((await read('?filter=downloaded', retiredHeaders)).statusCode, 401);
    assert.equal((await read('', other.headers)).statusCode, 403);

    respond = undefined;
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: owner.headers,
      payload: {},
    });
    assert.equal(logout.statusCode, 200);
    assert.equal((await read()).statusCode, 401);
  } finally {
    globalThis.fetch = fetchBefore;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
