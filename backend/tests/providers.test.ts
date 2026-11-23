import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { COOKIE, HttpError } from '../src/security.js';
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
    return { bytes: bytes.length };
  });
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
        assert.equal(url.searchParams.get('limit'), '20');
        if (url.searchParams.get('offset') === '20') {
          assert.equal(url.searchParams.get('to'), '1700000000');
          return Response.json({ items: [] });
        }
        return Response.json({
          items: Array.from({ length: 20 }, (_, index) => ({
            match_id: index === 0 ? match : 'fixture_' + index,
            demo_url: ['private'],
          })),
        });
      }
      assert.equal(url.pathname, `/data/v4/matches/${match}`);
      return Response.json({
        match_id: match,
        game: 'cs2',
        demo_url: demoUrls,
        teams: { faction1: { roster: participant ? [{ player_id: faceit }] : [] } },
      });
    };
    const link = () =>
      app.inject({ method: 'POST', url: '/api/connections/faceit/link', headers: authenticated });
    assert.equal((await link()).statusCode, 200);
    const history = await app.inject({
      url: '/api/connections/faceit/matches',
      headers: authenticated,
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.json().items[0], { match_id: match });
    assert.equal(history.json().next_offset, 20);
    const page = await app.inject({
      url: '/api/connections/faceit/matches?offset=20&to=1700000000',
      headers: authenticated,
    });
    assert.deepEqual(page.json(), { items: [], next_offset: null, to: 1700000000 });
    const details = () =>
      app.inject({
        url: '/api/connections/faceit/match-demos?match_id=' + match,
        headers: authenticated,
      });
    const importDemo = (resource_id?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/connections/faceit/import',
        headers: authenticated,
        payload: { match_id: match, resource_id },
      });
    assert.equal((await importDemo()).statusCode, 404);
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
    assert.match((await importDemo(fileList[0].id)).body, /denied Downloads API access/);
    signerStatus = 200;
    signedHost = 'arbitrary-bucket.s3.amazonaws.com';
    assert.match((await importDemo(fileList[0].id)).body, /unsupported download host/);
    signedHost = 'demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com';
    downloadBehavior = 'expired';
    assert.match((await importDemo(fileList[0].id)).body, /expired/);
    downloadBehavior = 'oversized';
    assert.equal((await importDemo(fileList[0].id)).statusCode, 413);
    assert.equal(db.one('SELECT id FROM demos'), undefined);
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
    assert.equal(signerCalls, 6);
    assert.ok((await details()).json().files.every((file: { demo_id: string }) => !!file.demo_id));
    db.run('DELETE FROM demos');
    downloadBehavior = 'changed';
    assert.equal((await importDemo(fileList[0].id)).statusCode, 409);
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

test('Steam match sync needs only the operator API key and creates one private key file', async () => {
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
      headers: { origin, host: 'localhost:8000' },
      payload: { username: 'steam_key_fixture', password: 'disposable-fixture-password' },
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
    assert.equal(configured.json().steam_discovery, true);
    const path = join(root, 'encryption.key');
    assert.equal(existsSync(path), false, 'The key appears only when a member saves codes.');
    globalThis.fetch = async () => Response.json({ result: { nextcode: 'n/a' } }, { status: 202 });
    const save = () =>
      app.inject({
        method: 'PUT',
        url: '/api/connections/steam/history',
        headers,
        payload: { auth_code: 'ABCD-EFGHI-JKLM', share_code: 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK' },
      });
    assert.equal((await save()).statusCode, 200);
    const key = readFileSync(path, 'utf8');
    assert.match(key, /^[a-f0-9]{64}\n$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal((await save()).statusCode, 200);
    assert.equal(readFileSync(path, 'utf8'), key, 'An existing key is never replaced.');
    assert.equal(
      readdirSync(root).filter((file) => file.startsWith('encryption.key')).length,
      1,
      'No staged key remains.',
    );
    const sync = () =>
      app.inject({ method: 'POST', url: '/api/connections/steam/history/sync', headers });
    assert.deepEqual((await sync()).json(), { up_to_date: true });
    rmSync(path);
    assert.equal((await sync()).statusCode, 409, 'A lost key asks the member to save codes again.');
    chmodSync(path, 0o644);
    assert.equal((await sync()).statusCode, 503, 'A readable key file is refused.');
    config.encryptionKey = 'ab'.repeat(32);
    assert.equal((await save()).statusCode, 200, 'ENCRYPTION_KEY takes the place of the file.');
    assert.throws(() =>
      loadConfig({ APP_URL: origin, COOKIE_SECURE: 'false', ENCRYPTION_KEY: 'short' }),
    );
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
        headers: { origin, host: 'localhost:8000' },
        payload: { username, password: 'disposable-fixture-password' },
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
    const list = (headers = owner.headers) => app.inject({ url: base + '/matches', headers });
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
    assert.equal((await list()).json().configured, false);
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
    assert.deepEqual((await list(other.headers)).json().items, []);
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
    const upload = (headers: typeof owner.headers) =>
      app.inject({
        method: 'POST',
        url: '/api/demos?steam_match=' + match_id,
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=steam-test' },
        payload:
          '--steam-test\r\nContent-Disposition: form-data; name="file"; filename="fixture.dem"\r\n\r\nPBDEMS2\0synthetic\r\n--steam-test--\r\n',
      });
    assert.equal((await upload(other.headers)).statusCode, 404);
    const uploaded = await upload(owner.headers);
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    assert.equal((await list()).json().items[0].demo_id, uploaded.json().id);
    db.run('DELETE FROM rate_limits');
    upstream = () => new Response(null, { status: 504 });
    assert.match((await sync()).body, /timed out/);
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
    config.encryptionKey = '22'.repeat(32);
    assert.match((await sync()).body, /saved Steam code cannot be read/);
    assert.equal((await remove()).statusCode, 200);
    assert.equal(db.one('SELECT * FROM steam_history'), undefined);
    assert.deepEqual((await list()).json().items, []);
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
