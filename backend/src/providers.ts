import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { join } from 'node:path';
import type { Store } from './db.js';
import type { Config } from './config.js';
import {
  currentUser,
  digest,
  HttpError,
  requireUser,
  rateLimit,
  type SessionUser,
} from './security.js';
import { abandon, reserve, validateMagic } from './ingestion.js';
import { downloadRemoteDemo, validateRemoteUrl } from './remote-download.js';
import { readUpstreamJson, requestJson } from './upstream.js';
const faceitId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const faceitProfile = z.object({
  player_id: faceitId,
  games: z.object({ cs2: z.object({ game_player_id: z.string().regex(/^\d{17}$/) }) }),
});
const faceitHistory = z.object({
  items: z
    .array(
      z.object({
        match_id: faceitId,
        finished_at: z.number().int().min(0).max(8_640_000_000_000).nullish(),
        competition_name: z.string().max(256).nullish(),
        teams: z.record(z.string(), z.object({ nickname: z.string().max(256) })).nullish(),
      }),
    )
    .max(20),
});
const faceitMatch = z.object({
  match_id: faceitId,
  game: z.string(),
  demo_url: z.array(z.string().max(4096)).max(16).nullish(),
  teams: z
    .record(
      z.string(),
      z.object({
        roster: z.array(z.object({ player_id: z.string() })).nullish(),
        substitutes: z
          .array(z.object({ player_id: z.string(), playing: z.boolean().optional() }))
          .nullish(),
      }),
    )
    .nullish(),
});
const signedDemo = z.object({ payload: z.object({ download_url: z.string().max(4096) }) });
// Resource URLs are forwarded only to the fixed signer. Signed GETs have their own exact host list.
const faceitResourceHosts = ['demos.faceit.com'];
const faceitDownloadHosts = [
  'demos.faceit.com',
  'demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com',
];

async function faceit(
  c: Config,
  path: string,
  missing: string,
  params: Record<string, string> = {},
) {
  if (!c.faceitApiKey)
    throw new HttpError(
      503,
      'This instance does not have everything needed for FACEIT matches. You can still upload your demos.',
    );
  return requestJson(
    'https://open.faceit.com/data/v4/' + path + '?' + new URLSearchParams(params),
    {
      headers: { Authorization: 'Bearer ' + c.faceitApiKey },
      signal: AbortSignal.timeout(20000),
    },
    'FACEIT returned an invalid response. Try again later.',
    async (response) => {
      switch (response.status) {
        case 200:
          return readUpstreamJson(response);
        case 401:
        case 403:
          throw new HttpError(
            502,
            'FACEIT denied Data API access. Ask the administrator to check the key and permissions.',
          );
        case 404:
          throw new HttpError(404, missing);
        case 429:
          throw new HttpError(429, 'FACEIT is rate limiting requests. Try again later.');
        case 503:
          throw new HttpError(503, 'FACEIT is temporarily unavailable. Try again later.');
        default:
          throw new HttpError(502, 'FACEIT could not complete the request. Try again later.');
      }
    },
  );
}

export async function providerRoutes(
  app: FastifyInstance,
  db: Store,
  c: Config,
  download = downloadRemoteDemo,
) {
  const resourceHosts = [...faceitResourceHosts, ...c.faceitResourceHosts];
  const downloadHosts = [...faceitDownloadHosts, ...c.faceitSignedDownloadHosts];
  const enabled = () => {
    if (!db.flag(c, 'faceit_enabled')) throw new HttpError(403, 'FACEIT integration is disabled.');
  };
  function revalidate(request: FastifyRequest, captured: SessionUser) {
    const live = currentUser(db, request, c);
    if (!live || live.id !== captured.id || live.csrf !== captured.csrf)
      throw new HttpError(401, 'Session expired. Refresh the page and try again.');
    enabled();
  }
  function linkedFaceit(userId: string) {
    return db.one("SELECT subject FROM identities WHERE user_id=? AND provider='faceit'", userId);
  }
  function revalidateFaceit(request: FastifyRequest, user: SessionUser, subject: string) {
    revalidate(request, user);
    if (linkedFaceit(user.id)?.subject !== subject)
      throw new HttpError(409, 'The FACEIT connection changed. Try again.');
  }
  app.post('/api/connections/faceit/link', async (r) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-link', 10, 900, u.id);
    const steam = db.one(
      "SELECT subject FROM identities WHERE user_id=? AND provider='steam'",
      u.id,
    );
    if (!steam) throw new HttpError(400, 'Link Steam first to verify your FACEIT account.');
    const result = await faceit(
      c,
      'players',
      'No FACEIT CS2 profile was found for this Steam account.',
      {
        game: 'cs2',
        game_player_id: steam.subject,
      },
    );
    const profile = faceitProfile.safeParse(result);
    if (!profile.success || profile.data.games.cs2.game_player_id !== steam.subject)
      throw new HttpError(400, 'FACEIT did not confirm a matching Steam account.');
    const subject = profile.data.player_id;
    db.transaction(() => {
      revalidate(r, u);
      if (
        db.one("SELECT subject FROM identities WHERE user_id=? AND provider='steam'", u.id)
          ?.subject !== steam.subject
      )
        throw new HttpError(409, 'Session expired. Refresh the page and try again.');
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
    return { subject };
  });
  app.get('/api/connections/faceit/matches', async (r) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-history', 20, 900, u.id);
    const identity = linkedFaceit(u.id);
    if (!identity) throw new HttpError(400, 'Link your FACEIT account first.');
    const { offset, to } = z
      .object({
        offset: z.coerce.number().int().min(0).max(1000).default(0),
        to: z.coerce
          .number()
          .int()
          .min(1)
          .max(Math.floor(Date.now() / 1000))
          .optional(),
      })
      .parse(r.query);
    const through = to ?? Math.floor(Date.now() / 1000);
    const history = await faceit(
      c,
      `players/${identity.subject}/history`,
      'FACEIT could not find the linked player.',
      {
        game: 'cs2',
        limit: '20',
        offset: String(offset),
        // FACEIT returns only the last month without an explicit start.
        from: '0',
        to: String(through),
      },
    );
    const parsed = faceitHistory.safeParse(history);
    if (!parsed.success)
      throw new HttpError(502, 'FACEIT returned an invalid response. Try again later.');
    revalidateFaceit(r, u, identity.subject);
    return {
      items: parsed.data.items,
      next_offset: parsed.data.items.length === 20 && offset + 20 <= 1000 ? offset + 20 : null,
      to: through,
    };
  });
  async function matchDemos(r: FastifyRequest, u: SessionUser, matchId: string) {
    const identity = linkedFaceit(u.id);
    if (!identity) throw new HttpError(400, 'Link your FACEIT account first.');
    const match = faceitMatch.safeParse(
      await faceit(c, 'matches/' + matchId, 'FACEIT could not find this match.'),
    );
    if (!match.success || match.data.match_id !== matchId)
      throw new HttpError(502, 'FACEIT returned an invalid response. Try again later.');
    if (match.data.game !== 'cs2')
      throw new HttpError(400, 'Only FACEIT CS2 matches can be imported.');
    const participant = Object.values(match.data.teams ?? {}).some(
      (team) =>
        team.roster?.some((player) => player.player_id === identity.subject) ||
        team.substitutes?.some((player) => player.playing && player.player_id === identity.subject),
    );
    if (!participant)
      throw new HttpError(403, 'FACEIT could not confirm you played in this match.');
    revalidateFaceit(r, u, identity.subject);
    const resources = match.data.demo_url ?? [];
    if (!resources.length)
      throw new HttpError(404, 'FACEIT has no demo for this match. It may be pending or expired.');
    const files = new Map<string, { id: string; file: number; resource: string; suffix: string }>();
    for (const [index, resource] of resources.entries()) {
      const url = validateRemoteUrl(resource, resourceHosts);
      const extension = /\.dem(\.gz|\.zst)?$/i.exec(url.pathname);
      if (!extension || url.search)
        throw new HttpError(502, 'FACEIT returned an unsupported demo format.');
      const id = digest(url.origin + url.pathname);
      if (!files.has(id))
        files.set(id, {
          id,
          file: index + 1,
          resource,
          suffix: extension[1]?.toLowerCase() || '.dem',
        });
    }
    return { files, subject: identity.subject };
  }
  app.get('/api/connections/faceit/match-demos', async (r) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-details', 30, 900, u.id);
    const { match_id } = z.object({ match_id: faceitId }).parse(r.query);
    const { files } = await matchDemos(r, u, match_id);
    return {
      files: [...files.values()].map(({ id, file }) => ({
        id,
        file,
        demo_id:
          db.one(
            'SELECT id FROM demos WHERE owner_id=? AND source_ref=? AND status!=?',
            u.id,
            'faceit:' + id,
            'uploading',
          )?.id ?? null,
      })),
    };
  });
  app.post('/api/connections/faceit/import', async (r, reply) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-import', 10, 3600, u.id);
    const { match_id, resource_id } = z
      .object({
        match_id: faceitId,
        resource_id: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(r.body);
    if (!linkedFaceit(u.id)) throw new HttpError(400, 'Link your FACEIT account first.');
    if (!c.faceitDownloadToken)
      throw new HttpError(
        503,
        'This instance does not have everything needed to download FACEIT demos. You can still upload them yourself.',
      );
    const { files, subject } = await matchDemos(r, u, match_id);
    const selected = resource_id
      ? files.get(resource_id)
      : files.size === 1
        ? files.values().next().value
        : undefined;
    if (!selected) throw new HttpError(409, 'Select a demo file from the current FACEIT match.');
    const { resource, suffix } = selected;
    const { id, folder } = reserve(
      db,
      c,
      u.id,
      'FACEIT ' + match_id + ' #' + selected.file,
      'faceit',
      match_id,
      'faceit:' + selected.id,
    );
    try {
      const signal = AbortSignal.timeout(180000);
      const url = await requestJson(
        'https://api.faceit.com/download/v2/demos/download',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + c.faceitDownloadToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ resource_url: resource }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        },
        'FACEIT could not sign the demo download. Try again or upload manually.',
        async (response) => {
          if (response.status === 401 || response.status === 403)
            throw new HttpError(
              502,
              'FACEIT denied Downloads API access. Ask the administrator to check token approval.',
            );
          if (response.status === 429)
            throw new HttpError(429, 'FACEIT is rate limiting requests. Try again later.');
          if (!response.ok) throw new Error();
          return signedDemo.parse(await readUpstreamJson(response)).payload.download_url;
        },
      );
      revalidateFaceit(r, u, subject);
      validateRemoteUrl(url, downloadHosts);
      const { bytes: size } = await download(url, join(folder, 'input' + suffix), {
        allowedHosts: downloadHosts,
        maxBytes: c.maxUploadMb * 1024 ** 2,
        signal,
      });
      validateMagic(join(folder, 'input' + suffix), suffix);
      db.transaction(() => {
        revalidateFaceit(r, u, subject);
        if (
          !db.run(
            "UPDATE demos SET status='queued',size=? WHERE id=? AND owner_id=? AND status='uploading'",
            size,
            id,
            u.id,
          ).changes
        )
          throw new HttpError(409, 'The demo import could not be completed. Try again.');
      });
      reply.code(202);
      return { id };
    } catch (e) {
      abandon(db, id);
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'FACEIT download failed. Try again or upload manually.');
    }
  });
}
