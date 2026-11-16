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
import { Store, now } from './db.js';
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
import { providerRoutes } from './providers.js';

export async function createApp(c: Config, db = new Store(c.dataDir)) {
  process.umask(0o077);
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
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
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
    r.user = currentUser(db, r);
    const path = r.url.split('?')[0];
    if (!db.flag(c, 'public_access') && !r.user) {
      const allowed =
        [
          '/',
          '/api/config',
          '/api/health',
          '/api/auth/me',
          '/api/auth/login',
          '/api/auth/register',
          '/api/auth/steam',
          '/api/auth/steam/callback',
        ].includes(path) ||
        path.startsWith('/assets/') ||
        (['GET', 'HEAD'].includes(r.method) &&
          ([
            '/library',
            '/connections',
            '/account',
            '/admin',
            '/explore',
            '/self-host',
            '/features/viewer',
            '/features/imports',
          ].includes(path) ||
            /^\/watch\/[A-Za-z0-9_-]+$/.test(path)));
      if (!allowed) throw new HttpError(401, 'This instance is private. Sign in to continue.');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method)) {
      if (r.headers.origin !== c.appUrl) throw new HttpError(403, 'Request origin was rejected.');
      if (
        r.user &&
        !['/api/auth/login', '/api/auth/register'].includes(path) &&
        !equal(String(r.headers['x-csrf-token'] || ''), r.user.csrf)
      )
        throw new HttpError(403, 'Session expired. Refresh the page and try again.');
    }
    if (path === '/api/demos' && r.method === 'POST') {
      requireUser(r);
      rateLimit(db, r, 'upload', 15, 3600, r.user!.id);
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
    if (status === 429) reply.header('Retry-After', '900');
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
  await providerRoutes(app, db, c);
  const visible = (row: Record<string, any>, uid?: string) => ({
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
  });
  app.get('/api/health', async () => {
    db.one('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/config', async () => ({
    ...Object.fromEntries(Object.keys(flagDefaults).map((k) => [k, db.flag(c, k as Flag)])),
    max_upload_mb: c.maxUploadMb,
    retention_days: c.retentionDays,
    steam_discovery: Boolean(c.steamApiKey),
    faceit_configured: Boolean(c.faceitApiKey),
    faceit_downloads: Boolean(c.faceitDownloadToken),
  }));
  app.get('/api/demos', async (r) => {
    const q = z
      .object({
        scope: z.enum(['mine', 'public']).default('mine'),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(r.query);
    const rows =
      q.scope === 'public'
        ? db.all(
            "SELECT * FROM demos WHERE public=1 AND status='ready' ORDER BY created_at DESC LIMIT 50 OFFSET ?",
            q.offset,
          )
        : db.all(
            'SELECT * FROM demos WHERE owner_id=? ORDER BY created_at DESC LIMIT 50 OFFSET ?',
            requireUser(r).id,
            q.offset,
          );
    return { demos: rows.map((row) => visible(row, r.user?.id)) };
  });
  app.post('/api/demos', async (r, reply) => {
    const u = requireUser(r),
      file = await r.file();
    if (!file) throw new HttpError(400, 'Choose a .dem or .dem.zst file.');
    const name = basename(file.filename).slice(0, 120),
      lower = name.toLowerCase(),
      ext = lower.endsWith('.dem.zst') ? '.zst' : lower.endsWith('.dem') ? '.dem' : null;
    if (!ext) {
      file.file.resume();
      throw new HttpError(400, 'Only .dem and .dem.zst files are supported.');
    }
    const { id, folder } = reserve(db, c, u.id, name, 'upload');
    let size = 0;
    file.file.on('data', (chunk) => {
      size += chunk.length;
    });
    try {
      await pipeline(file.file, createWriteStream(join(folder, 'input' + ext), { mode: 0o600 }));
      if (file.file.truncated) throw new HttpError(413, 'Demo exceeds the upload limit.');
      validateMagic(join(folder, 'input' + ext), ext);
      db.run("UPDATE demos SET status='queued',size=? WHERE id=?", size, id);
    } catch (e) {
      abandon(db, id);
      throw e;
    }
    db.audit(u.id, 'demo.uploaded');
    reply.code(202);
    return { id };
  });
  app.get<{ Params: { id: string } }>('/api/demos/:id', async (r) =>
    visible(accessDemo(db, r.params.id, r.user), r.user?.id),
  );
  app.get<{ Params: { id: string } }>('/api/demos/:id/playback', async (r, reply) => {
    const d = accessDemo(db, r.params.id, r.user);
    if (d.status !== 'ready') throw new HttpError(409, 'This demo is not ready.');
    reply.type('application/json').header('Content-Encoding', 'gzip');
    return reply.send(createReadStream(join(db.root, 'demos', d.id, 'playback.json.gz')));
  });
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
    const u = requireUser(r),
      d = accessDemo(db, r.params.id, u, true);
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
  app.get<{ Params: { name: string } }>('/api/maps/:name', async (r) => {
    const name = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .parse(r.params.name);
    return {
      model: existsSync(join(db.root, 'maps', name, 'desktop', 'scene.glb'))
        ? `/map-assets/${name}/desktop/scene.glb`
        : existsSync(join(db.root, 'maps', name + '.glb'))
          ? `/map-assets/${name}.glb`
          : null,
      mobile: existsSync(join(db.root, 'maps', name, 'mobile', 'scene.glb'))
        ? `/map-assets/${name}/mobile/scene.glb`
        : null,
    };
  });
  app.get('/api/assets/agents', async () => ({
    ct: existsSync(join(db.root, 'maps', 'agents', 'ct.glb')) ? '/map-assets/agents/ct.glb' : null,
    t: existsSync(join(db.root, 'maps', 'agents', 't.glb')) ? '/map-assets/agents/t.glb' : null,
  }));
  app.get('/api/admin', async (r) => {
    requireAdmin(r);
    return {
      flags: Object.fromEntries(
        Object.keys(flagDefaults).map((k) => [
          k,
          { value: db.flag(c, k as Flag), locked: c.flags[k as Flag] !== undefined },
        ]),
      ),
      users: db.all(
        'SELECT id,username,is_admin,created_at FROM users ORDER BY created_at DESC LIMIT 100',
      ),
      queue: db.all('SELECT status,count(*) AS count FROM demos GROUP BY status'),
      audit: db.all('SELECT action,created_at FROM audit ORDER BY id DESC LIMIT 20'),
    };
  });
  app.patch('/api/admin', async (r) => {
    const u = requireAdmin(r),
      b = z
        .object({
          public_access: z.boolean(),
          registrations_enabled: z.boolean(),
          steam_enabled: z.boolean(),
          faceit_enabled: z.boolean(),
        })
        .strict()
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
  await app.register(staticFiles, {
    root: join(db.root, 'maps'),
    prefix: '/map-assets/',
    decorateReply: false,
    dotfiles: 'deny',
    cacheControl: false,
    allowedPath: (p) => /\.(glb|gltf|bin|png|jpe?g|webp|ktx2)$/i.test(p),
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
  const app = await createApp(c);
  await app.listen({ port: c.port, host: '0.0.0.0' });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
