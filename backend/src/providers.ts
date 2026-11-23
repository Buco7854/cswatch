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
  requireFreshSession,
  renewAfterIdentityChange,
  sendSession,
  rateLimit,
  type SessionUser,
} from './security.js';
import { abandonUpload, reserve, validateMagic } from './ingestion.js';
import { downloadRemoteDemo, validateRemoteUrl } from './remote-download.js';
import {
  faceitId,
  linkedSteamId,
  matchDemo,
  matchFilter,
  matchOffset,
  matchPageSize,
} from './match-library.js';
import type { ProviderRequests } from './provider-requests.js';
import { readUpstreamJson, requestProvider } from './upstream.js';
const faceitProfile = z.object({
  player_id: faceitId,
  games: z.object({ cs2: z.object({ game_player_id: z.string().regex(/^\d{17}$/) }) }),
});
const timestamp = z.number().int().min(0).max(8_640_000_000_000);
const historyBatch = 100;
const historyCacheTtl = 30_000;
const historyCacheMembers = 64;
const historyCachePages = 6;
const maxHistoryCalls = 4;
const maxNoDemoMatches = 256;
const maxFilesPerMatch = 16;
const matchParticipant = z.object({
  player_id: faceitId,
  game_skill_level: z.number().int().min(1).max(10).nullish().catch(null),
});
const historyResults = z.object({
  winner: faceitId.nullish(),
  score: z.record(z.string(), z.number().int().min(0).max(1000)).nullish(),
});
const faceitHistory = z.object({
  items: z
    .array(
      z.object({
        match_id: faceitId,
        finished_at: timestamp.nullish(),
        started_at: timestamp.nullish(),
        competition_name: z.string().max(256).nullish(),
        map: z.string().max(128).nullish().catch(null),
        teams: z
          .record(
            z.string(),
            z.object({
              nickname: z.string().max(256).nullish(),
              players: z.array(matchParticipant).max(32).nullish(),
            }),
          )
          .nullish(),
        results: historyResults.nullish(),
      }),
    )
    .max(historyBatch),
});
type HistoryEntry = z.infer<typeof faceitHistory>['items'][number];
type HistoryRow = ReturnType<typeof matchSummary> & { cursorTime: number | null };
const invalidHistory = () =>
  new HttpError(502, 'FACEIT returned an invalid response. Try again later.');
const historyTime = (entry: HistoryEntry) => entry.finished_at ?? entry.started_at ?? null;
function matchSummary(entry: HistoryEntry, subject: string) {
  const teams = Object.entries(entry.teams ?? {}).slice(0, 2);
  const participant = teams.find(([, team]) =>
    team.players?.some((player) => player.player_id === subject),
  )?.[0];
  const ownLevel = teams
    .flatMap(([, team]) => team.players ?? [])
    .find((player) => player.player_id === subject)?.game_skill_level;
  const winner = entry.results?.winner;
  return {
    match_id: entry.match_id,
    ...(ownLevel ? { faceit_level: ownLevel } : {}),
    played_at: entry.finished_at ?? entry.started_at ?? null,
    competition: entry.competition_name ?? null,
    map: entry.map ?? null,
    teams: teams.map(([key, team]) => ({
      name: team.nickname || null,
      score: entry.results?.score?.[key] ?? null,
    })),
    result:
      participant && teams.some(([key]) => key === winner)
        ? winner === participant
          ? 'win'
          : 'loss'
        : null,
  };
}
// The history endpoint often omits the map. Player match stats can supply it
// for a whole time window with one request, including before a replay exists.
const playerMapStat = z.object({
  stats: z.object({
    'Match Id': faceitId,
    Map: z.string().trim().min(1).max(128),
  }),
});
const playerMapStats = z.object({ items: z.array(z.unknown()).max(historyBatch) });
async function fillHistoryMaps(
  c: Config,
  requests: ProviderRequests,
  subject: string,
  entries: HistoryEntry[],
  signal: AbortSignal,
) {
  const times = entries.flatMap((entry) => {
    const time = historyTime(entry);
    return !entry.map && time !== null ? [time] : [];
  });
  if (!times.length) return;
  const raw = await faceit(
    c,
    requests,
    `players/${subject}/games/cs2/stats`,
    'FACEIT could not find the linked player.',
    {
      from: String(Math.min(...times) * 1000),
      to: String(Math.max(...times) * 1000 + 999),
      limit: String(historyBatch),
    },
    AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    'faceitStats',
  );
  const parsed = playerMapStats.safeParse(raw);
  if (!parsed.success) return;
  const maps = new Map<string, string | null>();
  for (const item of parsed.data.items) {
    const row = playerMapStat.safeParse(item);
    if (!row.success) continue;
    const { 'Match Id': id, Map: map } = row.data.stats;
    maps.set(id, maps.has(id) && maps.get(id) !== map ? null : map);
  }
  for (const entry of entries) {
    if (!entry.map) entry.map = maps.get(entry.match_id);
  }
}

const faceitMatch = z.object({
  match_id: faceitId,
  game: z.string(),
  finished_at: timestamp.nullish(),
  started_at: timestamp.nullish(),
  competition_name: z.string().max(256).nullish(),
  results: historyResults.nullish(),
  voting: z
    .object({
      map: z.object({ pick: z.array(z.string().max(128)).max(16).nullish() }).nullish(),
    })
    .nullish()
    .catch(null),
  demo_url: z.array(z.string().max(4096)).max(maxFilesPerMatch).nullish(),
  teams: z
    .record(
      z.string(),
      z.object({
        nickname: z.string().max(256).nullish(),
        roster: z.array(matchParticipant).max(32).nullish(),
        substitutes: z
          .array(matchParticipant.extend({ playing: z.boolean().optional() }))
          .max(32)
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
  requests: ProviderRequests,
  path: string,
  missing: string,
  params: Record<string, string> = {},
  signal = AbortSignal.timeout(20000),
  service: 'faceitData' | 'faceitStats' = 'faceitData',
) {
  return requestProvider(
    requests,
    service,
    'https://open.faceit.com/data/v4/' + path + '?' + new URLSearchParams(params),
    {
      headers: { Authorization: 'Bearer ' + c.faceitApiKey },
      signal,
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
            'This instance cannot read FACEIT match data. You can still upload a demo file.',
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
  requests: ProviderRequests,
  download = downloadRemoteDemo,
) {
  const historyCache = new Map<
    string,
    {
      binding: string;
      pages: Map<string, { expires: number; to: number; items: HistoryRow[] }>;
      noDemo: Set<string>;
    }
  >();
  const activeOperations = new Map<string, Set<AbortController>>();
  function existingCache(user: SessionUser, subject: string) {
    const member = historyCache.get(user.id);
    return member?.binding === user.csrf + ':' + subject ? member : undefined;
  }
  function cacheFor(user: SessionUser, subject: string) {
    const member = existingCache(user, subject) ?? {
      binding: user.csrf + ':' + subject,
      pages: new Map(),
      noDemo: new Set<string>(),
    };
    historyCache.delete(user.id);
    historyCache.set(user.id, member);
    if (historyCache.size > historyCacheMembers)
      historyCache.delete(historyCache.keys().next().value!);
    return member;
  }

  function invalidate(userId: string) {
    historyCache.delete(userId);
    for (const operation of activeOperations.get(userId) ?? []) operation.abort();
    activeOperations.delete(userId);
  }
  function operationFor(userId: string) {
    const controller = new AbortController();
    const active = activeOperations.get(userId) ?? new Set<AbortController>();
    active.add(controller);
    activeOperations.set(userId, active);
    return {
      signal: controller.signal,
      finish() {
        active.delete(controller);
        if (!active.size && activeOperations.get(userId) === active)
          activeOperations.delete(userId);
      },
    };
  }
  const resourceHosts = [...faceitResourceHosts, ...c.faceitResourceHosts];
  const downloadHosts = [...faceitDownloadHosts, ...c.faceitSignedDownloadHosts];
  const enabled = () => {
    if (!db.flag(c, 'faceit_enabled') || !c.faceitApiKey)
      throw new HttpError(403, 'This instance does not have everything needed for FACEIT matches.');
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
  app.post('/api/connections/faceit/link', async (r, reply) => {
    z.strictObject({}).parse(r.body);
    const u = requireUser(r);
    requireFreshSession(db, r, c);
    enabled();
    rateLimit(db, r, 'faceit-link', 10, 900, u.id);
    const steam = db.one(
      "SELECT subject FROM identities WHERE user_id=? AND provider='steam'",
      u.id,
    );
    if (!steam) throw new HttpError(400, 'Link Steam first to verify your FACEIT account.');
    const operation = operationFor(u.id);
    try {
      const result = await faceit(
        c,
        requests,
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
      const grant = db.transaction(() => {
        revalidate(r, u);
        const live = requireFreshSession(db, r, c);
        if (operation.signal.aborted)
          throw new HttpError(409, 'The FACEIT connection changed. Try again.');
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
        db.audit(u.id, 'faceit.linked', { target: u.id, address: r.clientAddress });
        return renewAfterIdentityChange(db, c, r, live);
      });
      invalidate(u.id);
      return { subject, ...sendSession(c, reply, grant) };
    } finally {
      operation.finish();
    }
  });
  app.delete('/api/connections/faceit/link', async (r, reply) => {
    z.strictObject({}).parse(r.body);
    const user = requireUser(r);
    rateLimit(db, r, 'faceit-unlink', 8, 900, user.id);
    const grant = db.transaction(() => {
      const live = requireFreshSession(db, r, c);
      if (
        !db.run("DELETE FROM identities WHERE provider='faceit' AND user_id=?", live.user_id)
          .changes
      )
        throw new HttpError(404, 'The FACEIT connection has already been removed.');
      db.audit(live.user_id, 'faceit.unlinked', { target: live.user_id, address: r.clientAddress });
      return renewAfterIdentityChange(db, c, r, live);
    });
    invalidate(user.id);
    return sendSession(c, reply, grant);
  });
  function demosFor(owner: string, ids: string[]) {
    const grouped = new Map<string, ReturnType<typeof matchDemo>[]>();
    if (!ids.length) return grouped;
    const steamId = linkedSteamId(db, owner);
    for (const row of db.all(
      `WITH paired AS (
         SELECT id,status,map,faceit_match_id,
           row_number() OVER (PARTITION BY faceit_match_id ORDER BY created_at DESC,id DESC) AS rank
         FROM demos WHERE owner_id=? AND status!='uploading'
         AND faceit_match_id IN (${ids.map(() => '?').join(',')})
       )
       SELECT p.id,p.status,p.map,p.faceit_match_id,d.metadata FROM paired p JOIN demos d ON d.id=p.id WHERE rank<=? ORDER BY rank`,
      owner,
      ...ids,
      maxFilesPerMatch,
    )) {
      const group = grouped.get(row.faceit_match_id) ?? [];
      group.push(matchDemo(row, steamId));
      grouped.set(row.faceit_match_id, group);
    }
    return grouped;
  }

  async function historyPage(
    r: FastifyRequest,
    user: SessionUser,
    subject: string,
    to: number,
    offset: number,
    first: boolean,
  ) {
    const key = first ? 'recent' : to + ':' + offset;
    const cached = existingCache(user, subject)?.pages.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    rateLimit(db, r, 'faceit-history', 80, 900, user.id);
    const operation = operationFor(user.id);
    try {
      const raw = await faceit(
        c,
        requests,
        `players/${subject}/history`,
        'FACEIT could not find the linked player.',
        {
          game: 'cs2',
          limit: String(historyBatch),
          offset: String(offset),
          from: '0',
          to: String(to),
        },
        AbortSignal.any([operation.signal, AbortSignal.timeout(20000)]),
      ).catch((error: unknown) => {
        revalidateFaceit(r, user, subject);
        throw error;
      });
      revalidateFaceit(r, user, subject);
      if (operation.signal.aborted)
        throw new HttpError(409, 'The FACEIT connection changed. Try again.');
      const parsed = faceitHistory.safeParse(raw);
      if (!parsed.success) throw invalidHistory();
      const entries = parsed.data.items;
      if (new Set(entries.map((item) => item.match_id)).size !== entries.length)
        throw invalidHistory();
      let previousTime = to;
      for (const item of entries) {
        const time = historyTime(item);
        if (time === null) continue;
        if (time > previousTime) throw invalidHistory();
        previousTime = time;
      }

      // Optional enrichment must not hide the member's history on a provider outage.
      await fillHistoryMaps(c, requests, subject, entries, operation.signal).catch(
        (error: unknown) => {
          if (!(error instanceof HttpError)) throw error;
        },
      );
      revalidateFaceit(r, user, subject);
      if (operation.signal.aborted)
        throw new HttpError(409, 'The FACEIT connection changed. Try again.');
      const items = entries.map((entry) => ({
        ...matchSummary(entry, subject),
        cursorTime: historyTime(entry),
      }));
      const { pages } = cacheFor(user, subject);
      pages.delete(key);
      const page = { expires: Date.now() + historyCacheTtl, to, items };
      pages.set(key, page);
      if (pages.size > historyCachePages) pages.delete(pages.keys().next().value!);
      return page;
    } finally {
      operation.finish();
    }
  }

  app.get('/api/connections/faceit/matches', async (r) => {
    const user = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-history-read', 150, 900, user.id);
    const identity = linkedFaceit(user.id);
    if (!identity) throw new HttpError(403, 'Link your FACEIT account first.');
    const { filter, offset, cursor } = z
      .object({
        filter: matchFilter,
        offset: matchOffset,
        cursor: z
          .string()
          .regex(/^\d{1,13}\.\d{1,4}$/)
          .optional(),
      })
      .parse(r.query);
    const noDemo = () => existingCache(user, identity.subject)?.noDemo;
    if (filter === 'downloaded') {
      return db.transaction(() => {
        revalidateFaceit(r, user, identity.subject);
        const rows = db.all(
          `WITH owned AS (
           SELECT faceit_match_id AS match_id,created_at,
             CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.faceitSubject') END AS subject,
             CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.faceitMatch') END AS evidence
           FROM demos WHERE owner_id=? AND faceit_match_id IS NOT NULL AND status!='uploading'
         ), ranked AS (
           SELECT *, row_number() OVER (PARTITION BY match_id ORDER BY evidence IS NOT NULL DESC,created_at DESC) AS rank
           FROM owned
         )
         SELECT * FROM ranked WHERE rank=1
         ORDER BY coalesce(json_extract(evidence,'$.played_at'),created_at) DESC,match_id DESC LIMIT ? OFFSET ?`,
          user.id,
          matchPageSize + 1,
          offset,
        );
        const page = rows.slice(0, matchPageSize);
        const demos = demosFor(
          user.id,
          page.map((row) => row.match_id),
        );
        return {
          items: page.map((row) => ({
            ...(row.evidence ? JSON.parse(row.evidence) : {}),
            ...(row.subject === identity.subject
              ? {}
              : { faceit_level: undefined, result: undefined }),
            match_id: row.match_id,
            no_demo: noDemo()?.has(row.match_id) ?? false,
            demos: demos.get(row.match_id) ?? [],
          })),
          next: rows.length > matchPageSize ? String(offset + matchPageSize) : null,
        };
      });
    }

    const through = Math.floor(Date.now() / 1000) - 1;
    const [to, skipped] = cursor?.split('.').map(Number) ?? [through, 0];
    if (to > through || skipped > 1100)
      throw new HttpError(400, 'Check the form fields and try again.');
    let position = { to, offset: skipped };
    const items: (ReturnType<typeof matchSummary> & {
      demos: ReturnType<typeof matchDemo>[];
      no_demo: boolean;
    })[] = [];
    let next: string | null = null;
    let hadMatches = skipped > 0;
    for (let call = 0; call < maxHistoryCalls; call++) {
      const window = position;
      const offset = Math.min(window.offset, 1000);
      const overlap = window.offset - offset;
      const { items: batch, to: windowEnd } = await historyPage(
        r,
        user,
        identity.subject,
        window.to,
        offset,
        !cursor && call === 0,
      );
      revalidateFaceit(r, user, identity.subject);
      const remaining = batch.slice(overlap);
      hadMatches ||= remaining.length > 0;
      if (!remaining.length && batch.length === historyBatch)
        throw new HttpError(502, 'FACEIT history reached its paging limit for one timestamp.');
      const demos = demosFor(
        user.id,
        remaining.map((row) => row.match_id),
      );
      let canNarrow = true;
      for (const [index, { cursorTime: time, ...entry }] of remaining.entries()) {
        const paired = demos.get(entry.match_id) ?? [];
        if (items.length === matchPageSize && (filter === 'all' || !paired.length))
          return { items, next, had_matches: hadMatches };
        if (time === null) canNarrow = false;
        position =
          canNarrow && time !== null
            ? { to: time, offset: time === position.to ? position.offset + 1 : 1 }
            : { to: windowEnd, offset: window.offset + index + 1 };
        next = position.to + '.' + position.offset;
        if (filter === 'all' || !paired.length)
          items.push({ ...entry, demos: paired, no_demo: noDemo()?.has(entry.match_id) ?? false });
      }
      if (batch.length < historyBatch) return { items, next: null, had_matches: hadMatches };
    }
    return { items, next, had_matches: hadMatches };
  });
  async function verifyFaceitUpload(r: FastifyRequest, u: SessionUser, matchId: string) {
    enabled();
    const identity = linkedFaceit(u.id);
    if (!identity) throw new HttpError(400, 'Link your FACEIT account first.');
    const operation = operationFor(u.id);
    try {
      const match = faceitMatch.safeParse(
        await faceit(c, requests, 'matches/' + matchId, 'FACEIT could not find this match.'),
      );
      if (!match.success || match.data.match_id !== matchId)
        throw new HttpError(502, 'FACEIT returned an invalid response. Try again later.');
      if (match.data.game !== 'cs2')
        throw new HttpError(400, 'Only FACEIT CS2 matches can be imported.');
      const participant = Object.values(match.data.teams ?? {}).some(
        (team) =>
          team.roster?.some((player) => player.player_id === identity.subject) ||
          team.substitutes?.some(
            (player) => player.playing && player.player_id === identity.subject,
          ),
      );
      if (!participant)
        throw new HttpError(403, 'FACEIT could not confirm you played in this match.');
      revalidateFaceit(r, u, identity.subject);
      if (operation.signal.aborted)
        throw new HttpError(409, 'The FACEIT connection changed. Try again.');
      const maps = match.data.voting?.map?.pick;
      const summary = matchSummary(
        {
          ...match.data,
          map: maps?.length === 1 ? maps[0] : null,
          teams: Object.fromEntries(
            Object.entries(match.data.teams ?? {}).map(([key, team]) => [
              key,
              {
                nickname: team.nickname,
                players: [
                  ...(team.roster ?? []),
                  ...(team.substitutes ?? []).filter((player) => player.playing),
                ],
              },
            ]),
          ),
        },
        identity.subject,
      );
      return { match: match.data, subject: identity.subject, summary };
    } finally {
      operation.finish();
    }
  }
  const noDemoError = () =>
    new HttpError(
      404,
      'FACEIT has no demo for this match. It may be pending or expired.',
      undefined,
      'faceit_no_demo',
    );
  async function matchDemos(r: FastifyRequest, u: SessionUser, matchId: string) {
    const identity = linkedFaceit(u.id);
    if (!identity) throw new HttpError(400, 'Link your FACEIT account first.');
    if (existingCache(u, identity.subject)?.noDemo.has(matchId)) throw noDemoError();
    const { match, subject, summary } = await verifyFaceitUpload(r, u, matchId);
    const resources = match.demo_url ?? [];
    if (!resources.length) {
      const { noDemo } = cacheFor(u, subject);
      noDemo.add(matchId);
      if (noDemo.size > maxNoDemoMatches) noDemo.delete(noDemo.values().next().value!);
      throw noDemoError();
    }
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
    return { files, subject, summary };
  }
  app.get('/api/connections/faceit/match-demos', async (r) => {
    const u = requireUser(r);
    enabled();
    rateLimit(db, r, 'faceit-details', 30, 900, u.id);
    const { match_id } = z.object({ match_id: faceitId }).parse(r.query);
    if (!c.faceitDownloadToken)
      throw new HttpError(
        403,
        'This instance does not have everything needed to download FACEIT demos. You can still upload them yourself.',
      );
    const { files } = await matchDemos(r, u, match_id);
    return {
      files: [...files.values()].map(({ id, file }) => {
        const demo = db.one(
          "SELECT id,status,map FROM demos WHERE owner_id=? AND source_ref=? AND status!='uploading'",
          u.id,
          'faceit:' + id,
        );
        return { id, file, demo: demo ? matchDemo(demo) : null };
      }),
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
    const { files, subject, summary } = await matchDemos(r, u, match_id);
    const selected = resource_id
      ? files.get(resource_id)
      : files.size === 1
        ? files.values().next().value
        : undefined;
    if (!selected) throw new HttpError(409, 'Select a demo file from the current FACEIT match.');
    const { resource, suffix } = selected;
    const { id, folder, writeExpiresAt } = reserve(
      db,
      c,
      u.id,
      'FACEIT ' + match_id + ' #' + selected.file,
      'faceit',
      match_id,
      'faceit:' + selected.id,
      () => revalidateFaceit(r, u, subject),
    );
    const operation = operationFor(u.id);
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(Math.max(1, Math.min(180000, writeExpiresAt - Date.now()))),
        operation.signal,
      ]);
      revalidateFaceit(r, u, subject);
      const url = await requestProvider(
        requests,
        'faceitSigner',
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
              'This instance cannot download FACEIT demos. Upload the demo file from your device.',
            );
          if (response.status === 429)
            throw new HttpError(429, 'FACEIT is rate limiting requests. Try again later.');
          if (!response.ok) throw new Error();
          return signedDemo.parse(await readUpstreamJson(response)).payload.download_url;
        },
      );
      revalidateFaceit(r, u, subject);
      validateRemoteUrl(url, downloadHosts);
      if (operation.signal.aborted)
        throw new HttpError(409, 'The FACEIT connection changed. Try again.');
      const { bytes: size } = await requests.run('faceitFiles', (report) =>
        download(url, join(folder, 'input' + suffix), {
          onResponse: report,
          onNetworkFailure: () => report(503),
          allowedHosts: downloadHosts,
          maxBytes: c.maxUploadMb * 1024 ** 2,
          signal,
        }),
      );
      validateMagic(join(folder, 'input' + suffix), suffix);
      db.transaction(() => {
        revalidateFaceit(r, u, subject);
        if (operation.signal.aborted)
          throw new HttpError(409, 'The FACEIT connection changed. Try again.');
        if (Date.now() >= writeExpiresAt)
          throw new HttpError(408, 'The demo import could not be completed. Try again.');
        if (
          !db.run(
            "UPDATE demos SET status='queued',size=?,metadata=? WHERE id=? AND owner_id=? AND status='uploading'",
            size,
            JSON.stringify({ faceitMatch: summary, faceitSubject: subject }),
            id,
            u.id,
          ).changes
        )
          throw new HttpError(409, 'The demo import could not be completed. Try again.');
      });
      reply.code(202);
      return { id };
    } catch (e) {
      abandonUpload(db, id);
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'FACEIT download failed. Try again or upload manually.');
    } finally {
      operation.finish();
    }
  });
  return { invalidate, operationFor, verifyFaceitUpload, revalidateFaceit };
}
