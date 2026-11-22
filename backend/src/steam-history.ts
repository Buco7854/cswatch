import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { now, type Store } from './db.js';
import { currentUser, HttpError, rateLimit, requireUser, token } from './security.js';
import { decodeSteamShareCode } from './steam-share-code.js';
import { readUpstreamJson, requestJson } from './upstream.js';

const gameCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{4}$/);
const knownCode = z
  .string()
  .trim()
  .max(34)
  .refine((code) => decodeSteamShareCode(code) !== null);
const matchLimit = 500;
const pageSize = 25;
const syncSteps = 5;
const backoffKey = 'steam_history_retry_at';

function readKey(path: string) {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 65)
        throw new Error();
      const bytes = Buffer.alloc(66);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      const contents = bytes.toString('utf8', 0, length);
      if (!/^[a-fA-F0-9]{64}\n?$/.test(contents)) throw new Error();
      return Buffer.from(contents.trim(), 'hex');
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new HttpError(503, 'Steam sync storage is unavailable. Contact the administrator.');
  }
}

function seal(key: Buffer, binding: string, code: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  const bytes = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
}

function unseal(key: Buffer, binding: string, sealed: Uint8Array) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return gameCode.parse(
      Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8'),
    );
  } catch {
    throw new HttpError(409, 'The saved Steam code cannot be read. Verify and save it again.');
  }
}

function retryAt(db: Store) {
  return Number(db.one('SELECT value FROM settings WHERE key=?', backoffKey)?.value ?? 0);
}

async function nextCode(
  c: Config,
  db: Store,
  request: FastifyRequest,
  subject: string,
  authCode: string,
  cursor: string,
  signal: AbortSignal,
) {
  if (retryAt(db) > now())
    throw new HttpError(429, 'Steam match discovery is cooling down. Try again later.');
  rateLimit(db, request, 'steam-api-budget', 90000, 86400, 'instance');
  return requestJson(
    'https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/?' +
      new URLSearchParams({
        key: c.steamApiKey,
        steamid: subject,
        steamidkey: authCode,
        knowncode: cursor,
      }),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
    'Steam returned an invalid response or could not be reached. Try again later.',
    async (response) => {
      if (response.status === 429 || response.status === 503) {
        const header = response.headers.get('retry-after') || '';
        const delay = /^\d+$/.test(header) ? Number(header) : Date.parse(header) / 1000 - now();
        const retry =
          now() + Math.ceil(Math.min(3600, Math.max(60, Number.isFinite(delay) ? delay : 60)));
        db.run(
          'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)',
          backoffKey,
          retry,
        );
        throw response.status === 429
          ? new HttpError(429, 'Steam is rate limiting requests. Try again later.')
          : new HttpError(
              503,
              'Steam is temporarily unavailable or limiting requests. Try again later.',
            );
      }
      switch (response.status) {
        case 202:
        case 200: {
          const result = z
            .object({ result: z.object({ nextcode: z.union([knownCode, z.literal('n/a')]) }) })
            .parse(await readUpstreamJson(response, 16384));
          const next = result.result.nextcode;
          if (next === cursor || (response.status === 202 && next !== 'n/a')) throw new Error();
          return next === 'n/a' ? null : next;
        }
        case 403:
          throw new HttpError(
            403,
            'Steam denied access. Check or replace your game authentication code. If it still fails, ask the administrator to check the Steam Web API key.',
          );
        case 412:
          throw new HttpError(400, 'Use a recent match sharing code from this Steam account.');
        case 504:
          throw new HttpError(504, 'Steam timed out while looking for matches. Try again later.');
        default:
          throw new HttpError(502, 'Steam match discovery failed. Try again later.');
      }
    },
  );
}

export function steamHistoryRoutes(app: FastifyInstance, db: Store, c: Config) {
  const inFlight = new Map<string, AbortController>();
  const configured = () => {
    if (!db.flag(c, 'steam_enabled')) throw new HttpError(403, 'Steam sign-in is disabled.');
    if (!c.steamApiKey || !c.steamSyncKeyFile)
      throw new HttpError(503, 'The administrator must configure Steam match sync.');
  };
  const subjectFor = (userId: string): string | undefined =>
    db.one("SELECT subject FROM identities WHERE user_id=? AND provider='steam'", userId)?.subject;
  const saved = (userId: string) => db.one('SELECT * FROM steam_history WHERE user_id=?', userId);
  function begin(r: FastifyRequest) {
    const user = requireUser(r);
    configured();
    const subject = subjectFor(user.id);
    if (!subject) throw new HttpError(400, 'Link Steam first.');
    rateLimit(db, r, 'steam-history', 12, 900, user.id);
    if (inFlight.has(user.id)) throw new HttpError(409, 'Steam match sync is already running.');
    const operation = new AbortController();
    inFlight.set(user.id, operation);
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(25000)]);
    return {
      userId: user.id,
      subject,
      binding: `cswatch:steam-history:1:${user.id}:${subject}`,
      signal,
      revalidate() {
        const live = currentUser(db, r, c);
        if (!live || live.id !== user.id || live.csrf !== user.csrf)
          throw new HttpError(401, 'Session expired. Refresh the page and try again.');
        configured();
        if (operation.signal.aborted || subjectFor(user.id) !== subject)
          throw new HttpError(409, 'The Steam connection changed. Try again.');
      },
      end() {
        inFlight.delete(user.id);
      },
    };
  }
  function addMatch(userId: string, code: string) {
    const decoded = decodeSteamShareCode(code)!;
    db.run(
      'INSERT INTO steam_matches(user_id,match_id,code) VALUES(?,?,?) ON CONFLICT(user_id,match_id) DO UPDATE SET code=excluded.code',
      userId,
      decoded.match_id,
      code,
    );
    db.run(
      'DELETE FROM steam_matches WHERE user_id=? AND seq <= coalesce((SELECT seq FROM steam_matches WHERE user_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?),0)',
      userId,
      userId,
      matchLimit,
    );
  }
  app.get('/api/connections/steam/matches', async (r) => {
    const user = requireUser(r);
    rateLimit(db, r, 'steam-history-read', 60, 900, user.id);
    const { offset } = z
      .object({ offset: z.coerce.number().int().min(0).max(matchLimit).default(0) })
      .parse(r.query);
    const rows = db.all(
      `SELECT m.code,(SELECT id FROM demos WHERE owner_id=m.user_id AND source_ref='steam:'||m.match_id
        AND status IN ('queued','processing','ready') ORDER BY created_at DESC LIMIT 1) AS demo_id
       FROM steam_matches m WHERE m.user_id=? ORDER BY m.seq DESC LIMIT ? OFFSET ?`,
      user.id,
      pageSize + 1,
      offset,
    );
    const connection = saved(user.id);
    return {
      configured: Boolean(connection),
      needs_codes: Boolean(connection?.needs_codes),
      retry_at: retryAt(db),
      next_offset: rows.length > pageSize ? offset + pageSize : null,
      items: rows.slice(0, pageSize).map((row) => ({
        ...decodeSteamShareCode(row.code)!,
        share_code: row.code,
        demo_id: row.demo_id,
      })),
    };
  });
  app.put('/api/connections/steam/history', async (r) => {
    const body = z.object({ auth_code: gameCode, share_code: knownCode }).strict().parse(r.body);
    const operation = begin(r);
    try {
      const key = readKey(c.steamSyncKeyFile);
      const next = await nextCode(
        c,
        db,
        r,
        operation.subject,
        body.auth_code,
        body.share_code,
        operation.signal,
      );
      const encrypted = seal(key, operation.binding, body.auth_code);
      db.transaction(() => {
        operation.revalidate();
        const prior = saved(operation.userId);
        if (prior && prior.steam_id !== operation.subject)
          db.run('DELETE FROM steam_matches WHERE user_id=?', operation.userId);
        db.run(
          `INSERT INTO steam_history(user_id,steam_id,encrypted_code,cursor,generation) VALUES(?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET steam_id=excluded.steam_id,encrypted_code=excluded.encrypted_code,
           cursor=excluded.cursor,generation=excluded.generation,needs_codes=0`,
          operation.userId,
          operation.subject,
          encrypted,
          next ?? body.share_code,
          token(),
        );
        addMatch(operation.userId, body.share_code);
        if (next) addMatch(operation.userId, next);
      });
      return { up_to_date: next === null };
    } finally {
      operation.end();
    }
  });
  app.post('/api/connections/steam/history/sync', async (r) => {
    const operation = begin(r);
    try {
      const row = saved(operation.userId);
      if (!row || row.steam_id !== operation.subject)
        throw new HttpError(400, 'Verify and save your Steam match codes first.');
      if (row.needs_codes)
        throw new HttpError(409, 'Replace your Steam match codes to resume sync.');
      const authCode = unseal(readKey(c.steamSyncKeyFile), operation.binding, row.encrypted_code);
      let cursor = row.cursor as string;
      const seen = new Set([cursor]);
      for (let step = 0; step < syncSteps; step++) {
        const next = await nextCode(
          c,
          db,
          r,
          operation.subject,
          authCode,
          cursor,
          operation.signal,
        ).catch((error: unknown) => {
          if (
            error instanceof HttpError &&
            (error.statusCode === 400 || error.statusCode === 403)
          ) {
            db.transaction(() => {
              operation.revalidate();
              db.run(
                'UPDATE steam_history SET needs_codes=1 WHERE user_id=? AND generation=?',
                operation.userId,
                row.generation,
              );
            });
          }
          throw error;
        });
        db.transaction(() => {
          operation.revalidate();
          if (saved(operation.userId)?.generation !== row.generation)
            throw new HttpError(409, 'The Steam connection changed. Try again.');
          if (!next) return;
          if (seen.has(next))
            throw new HttpError(
              502,
              'Steam returned a repeated match code. Verify a newer starting code.',
            );
          addMatch(operation.userId, next);
          db.run('UPDATE steam_history SET cursor=? WHERE user_id=?', next, operation.userId);
        });
        if (!next) return { up_to_date: true };
        seen.add(next);
        cursor = next;
      }
      return { up_to_date: false };
    } finally {
      operation.end();
    }
  });
  app.delete('/api/connections/steam/history', async (r) => {
    const user = requireUser(r);
    rateLimit(db, r, 'steam-history-remove', 8, 900, user.id);
    inFlight.get(user.id)?.abort();
    db.transaction(() => {
      db.run('DELETE FROM steam_history WHERE user_id=?', user.id);
      db.run('DELETE FROM steam_matches WHERE user_id=?', user.id);
    });
    return { ok: true };
  });
}
