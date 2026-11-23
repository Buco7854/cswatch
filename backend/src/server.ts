import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { loadConfig, flagDefaults, type Config, type Flag } from './config.js';
import { Store, openStoreForStartup } from './db.js';
import { buildInfo } from './build-info.js';
import {
  HttpError,
  currentUser,
  equal,
  rateLimit,
  requireAdmin,
  requireUser,
  token,
} from './security.js';
import { abandon, accessDemo, reserve, validateMagic } from './ingestion.js';
import { authRoutes } from './auth.js';
import { steamHistoryRoutes } from './steam-history.js';
import { providerRoutes } from './providers.js';
import { captionArtifactName } from './captions.js';
import { requeueTranscription } from './transcription-worker.js';
import { readMapPreparationState } from './map-readiness.js';
import { gameplaySoundAssetRoutes } from './gameplay-sound-assets.js';
import { equipmentAssetRoutes } from './equipment-assets.js';
import { equipmentModelAssetRoutes } from './equipment-model-assets.js';
import { viewmodelAssetRoutes } from './viewmodel-assets.js';
import { mapAssetRoutes } from './map-assets.js';
import { mapModelFileRoutes } from './map-model-files.js';
import { mapPreviewRoutes } from './map-preview.js';
import { mapManagementRoutes } from './map-management.js';
import { readPresentationStatus } from './presentation-assets.js';
import { demoMapAssetRoutes } from './demo-map-assets.js';
import { cleanupMapRequestTemps } from './map-jobs.js';
import { cleanupPresentationRetryTemps } from './presentation-assets.js';
import { currentGuest, guestRoutes, guestUploadsEnabled } from './guest.js';
import { prepareSetup, provisionAdmin, setupRequired, setupRoutes } from './setup.js';

export async function createApp(
  c: Config,
  db = new Store(c.dataDir),
  providerDownload?: Parameters<typeof providerRoutes>[3],
) {
  process.umask(0o077);
  if (Boolean(c.adminUsername) !== Boolean(c.adminPassword))
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured together.');
  await provisionAdmin(db, c);
  prepareSetup(db);
  // One web process owns request publication. Reclaim only its recognized
  // orphan temporary files before any HTTP request can begin a live write.
  await cleanupMapRequestTemps(c.mapJobsDir);
  await cleanupPresentationRetryTemps(c.mapJobsDir);
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
      serializers: {
        req: (r) => ({
          method: r.method,
          url: r.url?.split('?')[0],
          host: r.hostname,
          remoteAddress: r.ip,
        }),
      },
    },
    bodyLimit: 65536,
    requestTimeout: 600000,
    connectionTimeout: 30000,
    trustProxy: c.trustProxy,
  });
  app.decorateRequest('user', null);
  app.decorateRequest('guest', null);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        // Embedded glTF textures use ImageBitmapLoader.fetch(blob:). These
        // browser-local objects do not authorize any additional network host.
        connectSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: c.cookieSecure ? [] : null,
      },
    },
    hsts: c.cookieSecure ? { maxAge: 31536000 } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: c.maxUploadMb * 1024 ** 2 },
    throwFileSizeLimit: true,
  });
  app.addHook('onRequest', async (r, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (r.headers.host !== c.host) throw new HttpError(400, 'Invalid host.');
    r.user = currentUser(db, r, c);
    r.guest = currentGuest(db, r, c);
    const path = r.url.split('?')[0];
    if (
      setupRequired(db) &&
      path.startsWith('/api/') &&
      !['/api/health', '/api/config', '/api/auth/me', '/api/setup'].includes(path)
    )
      throw new HttpError(503, 'Instance setup is required.');
    if (!db.flag(c, 'public_access') && !r.user) {
      const allowed =
        [
          '/',
          '/api/config',
          '/api/health',
          '/api/auth/me',
          '/api/setup',
          '/setup',
          '/api/auth/login',
          '/api/auth/register',
          '/api/auth/steam',
          '/api/auth/steam/callback',
        ].includes(path) ||
        path.startsWith('/assets/') ||
        (['GET', 'HEAD'].includes(r.method) &&
          ([
            '/library',
            '/login',
            '/register',
            '/licenses/provider-brands.txt',
            '/account/connections',
            '/account',
            '/admin',
          ].includes(path) ||
            /^\/watch\/[A-Za-z0-9_-]+$/.test(path)));
      if (!allowed) throw new HttpError(401, 'This instance is private. Sign in to continue.');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method)) {
      if (r.headers.origin !== c.appUrl) throw new HttpError(403, 'Request origin was rejected.');
      if (
        r.user &&
        !['/api/auth/login', '/api/auth/register', '/api/setup'].includes(path) &&
        !equal(String(r.headers['x-csrf-token'] || ''), r.user.csrf)
      )
        throw new HttpError(403, 'Session expired. Refresh the page and try again.');
      if (
        !r.user &&
        r.guest &&
        !['/api/guest/session', '/api/auth/login', '/api/auth/register', '/api/setup'].includes(
          path,
        ) &&
        !equal(String(r.headers['x-csrf-token'] || ''), r.guest.csrf)
      )
        throw new HttpError(403, 'Session expired. Refresh the page and try again.');
    }
    if (path === '/api/demos' && r.method === 'POST') {
      if (r.user) rateLimit(db, r, 'upload', 15, 3600, r.user.id);
      else {
        if (!r.guest || !guestUploadsEnabled(db, c))
          throw new HttpError(401, 'Sign in to continue.');
        rateLimit(db, r, 'guest-upload-ip', 6, 3600);
        rateLimit(db, r, 'guest-upload', c.guestDemoLimit, 86400, r.guest.id);
      }
    }
  });
  app.setErrorHandler((error, r, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    if (e instanceof ZodError)
      return reply.code(400).send({ detail: 'Check the form fields and try again.' });
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply.code(413).send({ detail: 'Request exceeds the configured upload limit.' });
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) r.log.error({ err: { name: e.name, code: e.code } }, 'Request failed');
    if (status === 429 && !reply.hasHeader('retry-after')) reply.header('Retry-After', '900');
    return reply.code(status).send({
      detail:
        e instanceof HttpError
          ? e.message
          : status < 500
            ? 'Invalid request. Check the fields and try again.'
            : 'The request could not be completed. Try again later.',
    });
  });
  await authRoutes(app, db, c);
  await setupRoutes(app, db, c);
  await guestRoutes(app, db, c);
  await providerRoutes(app, db, c, providerDownload);
  steamHistoryRoutes(app, db, c);
  await equipmentAssetRoutes(app, db.root, c.mapAssetsDir, c.mapJobsDir);
  await gameplaySoundAssetRoutes(app, db.root, c.mapAssetsDir);
  await equipmentModelAssetRoutes(app, db.root, c.mapAssetsDir, c.mapJobsDir);
  viewmodelAssetRoutes(app, c.mapAssetsDir, c.mapJobsDir);
  const manualMapLocation = {
    root: c.mapAssetsDir,
    parts: [],
    key: 'manual',
    apiPrefix: '/api/maps',
    modelPrefix: '/map-assets',
  };
  const maps = await mapAssetRoutes(app, db.root, manualMapLocation);
  await mapModelFileRoutes(app, db.root, { resolveLocation: async () => manualMapLocation });
  await demoMapAssetRoutes(app, db, c, maps);
  await mapManagementRoutes(app, db, c, maps);
  await mapPreviewRoutes(app, db.root, c.mapAssetsDir);
  const visible = (row: Record<string, any>, uid?: string, guestId?: string) => ({
    ...Object.fromEntries(
      [
        'id',
        'name',
        'source',
        'status',
        'size',
        'created_at',
        'public',
        'map',
        'duration',
        'rounds',
        'error',
      ].map((k) => [k, row[k]]),
    ),
    owned: row.owner_id === uid,
    guest_owned: row.owner_id === guestId,
    expires_at:
      db.one('SELECT expires_at FROM guest_sessions WHERE owner_id=?', row.owner_id)?.expires_at ??
      null,
  });
  app.get('/api/health', async () => {
    db.one('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/config', async (r, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return {
      build: buildInfo,
      ...Object.fromEntries(Object.keys(flagDefaults).map((k) => [k, db.flag(c, k as Flag)])),
      guest_uploads_enabled: guestUploadsEnabled(db, c),
      guest_retention_hours: c.guestRetentionHours,
      setup_required: setupRequired(db),
      max_upload_mb:
        !r.user && guestUploadsEnabled(db, c)
          ? Math.min(c.maxUploadMb, c.guestStorageMb)
          : c.maxUploadMb,
      retention_days: c.retentionDays,
      steam_discovery: Boolean(c.steamApiKey),
      faceit_configured: Boolean(c.faceitApiKey),
      faceit_downloads: Boolean(c.faceitDownloadToken),
      transcription_configured: Boolean(c.transcriptionModelDir),
    };
  });
  app.get('/api/demos', async (r) => {
    const q = z
      .object({
        scope: z.literal('mine').default('mine'),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        q: z.string().trim().max(120).default(''),
      })
      .parse(r.query);
    const filter = 'owner_id=?';
    const args: (string | number)[] = [requireUser(r).id];
    const search = q.q
      ? " AND (name LIKE ? ESCAPE '\\' OR coalesce(map,'') LIKE ? ESCAPE '\\')"
      : '';
    if (q.q) {
      const pattern = '%' + q.q.replace(/[\\%_]/g, '\\$&') + '%';
      args.push(pattern, pattern);
    }
    const where = `WHERE ${filter}${search}`;
    const rows = db.all(
      `SELECT * FROM demos ${where} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?`,
      ...args,
      q.offset,
    );
    const total = db.one(`SELECT count(*) AS count FROM demos ${where}`, ...args)!.count;
    return { demos: rows.map((row) => visible(row, r.user?.id)), total };
  });
  app.post('/api/demos', async (r, reply) => {
    const u = r.user || r.guest || requireUser(r);
    const { steam_match } = z
      .object({
        steam_match: z
          .string()
          .regex(/^[1-9]\d{0,19}$/)
          .optional(),
      })
      .parse(r.query);
    function checkSteamUpload() {
      if (!steam_match) return;
      const live = currentUser(db, r, c);
      if (!r.user || !live || live.id !== u.id || live.csrf !== r.user.csrf)
        throw new HttpError(401, 'Session expired. Refresh the page and try again.');
      if (!db.one('SELECT 1 FROM steam_matches WHERE user_id=? AND match_id=?', u.id, steam_match))
        throw new HttpError(404, 'This Steam match is no longer in your history.');
    }
    checkSteamUpload();
    const uploadMb = r.user ? c.maxUploadMb : Math.min(c.maxUploadMb, c.guestStorageMb),
      file = await r.file({ limits: { fileSize: uploadMb * 1024 ** 2 } });
    if (!file) throw new HttpError(400, 'Choose a .dem or .dem.zst file.');
    const filename = basename(file.filename),
      lower = filename.toLowerCase(),
      suffix = lower.endsWith('.dem.zst') ? '.dem.zst' : lower.endsWith('.dem') ? '.dem' : null;
    if (!suffix) {
      file.file.resume();
      throw new HttpError(400, 'Only .dem and .dem.zst files are supported.');
    }
    const ext = suffix === '.dem.zst' ? '.zst' : '.dem';
    const name =
      filename.length > 120
        ? filename.slice(0, 120 - suffix.length) + filename.slice(-suffix.length)
        : filename;
    const quota = r.user
      ? c
      : {
          ...c,
          maxUploadMb: uploadMb,
          userDemoLimit: c.guestDemoLimit,
          userStorageMb: c.guestStorageMb,
        };
    const { id, folder } = reserve(db, quota, u.id, name, r.user ? 'upload' : 'guest');
    let size = 0;
    file.file.on('data', (chunk) => {
      size += chunk.length;
    });
    try {
      await pipeline(file.file, createWriteStream(join(folder, 'input' + ext), { mode: 0o600 }));
      if (file.file.truncated) throw new HttpError(413, 'Demo exceeds the upload limit.');
      validateMagic(join(folder, 'input' + ext), ext);
      db.transaction(() => {
        checkSteamUpload();
        db.run(
          "UPDATE demos SET status='queued',size=?,source_ref=? WHERE id=?",
          size,
          steam_match ? 'steam:' + steam_match : null,
          id,
        );
      });
    } catch (e) {
      abandon(db, id);
      throw e;
    }
    db.audit(u.id, 'demo.uploaded');
    reply.code(202);
    return { id };
  });
  app.get<{ Params: { id: string } }>('/api/demos/:id', async (r) =>
    visible(accessDemo(db, r.params.id, r.user, false, r.guest), r.user?.id, r.guest?.id),
  );
  const requireReplay = (demo: ReturnType<typeof accessDemo>) => {
    let version: unknown;
    try {
      version = JSON.parse(demo.metadata || '{}')?.replayVersion;
    } catch {
      /* Invalid metadata cannot establish a playable replay. */
    }
    if (demo.status !== 'ready' || version !== 3)
      throw new HttpError(409, 'This demo is not ready.');
  };
  app.get<{ Params: { id: string } }>('/api/demos/:id/playback', async (r, reply) => {
    const d = accessDemo(db, r.params.id, r.user, false, r.guest);
    requireReplay(d);
    const path = join(db.root, 'demos', d.id, 'manifest.json.gz');
    if (!existsSync(path)) throw new HttpError(404, 'Replay file not found.');
    reply.type('application/json').header('Content-Encoding', 'gzip');
    return reply.send(createReadStream(path));
  });
  app.get<{ Params: { id: string } }>('/api/demos/:id/captions', async (r, reply) => {
    const demo = accessDemo(db, r.params.id, r.user, false, r.guest);
    requireReplay(demo);
    const status = demo.transcription_status;
    if (status === 'ready' && demo.transcription_artifact) {
      let name: string;
      try {
        name = captionArtifactName(demo.transcription_artifact);
      } catch {
        throw new HttpError(503, 'Subtitles are temporarily unavailable.');
      }
      const path = join(db.root, 'demos', demo.id, name);
      if (!existsSync(path)) throw new HttpError(503, 'Subtitles are temporarily unavailable.');
      reply.type('application/json').header('Content-Encoding', 'gzip');
      return reply.send(createReadStream(path));
    }
    return { status, cues: [] };
  });
  app.post<{ Params: { id: string } }>('/api/demos/:id/captions/retry', async (r, reply) => {
    const user = requireUser(r),
      demo = accessDemo(db, r.params.id, user, true);
    requireReplay(demo);
    rateLimit(db, r, 'subtitle-retry', 3, 3600, user.id);
    z.object({})
      .strict()
      .parse(r.body ?? {});
    const result = requeueTranscription(db, c, demo);
    db.audit(user.id, 'captions.requeued');
    reply.code(result.status === 'queued' ? 202 : 200);
    return result;
  });
  app.get<{ Params: { id: string; index: string } }>(
    '/api/demos/:id/playback/chunks/:index',
    async (r, reply) => {
      const d = accessDemo(db, r.params.id, r.user, false, r.guest);
      requireReplay(d);
      if (!/^(0|[1-9]\d{0,2})$/.test(r.params.index) || Number(r.params.index) >= 512)
        throw new HttpError(404, 'Replay chunk not found.');
      const path = join(db.root, 'demos', d.id, 'chunks', `${r.params.index}.json.gz`);
      if (!existsSync(path)) throw new HttpError(404, 'Replay chunk not found.');
      reply.type('application/json').header('Content-Encoding', 'gzip');
      return reply.send(createReadStream(path));
    },
  );
  app.patch<{ Params: { id: string } }>('/api/demos/:id', async (r) => {
    const u = requireUser(r),
      d = accessDemo(db, r.params.id, u, true),
      b = z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          public: z.boolean().optional(),
        })
        .strict()
        .parse(r.body);
    db.run(
      'UPDATE demos SET name=?,public=? WHERE id=?',
      b.name ?? d.name,
      b.public === undefined ? d.public : Number(b.public),
      d.id,
    );
    db.audit(u.id, b.public === undefined ? 'demo.renamed' : 'demo.visibility_changed');
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/demos/:id', async (r) => {
    const u = r.user || r.guest || requireUser(r),
      d = accessDemo(db, r.params.id, r.user, true, r.guest);
    if (['uploading', 'processing'].includes(d.status))
      throw new HttpError(409, 'Wait for processing to finish before deleting.');
    abandon(db, d.id);
    db.audit(u.id, 'demo.deleted');
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/demos/:id/bookmarks', async (r) => {
    const u = requireUser(r);
    accessDemo(db, r.params.id, u);
    return db.all(
      'SELECT id,tick,label FROM bookmarks WHERE demo_id=? AND user_id=? ORDER BY tick',
      r.params.id,
      u.id,
    );
  });
  app.post<{ Params: { id: string } }>('/api/demos/:id/bookmarks', async (r, reply) => {
    const u = requireUser(r),
      d = accessDemo(db, r.params.id, u),
      b = z
        .object({
          tick: z.number().int().min(0).max(1e8),
          label: z.string().trim().min(1).max(100),
        })
        .parse(r.body),
      summary = JSON.parse(d.metadata || '{}');
    if (d.status !== 'ready' || b.tick < summary.firstTick || b.tick > summary.lastTick)
      throw new HttpError(400, 'Bookmark is outside this demo.');
    rateLimit(db, r, 'bookmarks', 100, 3600, u.id);
    const id = token().slice(0, 32);
    db.run('INSERT INTO bookmarks VALUES(?,?,?,?,?)', id, d.id, u.id, b.tick, b.label);
    reply.code(201);
    return { id, ...b };
  });
  app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', async (r) => {
    const u = requireUser(r);
    db.run('DELETE FROM bookmarks WHERE id=? AND user_id=?', r.params.id, u.id);
    return { ok: true };
  });
  app.get('/api/admin', async (r) => {
    requireAdmin(r);
    const { diagnostics: mapReadiness } = await readMapPreparationState(
      c,
      db.flag(c, 'auto_official_maps_enabled'),
    );
    return {
      mapReadiness,
      presentationAssets: await readPresentationStatus(c.mapJobsDir),
      flags: Object.fromEntries(
        Object.keys(flagDefaults).map((k) => [
          k,
          { value: db.flag(c, k as Flag), locked: c.flags[k as Flag] !== undefined },
        ]),
      ),
      users: db.all(
        'SELECT id,username,is_admin,created_at FROM users u WHERE NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id) ORDER BY created_at DESC LIMIT 100',
      ),
      queue: db.all('SELECT status,count(*) AS count FROM demos GROUP BY status'),
      audit: db.all('SELECT action,created_at FROM audit ORDER BY id DESC LIMIT 20'),
    };
  });
  app.patch('/api/admin', async (r) => {
    const u = requireAdmin(r),
      b = z
        .partialRecord(z.enum(Object.keys(flagDefaults) as [Flag, ...Flag[]]), z.boolean())
        .refine((values) => Object.keys(values).length > 0)
        .parse(r.body);
    db.transaction(() => {
      for (const [k, v] of Object.entries(b))
        if (c.flags[k as Flag] === undefined)
          db.run(
            'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            k,
            Number(v),
          );
    });
    db.audit(u.id, 'settings.updated');
    return { ok: true };
  });
  if (existsSync(join(c.frontendDir, 'assets')))
    await app.register(staticFiles, {
      root: join(c.frontendDir, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
      dotfiles: 'deny',
      cacheControl: false,
    });
  app.route({
    method: ['GET', 'HEAD'],
    url: '/licenses/provider-brands.txt',
    handler: async (_request, reply) => {
      const notice = join(c.frontendDir, 'licenses/provider-brands.txt');
      if (!existsSync(notice)) throw new HttpError(404, 'Not found.');
      return reply.type('text/plain; charset=utf-8').send(createReadStream(notice));
    },
  });
  app.setNotFoundHandler(async (r, reply) => {
    if (
      r.url.startsWith('/api/') ||
      r.url.startsWith('/assets/') ||
      r.url.startsWith('/map-assets/')
    )
      throw new HttpError(404, 'Not found.');
    if (!existsSync(join(c.frontendDir, 'index.html')))
      throw new HttpError(503, 'Build the frontend first.');
    return reply.type('text/html').send(createReadStream(join(c.frontendDir, 'index.html')));
  });
  app.addHook('onClose', async () => db.close());
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const c = loadConfig();
  const app = await createApp(c, openStoreForStartup(c.dataDir));
  await app.listen({ port: c.port, host: '0.0.0.0' });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
