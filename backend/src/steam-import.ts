import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emailDeliveryEnabled, type Config } from './config.js';
import type { Store } from './db.js';
import { HttpError } from './errors.js';
import { abandonUpload, reserve, validateMagic } from './ingestion.js';
import type { ProviderRequests } from './provider-requests.js';
import { downloadSteamReplay, validateSteamReplayUrl } from './remote-download.js';
import { rateLimit, requireSession, requireUser } from './security.js';
import { activeSteamImportGrant, type SteamImportBinding } from './steam-auto-import.js';
import { SteamCoordinatorError, type SteamCoordinator } from './steam-coordinator.js';
import { decodeSteamShareCode } from './steam-share-code.js';

const importBody = z.object({ match_id: z.string().regex(/^[1-9]\d{0,19}$/) }).strict();
const changed = () =>
  new HttpError(409, 'The Steam connection changed. Try again.', undefined, 'steam_import_changed');
const unavailable = () =>
  new HttpError(
    503,
    'Steam server imports are unavailable. Open CS2 or upload the demo file.',
    undefined,
    'steam_coordinator_setup',
  );
const unconfirmed = () => new HttpError(502, 'Steam could not confirm the replay for this match.');

function coordinatorFailure(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof SteamCoordinatorError) {
    switch (error.code) {
      case 'unavailable':
        throw new HttpError(
          404,
          'The demo download is unavailable or has expired. Try again or upload manually.',
          undefined,
          'steam_no_demo',
        );
      case 'guard':
      case 'disabled':
      case 'credentials':
        throw unavailable();
      case 'busy':
        throw new HttpError(429, 'Too many requests. Try again later.', 5);
    }
  }
  throw new HttpError(
    503,
    'Steam is temporarily unavailable or limiting requests. Try again later.',
  );
}

export function steamImportRoutes(
  app: FastifyInstance,
  db: Store,
  c: Config,
  coordinator: SteamCoordinator,
  limiter: ProviderRequests,
  download = downloadSteamReplay,
) {
  function savedMatch(owner: string, matchId: string) {
    if (!c.steamCoordinatorEnabled || !c.steamApiKey || !db.flag(c, 'steam_enabled'))
      throw unavailable();
    return db.one(
      `SELECT m.code,h.generation,h.steam_id FROM steam_matches m
       JOIN steam_history h ON h.user_id=m.user_id AND h.needs_codes=0
       JOIN identities i ON i.user_id=h.user_id AND i.provider='steam' AND i.subject=h.steam_id
       JOIN users u ON u.id=h.user_id AND u.profile_required=0
       WHERE m.user_id=? AND m.match_id=?
       AND (u.email_verification_required=0 OR u.email_verified_at IS NOT NULL OR ?=0)`,
      owner,
      matchId,
      Number(emailDeliveryEnabled(db, c)),
    );
  }

  async function importMatch(
    owner: string,
    matchId: string,
    authorize: () => void,
    authoritySignal: AbortSignal,
  ) {
    authorize();
    const saved = savedMatch(owner, matchId);
    if (!saved) throw new HttpError(404, 'This Steam match is no longer in your history.');
    const decoded = decodeSteamShareCode(saved.code);
    if (!decoded || decoded.match_id !== matchId) throw unconfirmed();
    const { code, steam_id: steamId, generation } = saved;
    function revalidate() {
      authorize();
      if (authoritySignal.aborted) throw changed();
      const live = savedMatch(owner, matchId);
      if (
        !live ||
        live.code !== code ||
        live.steam_id !== steamId ||
        live.generation !== generation
      )
        throw changed();
    }
    const ref = 'steam:' + matchId;
    const { id, folder, writeExpiresAt } = reserve(
      db,
      c,
      owner,
      'Steam ' + matchId,
      'steam',
      null,
      ref,
      revalidate,
    );
    const signal = AbortSignal.any([
      authoritySignal,
      AbortSignal.timeout(Math.max(1, Math.min(210000, writeExpiresAt - Date.now()))),
    ]);
    function checkReservation() {
      revalidate();
      if (signal.aborted || Date.now() >= writeExpiresAt)
        throw new HttpError(408, 'The demo import could not be completed. Try again.');
      if (
        !db.one(
          "SELECT 1 FROM demos WHERE id=? AND owner_id=? AND source_ref=? AND status='uploading'",
          id,
          owner,
          ref,
        )
      )
        throw changed();
    }
    try {
      const source = await coordinator.resolve(code, signal).catch(coordinatorFailure);
      checkReservation();
      if (
        source.matchId !== matchId ||
        source.outcomeId !== decoded.outcome_id ||
        source.token !== decoded.token
      )
        throw unconfirmed();
      const accountId = /^\d{17}$/.test(steamId) ? Number(BigInt(steamId) - 76561197960265728n) : 0;
      if (accountId < 1 || accountId > 0xffffffff || !source.accountIds.includes(accountId))
        throw new HttpError(
          403,
          'Steam could not confirm you played in this match.',
          undefined,
          'steam_not_participant',
        );
      validateSteamReplayUrl(source.url, decoded);
      const path = join(folder, 'input.bz2');
      const { bytes } = await limiter.run('steamFiles', async (report) => {
        checkReservation();
        return download(source.url, path, {
          expected: decoded,
          maxBytes: c.maxUploadMb * 1024 ** 2,
          signal,
          onNetworkFailure: () => report(503),
          onResponse(status, retryAfter) {
            report(status, retryAfter);
            checkReservation();
          },
        });
      });
      db.transaction(() => {
        checkReservation();
        validateMagic(path, '.bz2');
        db.run("UPDATE demos SET status='queued',size=? WHERE id=?", bytes, id);
      });
      return { id };
    } catch (error) {
      // Discard any remote result that arrived after this owner lost authority.
      try {
        checkReservation();
      } finally {
        abandonUpload(db, id);
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        'Steam returned an invalid response or could not be reached. Try again later.',
      );
    }
  }

  app.post('/api/connections/steam/import', async (r, reply) => {
    const user = requireUser(r);
    const { match_id } = importBody.parse(r.body);
    rateLimit(db, r, 'steam-import', 10, 3600, user.id);
    // The request body is already consumed. Watch the response socket for a
    // caller leaving during the coordinator lookup or file transfer.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    reply.raw.once('close', cancel);
    try {
      const result = await importMatch(
        user.id,
        match_id,
        () => {
          requireSession(db, r, c, ['full']);
        },
        controller.signal,
      );
      reply.code(202);
      return result;
    } finally {
      reply.raw.off('close', cancel);
    }
  });

  return {
    importAutomatic(
      owner: string,
      matchId: string,
      binding: SteamImportBinding,
      signal: AbortSignal,
    ) {
      return importMatch(
        owner,
        matchId,
        () => {
          if (!activeSteamImportGrant(db, c, owner, binding)) throw changed();
        },
        signal,
      );
    },
  };
}
