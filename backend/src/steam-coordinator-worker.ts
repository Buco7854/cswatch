import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import type { EventEmitter } from 'node:events';
import type { Command, MatchRequest, Reply, SteamReplaySource } from './steam-coordinator.js';

type Round = {
  map?: string;
  reservationid?: string;
  reservation?: { account_ids?: number[]; match_id?: string };
};
type Match = {
  matchid?: string;
  roundstatsall?: Round[];
  roundstats_legacy?: Round;
  watchablematchinfo?: { game_map?: string };
};
type MatchList = { msgrequestid?: number; matches?: Match[] };

// 64-bit fields are converted to decimal strings by the pinned decoder.
// Steam uses the final round's map field for the replay URL.
export function readMatch(
  list: MatchList,
  request: MatchRequest,
  fullGameMessage: number,
): Reply | undefined {
  if (list.msgrequestid !== undefined && list.msgrequestid !== fullGameMessage) return;
  const matches = list.matches ?? [];
  if (!matches.length && list.msgrequestid === fullGameMessage)
    return { kind: 'failed', code: 'unavailable' };
  const match = matches.find((row) => row.matchid === request.matchId);
  if (!match) return;
  const rounds = [...(match.roundstatsall ?? [])];
  if (match.roundstats_legacy) rounds.unshift(match.roundstats_legacy);
  const eligible = rounds.filter(
    (r) =>
      (!r.reservationid || r.reservationid === request.outcomeId) &&
      (!r.reservation?.match_id || r.reservation.match_id === request.matchId),
  );
  const final = eligible.findLast(
    (r) => typeof r.map === 'string' && r.map.length <= 2048 && /^https?:\/\//i.test(r.map),
  );
  if (!final?.map) return { kind: 'failed', code: 'unavailable' };
  const roster = new Set<number>();
  for (const round of eligible) {
    if (round !== final && round.reservationid !== request.outcomeId) continue;
    const ids = round.reservation?.account_ids ?? [];
    if (ids.length > 64 || ids.some((id) => !Number.isInteger(id) || id < 0 || id > 0xffff_ffff))
      return { kind: 'failed', code: 'transient' };
    for (const id of ids) if (id > 0) roster.add(id);
    if (roster.size > 64) return { kind: 'failed', code: 'transient' };
  }
  const source: SteamReplaySource = { ...request, url: final.map, accountIds: [...roster] };
  const map = match.watchablematchinfo?.game_map;
  if (typeof map === 'string' && /^[a-z0-9_]{1,64}$/.test(map)) source.map = map;
  return { kind: 'ok', source };
}

interface SteamClient extends EventEmitter {
  logOn(details: { accountName: string; password: string; twoFactorCode?: string }): void;
  gamesPlayed(apps: number[]): void;
  sendToGC(appId: number, message: number, header: object, bytes: Uint8Array): void;
  _doConnection(): Promise<void>;
}
interface Protobuf {
  encode(body: object): { finish(): Uint8Array };
  decode(body: Buffer): object;
  toObject(value: object, options: { longs: typeof String }): object;
}
export function steamFailure(result?: number): Extract<Reply, { kind: 'failed' }>['code'] {
  if ([5, 15, 17, 18, 43, 73, 114].includes(result ?? 0)) return 'credentials';
  if ([63, 65, 66, 71, 74].includes(result ?? 0)) return 'guard_email';
  if ([85, 88].includes(result ?? 0)) return 'guard_mobile';
  if (result === 93) return 'guard';
  if ([25, 84, 87, 96].includes(result ?? 0)) return 'busy';
  return 'transient';
}

// Export the actual adapter so its network-free construction and event handling
// can be exercised with synthetic Steam messages and the installed wire codecs.
export function steamProtocol(reply: (message: Reply) => void, inject?: SteamClient) {
  const require = createRequire(import.meta.url);
  const SteamUser: new (options: object) => SteamClient = require('steam-user');
  const language: Record<string, number> = require('globaloffensive/language.js');
  const schemas: Record<string, Protobuf> = require('globaloffensive/protobufs/generated/_load.js');
  const totp: { generateAuthCode(secret: string): string } = require('steam-totp');
  let state: 'new' | 'login' | 'online' | 'hello' | 'ready' | 'match' | 'dead' = 'new';
  let requested: MatchRequest | undefined;

  function fail(code: Extract<Reply, { kind: 'failed' }>['code'] = 'transient') {
    if (state === 'dead') return;
    state = 'dead';
    reply({ kind: 'failed', code });
  }
  // steam-user 5.3.0 also retries during first login, independently of
  // autoRelogin. Suppress these retries and the unsolicited web-cookie login.
  class SingleLogin extends SteamUser {
    private connectedOnce = false;
    override async _doConnection() {
      if (this.connectedOnce) return fail();
      this.connectedOnce = true;
      await super._doConnection();
    }
    _enqueueLogonAttempt() {
      fail();
    }
    webLogOn() {}
  }
  const client =
    inject ??
    new SingleLogin({
      dataDirectory: null,
      autoRelogin: false,
      webCompatibilityMode: true,
      enablePicsCache: false,
      saveAppTickets: false,
      changelistUpdateInterval: 0,
    });

  client.on('error', (error: { eresult?: number }) => fail(steamFailure(error?.eresult)));
  client.on('disconnected', (result: number) => fail(steamFailure(result)));
  // The SDK identifies an email challenge by its domain. Only pass on the method.
  client.on('steamGuard', (domain?: string | null) => {
    if (domain === null) return fail('guard_mobile');
    fail(domain ? 'guard_email' : 'guard');
  });
  client.on('loggedOn', () => {
    if (state !== 'login') return;
    state = 'online';
    reply({ kind: 'ok' });
  });
  client.on('appLaunched', (appId: number) => {
    if (appId !== 730 || state !== 'hello') return;
    // Same handshake and version as the pinned CS2 client implementation.
    setTimeout(() => {
      if (state === 'hello')
        client.sendToGC(
          730,
          language.ClientHello,
          {},
          schemas.CMsgClientHello.encode({
            version: 2000244,
            client_session_need: 0,
            client_launcher: 0,
            steam_launcher: 0,
          }).finish(),
        );
    }, 500);
  });
  client.on('receivedFromGC', (appId: number, message: number, bytes: Buffer) => {
    if (appId !== 730 || state === 'dead') return;
    if (message === language.ClientLogonFatalError) return fail();
    if (message === language.ClientWelcome && state === 'hello') {
      state = 'ready';
      return reply({ kind: 'ok' });
    }
    if (message === language.ClientConnectionStatus && (state === 'ready' || state === 'match')) {
      const { status } = schemas.CMsgConnectionStatus.decode(bytes) as { status?: number };
      if (status !== 0) fail();
      return;
    }
    if (message !== language.MatchList || state !== 'match' || !requested) return;
    if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024) return fail();
    const proto = schemas.CMsgGCCStrike15_v2_MatchList;
    const list = proto.toObject(proto.decode(bytes), { longs: String }) as MatchList;
    const result = readMatch(list, requested, language.MatchListRequestFullGameInfo);
    if (result) {
      state = 'ready';
      requested = undefined;
      reply(result);
    }
  });
  return (command: Command) => {
    if (command.kind === 'login' && state === 'new') {
      state = 'login';
      const twoFactorCode = command.guardSecret
        ? totp.generateAuthCode(command.guardSecret)
        : undefined;
      client.logOn({ accountName: command.username, password: command.password, twoFactorCode });
    } else if (command.kind === 'hello' && state === 'online') {
      state = 'hello';
      client.gamesPlayed([730]);
    } else if (command.kind === 'match' && state === 'ready') {
      state = 'match';
      requested = command.request;
      client.sendToGC(
        730,
        language.MatchListRequestFullGameInfo,
        {},
        schemas.CMsgGCCStrike15_v2_MatchListRequestFullGameInfo.encode({
          matchid: requested.matchId,
          outcomeid: requested.outcomeId,
          token: requested.token,
        }).finish(),
      );
    } else fail();
  };
}

if (parentPort) {
  const port = parentPort;
  port.on(
    'message',
    steamProtocol((message) => port.postMessage(message)),
  );
}
