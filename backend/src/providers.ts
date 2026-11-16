import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Store } from './db.js';
import type { Config } from './config.js';
import { HttpError, requireUser, rateLimit } from './security.js';
import { abandon, reserve, validateMagic } from './ingestion.js';
async function faceit(c: Config, path: string, params: Record<string, string> = {}) {
  if (!c.faceitApiKey)
    throw new HttpError(503, 'The administrator must configure a FACEIT Data API key.');
  try {
    const response = await fetch(
      'https://open.faceit.com/data/v4/' + path + '?' + new URLSearchParams(params),
      {
        headers: { Authorization: 'Bearer ' + c.faceitApiKey },
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new Error();
    return (await response.json()) as any;
  } catch {
    throw new HttpError(
      502,
      'FACEIT could not complete this request. Check the profile, match ID, and API access.',
    );
  }
}
// URLs are accepted exclusively from FACEIT's authenticated API, never from users.
export async function validateDownload(url: string) {
  const u = new URL(url),
    host = u.hostname;
  if (
    u.protocol !== 'https:' ||
    (u.port && u.port !== '443') ||
    u.username ||
    u.password ||
    isIP(host) ||
    !(
      host === 'demos.faceit.com' ||
      host.endsWith('.amazonaws.com') ||
      host.endsWith('.cloudfront.net')
    )
  )
    throw new HttpError(502, 'FACEIT returned an unsupported download host.');
  const addresses = await lookup(host, { all: true });
  // Cloud-provider host suffixes prevent attacker-controlled DNS. Also reject local resolutions.
  if (
    !addresses.length ||
    addresses.some(({ address }) =>
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(
        address,
      ),
    )
  )
    throw new HttpError(502, 'Invalid download address.');
  return u;
}
export async function providerRoutes(app: FastifyInstance, db: Store, c: Config) {
  const enabled = () => {
    if (!db.flag(c, 'faceit_enabled')) throw new HttpError(403, 'FACEIT integration is disabled.');
  };
  app.post('/api/connections/faceit/link', async (r) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-link', 10, 900, u.id);
    const steam = db.one(
      "SELECT subject FROM identities WHERE user_id=? AND provider='steam'",
      u.id,
    );
    if (!steam) throw new HttpError(400, 'Link Steam first to verify your FACEIT account.');
    const profile = await faceit(c, 'players', { game: 'cs2', game_player_id: steam.subject });
    if (String(profile.games?.cs2?.game_player_id) !== steam.subject)
      throw new HttpError(400, 'FACEIT did not confirm a matching Steam account.');
    const subject = z.string().uuid().parse(profile.player_id);
    db.transaction(() => {
      const existing = db.one(
        "SELECT user_id FROM identities WHERE provider='faceit' AND subject=?",
        subject,
      );
      if (existing && existing.user_id !== u.id)
        throw new HttpError(409, 'This FACEIT account is already linked.');
      db.run(
        "INSERT INTO identities VALUES('faceit',?,?) ON CONFLICT(provider,user_id) DO UPDATE SET subject=excluded.subject",
        subject,
        u.id,
      );
    });
    db.audit(u.id, 'faceit.linked');
    return { nickname: profile.nickname, subject };
  });
  app.get('/api/connections/faceit/matches', async (r) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-history', 20, 900, u.id);
    const identity = db.one(
      "SELECT subject FROM identities WHERE user_id=? AND provider='faceit'",
      u.id,
    );
    if (!identity) throw new HttpError(400, 'Link your FACEIT account first.');
    return faceit(c, `players/${identity.subject}/history`, { game: 'cs2', limit: '20' });
  });
  app.post('/api/connections/faceit/import', async (r, reply) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-import', 5, 3600, u.id);
    const { match_id } = z
      .object({ match_id: z.string().regex(/^1-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i) })
      .parse(r.body);
    if (!c.faceitDownloadToken)
      throw new HttpError(
        503,
        'Automatic downloads require an approved FACEIT Downloads API token. Upload the demo manually instead.',
      );
    const match = await faceit(c, 'matches/' + match_id);
    const resource = z.string().url().safeParse(match.demo_url?.[0]);
    if (!resource.success) throw new HttpError(404, 'FACEIT has no demo for this match yet.');
    if (new URL(resource.data).hostname !== 'demos.faceit.com')
      throw new HttpError(502, 'Unsupported FACEIT resource.');
    const { id, folder } = reserve(db, c, u.id, 'FACEIT ' + match_id, 'faceit', match_id);
    try {
      const signal = AbortSignal.timeout(180000);
      const signed = await fetch('https://api.faceit.com/download/v2/demos/download', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + c.faceitDownloadToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ resource_url: resource.data }),
        signal,
        redirect: 'error',
      });
      if (!signed.ok) throw new Error();
      const result = (await signed.json()) as any;
      const url = await validateDownload(result.payload.download_url);
      const response = await fetch(url, { signal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error();
      const suffix = new URL(resource.data).pathname.endsWith('.gz')
        ? '.gz'
        : new URL(resource.data).pathname.endsWith('.zst')
          ? '.zst'
          : '.dem';
      let size = 0;
      const limiter = new Transform({
        transform(chunk, _, cb) {
          size += chunk.length;
          if (size > c.maxUploadMb * 1024 ** 2)
            cb(new HttpError(413, 'Demo exceeds the upload limit.'));
          else cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as any),
        limiter,
        createWriteStream(join(folder, 'input' + suffix), { mode: 0o600 }),
      );
      validateMagic(join(folder, 'input' + suffix), suffix);
      db.run("UPDATE demos SET status='queued',size=? WHERE id=?", size, id);
      reply.code(202);
      return { id };
    } catch (e) {
      abandon(db, id);
      if (e instanceof HttpError) throw e;
      throw new HttpError(
        502,
        'FACEIT download failed. Check Downloads API approval, or upload manually.',
      );
    }
  });
  app.post('/api/connections/steam/next-match', async (r) => {
    const u = requireUser(r);
    if (!db.flag(c, 'steam_enabled') || !c.steamApiKey)
      throw new HttpError(
        503,
        'Steam match discovery requires an administrator-configured Steam Web API key.',
      );
    rateLimit(db, r, 'steam-history', 10, 900, u.id);
    const b = z
      .object({
        auth_code: z.string().regex(/^[A-Za-z0-9-]{5,40}$/),
        share_code: z.string().regex(/^CSGO(?:-[A-Za-z0-9]{5}){5}$/),
      })
      .parse(r.body);
    const identity = db.one(
      "SELECT subject FROM identities WHERE user_id=? AND provider='steam'",
      u.id,
    );
    if (!identity) throw new HttpError(400, 'Link Steam first.');
    try {
      const response = await fetch(
        'https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/?' +
          new URLSearchParams({
            key: c.steamApiKey,
            steamid: identity.subject,
            steamidkey: b.auth_code,
            knowncode: b.share_code,
          }),
        { signal: AbortSignal.timeout(20000), redirect: 'error' },
      );
      if (!response.ok) throw new Error();
      const result = (await response.json()) as any;
      const code = result.result?.nextcode;
      return {
        share_code: code && code !== 'n/a' ? code : null,
        message:
          'Open the match in CS2, download its demo, then upload the file. Steam sign-in does not grant demo download access.',
      };
    } catch {
      throw new HttpError(
        502,
        'Steam discovery failed. Check your authentication and match sharing codes.',
      );
    }
  });
}
