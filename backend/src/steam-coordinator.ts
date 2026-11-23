import { Worker } from 'node:worker_threads';
import type { Config } from './config.js';
import type { ProviderRequests } from './provider-requests.js';
import { decodeSteamShareCode } from './steam-share-code.js';

export type MatchRequest = { matchId: string; outcomeId: string; token: number };
export type SteamReplaySource = MatchRequest & { url: string; accountIds: number[]; map?: string };
type LoginBlock = 'credentials' | 'guard' | 'guard_email' | 'guard_mobile';
export type SteamCoordinatorCode = 'disabled' | 'unavailable' | 'transient' | 'busy' | LoginBlock;

export class SteamCoordinatorError extends Error {
  constructor(readonly code: SteamCoordinatorCode) {
    super('Steam coordinator: ' + code);
  }
}

type Settings = Pick<
  Config,
  | 'steamCoordinatorEnabled'
  | 'steamCoordinatorUsername'
  | 'steamCoordinatorPassword'
  | 'steamCoordinatorGuardSecret'
>;
export type Command =
  | { kind: 'login'; username: string; password: string; guardSecret?: string }
  | { kind: 'hello' }
  | { kind: 'match'; request: MatchRequest };
export type Reply =
  | { kind: 'ok'; source?: SteamReplaySource }
  | { kind: 'failed'; code: Exclude<SteamCoordinatorCode, 'disabled'> };

interface Transport {
  send(command: Command): void;
  close(): Promise<void>;
}
type Start = (receive: (reply: Reply) => void) => Transport;

function startWorker(receive: (reply: Reply) => void): Transport {
  // The SDK has asynchronous login callbacks and socket timers. Terminating its
  // worker cancels all of them, including after an interrupted first login.
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL('./steam-coordinator-worker.' + extension, import.meta.url), {
    env: {},
    execArgv: extension === 'ts' ? ['--experimental-strip-types'] : [],
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  worker.stdout.resume();
  worker.stderr.resume();
  worker.on('message', receive);
  const failed = () => receive({ kind: 'failed', code: 'transient' });
  worker.on('error', failed);
  worker.once('exit', failed);
  return {
    send: (command) => worker.postMessage(command),
    close: async () => {
      await worker.terminate();
    },
  };
}

export interface SteamCoordinator {
  resolve(code: string, signal: AbortSignal): Promise<SteamReplaySource>;
  close(): Promise<void>;
}

export function createSteamCoordinator(
  config: Settings,
  limiter: Pick<ProviderRequests, 'run'>,
  {
    start = startWorker,
    onLoginBlocked,
    loginTimeout = 25_000,
    requestTimeout = 12_000,
    idleTimeout = 300_000,
    cacheTtl = 120_000,
  }: {
    start?: Start;
    onLoginBlocked?: (reason: LoginBlock) => void;
    loginTimeout?: number;
    requestTimeout?: number;
    idleTimeout?: number;
    cacheTtl?: number;
  } = {},
): SteamCoordinator {
  let session: Transport | undefined;
  let phase: 'new' | 'online' | 'ready' = 'new';
  let stopping: Promise<void> = Promise.resolve();
  let idle: NodeJS.Timeout | undefined;
  let pending: ((reply: Reply) => void) | undefined;
  let locked: LoginBlock | undefined;
  let active = false;
  const shutdown = new AbortController();
  const cache = new Map<
    string,
    { source?: SteamReplaySource; until: number; timer: NodeJS.Timeout }
  >();

  function forget(code: string) {
    clearTimeout(cache.get(code)?.timer);
    cache.delete(code);
  }

  function remember(code: string, source?: SteamReplaySource) {
    if (cacheTtl <= 0) return;
    if (cache.size >= 64) forget(cache.keys().next().value!);
    cache.set(code, {
      source: source && structuredClone(source),
      until: Date.now() + cacheTtl,
      timer: setTimeout(() => forget(code), cacheTtl).unref(),
    });
  }

  function retire() {
    clearTimeout(idle);
    const old = session;
    session = undefined;
    phase = 'new';
    if (old) stopping = old.close();
    return stopping;
  }

  function exchange(
    command: Extract<Command, { kind: 'match' }>,
    external: AbortSignal,
  ): Promise<SteamReplaySource>;
  function exchange(
    command: Exclude<Command, { kind: 'match' }>,
    external: AbortSignal,
  ): Promise<void>;
  function exchange(command: Command, external: AbortSignal): Promise<SteamReplaySource | void> {
    return limiter.run('steamGc', async (report) => {
      const signal = AbortSignal.any([
        external,
        shutdown.signal,
        AbortSignal.timeout(command.kind === 'login' ? loginTimeout : requestTimeout),
      ]);
      if (signal.aborted) throw new SteamCoordinatorError('transient');
      if (!session) {
        const started: Transport = start((reply) => {
          if (session !== started) return;
          if (pending) pending(reply);
          else if (reply.kind === 'failed') void retire();
        });
        session = started;
      }
      const reply = await new Promise<Reply>((resolve) => {
        const cancel = () => finish({ kind: 'failed', code: 'transient' });
        const finish = (reply: Reply) => {
          signal.removeEventListener('abort', cancel);
          pending = undefined;
          resolve(reply);
        };
        pending = finish;
        signal.addEventListener('abort', cancel, { once: true });
        try {
          session!.send(command);
        } catch {
          cancel();
        }
      });
      if (reply.kind === 'failed') {
        if (reply.code !== 'unavailable') await retire();
        switch (reply.code) {
          case 'busy':
          case 'transient':
            if (!external.aborted && !shutdown.signal.aborted)
              report(reply.code === 'busy' ? 429 : 503);
            break;
          case 'unavailable':
            if (command.kind === 'match' && !external.aborted && !shutdown.signal.aborted)
              report(200);
            break;
          default:
            locked = reply.code;
            onLoginBlocked?.(locked);
        }
        throw new SteamCoordinatorError(reply.code);
      }
      // A cold login and handshake may both succeed during a persistent
      // match-service outage. Only a complete answer establishes recovery.
      if (command.kind !== 'match') return;
      const source = reply.source;
      if (
        !source ||
        source.matchId !== command.request.matchId ||
        source.outcomeId !== command.request.outcomeId ||
        source.token !== command.request.token
      ) {
        await retire();
        report(503);
        throw new SteamCoordinatorError('transient');
      }
      report(200);
      return source;
    });
  }

  return {
    async resolve(code, signal) {
      if (!config.steamCoordinatorEnabled || shutdown.signal.aborted)
        throw new SteamCoordinatorError('disabled');
      if (signal.aborted) throw new SteamCoordinatorError('transient');
      if (locked) throw new SteamCoordinatorError(locked);
      const ids = decodeSteamShareCode(code);
      if (!ids) throw new SteamCoordinatorError('unavailable');
      const cached = cache.get(code);
      if (cached && cached.until > Date.now()) {
        if (!cached.source) throw new SteamCoordinatorError('unavailable');
        return structuredClone(cached.source);
      }
      if (cached) forget(code);
      if (active) throw new SteamCoordinatorError('busy');
      const request = { matchId: ids.match_id, outcomeId: ids.outcome_id, token: ids.token };
      active = true;
      clearTimeout(idle);
      try {
        await stopping;
        if (phase === 'new') {
          await exchange(
            {
              kind: 'login',
              username: config.steamCoordinatorUsername,
              password: config.steamCoordinatorPassword,
              guardSecret: config.steamCoordinatorGuardSecret,
            },
            signal,
          );
          phase = 'online';
        }
        if (phase === 'online') {
          await exchange({ kind: 'hello' }, signal);
          phase = 'ready';
        }
        const source = await exchange({ kind: 'match', request }, signal).catch((error) => {
          if (
            !signal.aborted &&
            !shutdown.signal.aborted &&
            error instanceof SteamCoordinatorError &&
            error.code === 'unavailable'
          )
            remember(code);
          throw error;
        });
        if (signal.aborted || shutdown.signal.aborted) throw new SteamCoordinatorError('transient');
        remember(code, source);
        return source;
      } finally {
        active = false;
        if (session)
          idle = setTimeout(() => {
            void retire();
          }, idleTimeout).unref();
      }
    },
    async close() {
      shutdown.abort();
      for (const code of cache.keys()) forget(code);
      await retire();
    },
  };
}
