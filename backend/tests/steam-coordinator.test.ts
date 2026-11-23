import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import {
  createSteamCoordinator,
  type Command,
  type Reply,
  type SteamReplaySource,
} from '../src/steam-coordinator.js';
import { readMatch, steamFailure, steamProtocol } from '../src/steam-coordinator-worker.js';

const code = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK'; // existing decoder fixture
const request = { matchId: '3230642215713767580', outcomeId: '3230647599455273103', token: 55788 };
const replay = 'https://replay.invalid/example.dem.bz2';
const source: SteamReplaySource = { ...request, url: replay, accountIds: [21] };
const cfg = {
  steamCoordinatorEnabled: true,
  steamCoordinatorUsername: 'fixture',
  steamCoordinatorPassword: 'fixture',
  steamCoordinatorGuardSecret: undefined,
};
const signal = new AbortController().signal;

function mock(config = cfg, requestTimeout = 300, idleTimeout = 60_000, cacheTtl = 0) {
  const commands: Command['kind'][] = [];
  const statuses: number[] = [];
  const diagnostics: object[] = [];
  let opened = 0;
  let closed = 0;
  let admitted = 0;
  let refused = false;
  let respond: (c: Command) => Reply | undefined = (c) =>
    c.kind === 'match' ? { kind: 'ok', source } : { kind: 'ok' };
  let receive: (r: Reply) => void;
  const gc = createSteamCoordinator(
    config,
    {
      async run(service, work) {
        assert.equal(service, 'steamGc');
        if (refused) throw Error('admission');
        admitted++;
        return work((status) => statuses.push(status));
      },
    },
    {
      idleTimeout,
      cacheTtl,
      onFailure: (diagnostic) => diagnostics.push(diagnostic),
      loginTimeout: requestTimeout,
      requestTimeout,
      start(reply) {
        opened++;
        receive = reply;
        return {
          send(c) {
            commands.push(c.kind);
            const message = respond(c);
            if (message) queueMicrotask(() => reply(message));
          },
          async close() {
            closed++;
          },
        };
      },
    },
  );
  return {
    gc,
    commands,
    statuses,
    diagnostics,
    counts: () => ({ opened, closed, admitted }),
    respondWith(f: typeof respond) {
      respond = f;
    },
    unsolicited(r: Reply) {
      receive(r);
    },
    refuse(value: boolean) {
      refused = value;
    },
  };
}

test('disabled, malformed and limiter-rejected requests have no Steam session', async () => {
  const off = mock({ ...cfg, steamCoordinatorEnabled: false });
  await assert.rejects(off.gc.resolve(code, signal), { code: 'disabled' });
  assert.equal(off.counts().admitted, 0);
  const s = mock();
  await assert.rejects(s.gc.resolve('invalid', signal), { code: 'unavailable' });
  s.refuse(true);
  await assert.rejects(s.gc.resolve(code, signal), /admission/);
  assert.deepEqual(s.counts(), { opened: 0, closed: 0, admitted: 0 });
});

test('cold login, GC handshake and match spend separate admissions, then reuse one session', async () => {
  const s = mock();
  assert.deepEqual(await s.gc.resolve(code, signal), source);
  assert.deepEqual(await s.gc.resolve(code, signal), source);
  assert.deepEqual(s.commands, ['login', 'hello', 'match', 'match']);
  assert.deepEqual(s.counts(), { opened: 1, closed: 0, admitted: 4 });
  await s.gc.close();
  assert.equal(s.counts().closed, 1);
  await assert.rejects(s.gc.resolve(code, signal), { code: 'disabled' });
});

test('single flight, cancellation and late messages from the previous session', async () => {
  const s = mock();
  const c = new AbortController();
  s.respondWith(() => undefined);
  const interrupted = s.gc.resolve(code, c.signal);
  await delay(1);
  await assert.rejects(s.gc.resolve(code, signal), { code: 'busy' });
  c.abort();
  await assert.rejects(interrupted, { code: 'transient' });
  s.unsolicited({ kind: 'ok', source });
  assert.equal(s.counts().closed, 1);
  assert.deepEqual(s.statuses, []);
  assert.deepEqual(s.diagnostics, []);
  s.respondWith((c) => (c.kind === 'match' ? { kind: 'ok', source } : { kind: 'ok' }));
  await s.gc.resolve(code, signal);
  assert.equal(s.counts().opened, 2);
  await s.gc.close();
});

test('deadline and rate limits retire the transport, classify safely and report provider failures', async () => {
  const s = mock(cfg, 15);
  s.respondWith(() => undefined);
  const keepAlive = delay(30);
  await assert.rejects(s.gc.resolve(code, signal), { code: 'transient' });
  assert.deepEqual(s.statuses, [503]);
  await keepAlive;
  s.respondWith(() => ({ kind: 'failed', code: 'busy', eresult: 84 }));
  await assert.rejects(s.gc.resolve(code, signal), { code: 'busy' });
  assert.deepEqual(s.statuses, [503, 429]);
  assert.deepEqual(s.diagnostics, [
    { stage: 'login', reason: 'timeout', eresult: undefined },
    { stage: 'login', reason: 'busy', eresult: 84 },
  ]);
  assert.equal(s.counts().closed, 2);
});

test('Steam Guard and rejected credentials need operator intervention, unavailable replay preserves the login', async () => {
  for (const codeName of ['guard', 'guard_email', 'guard_mobile', 'credentials'] as const) {
    const s = mock();
    s.respondWith(() => ({ kind: 'failed', code: codeName }));
    for (let i = 0; i < 2; i++)
      await assert.rejects(s.gc.resolve(code, signal), { code: codeName });
    assert.deepEqual(s.commands, ['login']);
    assert.deepEqual(s.diagnostics, [{ stage: 'login', reason: codeName, eresult: undefined }]);
  }
  const s = mock();
  s.respondWith((c) =>
    c.kind === 'match' ? { kind: 'failed', code: 'unavailable' } : { kind: 'ok' },
  );
  await assert.rejects(s.gc.resolve(code, signal), { code: 'unavailable' });
  s.respondWith(() => ({ kind: 'ok', source: { ...source, matchId: '3' } }));
  await assert.rejects(s.gc.resolve(code, signal), { code: 'transient' });
  assert.deepEqual(s.commands, ['login', 'hello', 'match', 'match']);
  assert.equal(s.counts().closed, 1);
});

test('match list uses exact IDs, bounded recorded roster, optional map and explicit unavailability', () => {
  assert.equal(readMatch({ matches: [{ matchid: '1' }] }, request, 9147), undefined);
  assert.equal(readMatch({ msgrequestid: 9141, matches: [] }, request, 9147), undefined);
  assert.deepEqual(readMatch({ msgrequestid: 9147 }, request, 9147), {
    kind: 'failed',
    code: 'unavailable',
  });
  const round = {
    map: replay,
    reservationid: request.outcomeId,
    reservation: { match_id: request.matchId, account_ids: [21, 21] },
  };
  const row = {
    matchid: request.matchId,
    watchablematchinfo: { game_map: 'de_mirage' },
    roundstatsall: [{ ...round, reservationid: '3', reservation: { account_ids: [51] } }, round],
  };
  assert.deepEqual(readMatch({ matches: [row] }, request, 9147), {
    kind: 'ok',
    source: { ...source, map: 'de_mirage' },
  });
  assert.deepEqual(
    readMatch({ matches: [{ matchid: request.matchId, roundstats_legacy: round }] }, request, 9147),
    { kind: 'ok', source },
  );
  assert.deepEqual(
    readMatch(
      { matches: [{ ...row, roundstatsall: [{ ...round, map: 'de_mirage' }] }] },
      request,
      9147,
    ),
    { kind: 'failed', code: 'unavailable' },
  );
  assert.deepEqual(
    readMatch(
      { matches: [{ ...row, roundstatsall: [{ ...round, reservation: { account_ids: [-1] } }] }] },
      request,
      9147,
    ),
    { kind: 'failed', code: 'transient' },
  );
  assert.deepEqual([5, 63, 88, 93, 84, 3].map(steamFailure), [
    'credentials',
    'guard_email',
    'guard_mobile',
    'guard',
    'busy',
    'transient',
  ]);
});

test('installed GC wire codec and Steam application flow work offline with a synthetic transport', async () => {
  const require = createRequire(import.meta.url);
  const proto = require('globaloffensive/protobufs/generated/_load.js');
  const messages: Reply[] = [];
  const sent: { appId: number; type: number; bytes: Buffer }[] = [];
  class FakeSteam extends EventEmitter {
    async _doConnection() {
      assert.fail('unexpected connection');
    }
    logOn(details: { twoFactorCode?: string }) {
      assert.match(details.twoFactorCode ?? '', /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
      this.emit('loggedOn');
    }
    gamesPlayed(apps: number[]) {
      assert.deepEqual(apps, [730]);
      this.emit('appLaunched', 730);
    }
    sendToGC(appId: number, type: number, _header: object, bytes: Buffer) {
      sent.push({ appId, type, bytes });
    }
  }
  const client = new FakeSteam();
  const send = steamProtocol((reply) => messages.push(reply), client);
  send({
    kind: 'login',
    username: 'fixture',
    password: 'fixture',
    guardSecret: Buffer.alloc(20, 1).toString('base64'),
  });
  send({ kind: 'hello' });
  await delay(550);
  assert.deepEqual(
    sent.map((s) => [s.appId, s.type]),
    [[730, 4006]],
  );
  client.emit('receivedFromGC', 730, 4004, Buffer.alloc(0));
  send({ kind: 'match', request });
  const rpc = sent[1];
  assert.equal(rpc.type, 9147);
  const full = proto.CMsgGCCStrike15_v2_MatchListRequestFullGameInfo;
  assert.deepEqual(full.toObject(full.decode(rpc.bytes), { longs: String }), {
    matchid: request.matchId,
    outcomeid: request.outcomeId,
    token: request.token,
  });
  const response = proto.CMsgGCCStrike15_v2_MatchList.encode({
    msgrequestid: 9147,
    matches: [
      {
        matchid: request.matchId,
        roundstatsall: [
          { reservationid: request.outcomeId, map: replay, reservation: { account_ids: [21] } },
        ],
      },
    ],
  }).finish();
  client.emit('receivedFromGC', 440, 9139, response);
  assert.equal(messages.length, 2);
  client.emit('receivedFromGC', 730, 9139, response);
  assert.deepEqual(messages, [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok', source }]);
});

test('Steam Guard prompts report only the challenge method and discard account metadata', (t) => {
  const require = createRequire(import.meta.url);
  const SteamUser = require('steam-user');
  for (const [domain, expected] of [
    ['private.invalid', 'guard_email'],
    [null, 'guard_mobile'],
    [undefined, 'guard'],
  ] as const) {
    const client = new SteamUser({ dataDirectory: null });
    t.mock.method(client, 'logOn', () =>
      client.emit('steamGuard', domain, () => assert.fail(), false),
    );
    const replies: Reply[] = [];
    const send = steamProtocol((reply) => replies.push(reply), client);
    send({ kind: 'login', username: 'fixture', password: 'fixture' });
    assert.deepEqual(replies, [{ kind: 'failed', code: expected }]);
  }
});

test('SDK sign-in errors pass only a bounded numeric Steam result into diagnostics', (t) => {
  const require = createRequire(import.meta.url);
  const SteamUser = require('steam-user');
  for (const result of [5, 'private.invalid', -1, 100000]) {
    const client = new SteamUser({ dataDirectory: null });
    t.mock.method(client, 'logOn', () =>
      client.emit('error', {
        eresult: result,
        message: 'sensitive SDK details',
        accountName: 'fixture',
      }),
    );
    const replies: Reply[] = [];
    steamProtocol(
      (reply) => replies.push(reply),
      client,
    )({ kind: 'login', username: 'fixture', password: 'fixture' });
    assert.deepEqual(replies, [
      result === 5
        ? { kind: 'failed', code: 'credentials', eresult: 5 }
        : { kind: 'failed', code: 'transient' },
    ]);
  }
});

test('real worker loads pinned packages offline and closes after an out-of-order command', async () => {
  const worker = new Worker(new URL('../src/steam-coordinator-worker.ts', import.meta.url), {
    env: {},
    execArgv: ['--experimental-strip-types'],
    stdout: true,
    stderr: true,
  });
  try {
    const received = once(worker, 'message', { signal: AbortSignal.timeout(5000) });
    worker.postMessage({ kind: 'hello' });
    assert.deepEqual((await received)[0], { kind: 'failed', code: 'transient' });
  } finally {
    await worker.terminate();
  }
});

test('idle disconnect and shutdown cancel active work and discard the previous session', async () => {
  const s = mock(cfg, 500, 10);
  await s.gc.resolve(code, signal);
  await delay(35);
  assert.equal(s.counts().closed, 1);
  await s.gc.resolve(code, signal);
  s.unsolicited({ kind: 'failed', code: 'transient' });
  assert.equal(s.counts().closed, 2);
  await s.gc.resolve(code, signal);
  s.respondWith(() => undefined);
  const work = s.gc.resolve(code, signal);
  await delay(1);
  await s.gc.close();
  await assert.rejects(work, { code: 'transient' });
  assert.deepEqual(s.counts(), { opened: 3, closed: 3, admitted: 10 });
});

test('cache reuses exact source and no-demo replies with independent roster copies, expiry and cancellation', async () => {
  const s = mock(cfg, 300, 60_000, 25);
  s.respondWith((c) =>
    c.kind === 'match' ? { kind: 'ok', source: structuredClone(source) } : { kind: 'ok' },
  );
  const first = await s.gc.resolve(code, signal);
  first.accountIds = [999];
  assert.deepEqual((await s.gc.resolve(code, signal)).accountIds, [21]);
  (await s.gc.resolve(code, signal)).accountIds.push(999);
  assert.deepEqual((await s.gc.resolve(code, signal)).accountIds, [21]);
  await assert.rejects(s.gc.resolve(code, AbortSignal.abort()), { code: 'transient' });
  assert.deepEqual(s.commands, ['login', 'hello', 'match']);
  await delay(35);
  s.respondWith(() => ({ kind: 'failed', code: 'unavailable' }));
  for (let i = 0; i < 2; i++)
    await assert.rejects(s.gc.resolve(code, signal), { code: 'unavailable' });
  assert.equal(s.commands.length, 4);
  await delay(35);
  await assert.rejects(s.gc.resolve(code, signal), { code: 'unavailable' });
  assert.equal(s.commands.length, 5);
  await s.gc.close();
  await assert.rejects(s.gc.resolve(code, signal), { code: 'disabled' });
});

test('cache evicts the oldest of 64 distinct tuples, including codes differing only by token', async () => {
  const s = mock(cfg, 300, 60_000, 120_000);
  const alphabet = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
  function withToken(token: number) {
    const bytes = Buffer.alloc(18);
    bytes.writeBigUInt64LE(BigInt(request.matchId));
    bytes.writeBigUInt64LE(BigInt(request.outcomeId), 8);
    bytes.writeUInt16LE(token, 16);
    let n = BigInt('0x' + bytes.toString('hex'));
    let text = '';
    for (let i = 0; i < 25; i++) {
      text += alphabet[Number(n % 57n)];
      n /= 57n;
    }
    return 'CSGO-' + text.match(/.{5}/g)!.join('-');
  }
  s.respondWith((c) =>
    c.kind === 'match'
      ? { kind: 'ok', source: { ...c.request, url: replay, accountIds: [21] } }
      : { kind: 'ok' },
  );
  for (let i = 0; i < 65; i++) assert.equal((await s.gc.resolve(withToken(i), signal)).token, i);
  assert.equal(s.commands.length, 67);
  await s.gc.resolve(withToken(1), signal);
  assert.equal(s.commands.length, 67);
  await s.gc.resolve(withToken(0), signal);
  assert.equal(s.commands.length, 68);
  await s.gc.close();
});

test('production SDK starts exactly one directory request and cannot retry login outside admission', async (t) => {
  const require = createRequire(import.meta.url);
  const SteamUser = require('steam-user');
  const directory = t.mock.method(
    SteamUser.prototype,
    '_apiRequest',
    async (method: string, api: string, name: string) => {
      assert.deepEqual([method, api, name], ['GET', 'ISteamDirectory', 'GetCMListForConnect']);
      throw new Error('offline synthetic directory failure');
    },
  );
  const { promise, resolve } = Promise.withResolvers<Reply>();
  const send = steamProtocol(resolve);
  send({ kind: 'login', username: 'fixture', password: 'fixture' });
  // The SDK schedules its own directory retry one second after failure. The
  // adapter intercepts that second connection attempt before any network call.
  assert.deepEqual(await promise, { kind: 'failed', code: 'transient' });
  assert.equal(directory.mock.callCount(), 1);
});

test('successful cold logins preserve match outage backoff until a definitive match response', async () => {
  const s = mock();
  s.respondWith((c) =>
    c.kind === 'match' ? { kind: 'failed', code: 'transient' } : { kind: 'ok' },
  );
  for (let i = 0; i < 2; i++)
    await assert.rejects(s.gc.resolve(code, signal), { code: 'transient' });
  assert.deepEqual(s.commands, ['login', 'hello', 'match', 'login', 'hello', 'match']);
  assert.deepEqual(s.statuses, [503, 503]);
  s.respondWith((c) =>
    c.kind === 'match' ? { kind: 'failed', code: 'unavailable' } : { kind: 'ok' },
  );
  await assert.rejects(s.gc.resolve(code, signal), { code: 'unavailable' });
  assert.deepEqual(s.statuses, [503, 503, 200]);
  s.respondWith(() => ({ kind: 'ok', source }));
  await s.gc.resolve(code, signal);
  assert.deepEqual(s.statuses, [503, 503, 200, 200]);
  await s.gc.close();
});
