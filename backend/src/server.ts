import {
  acceptsHtml,
  connectionTimeoutMs,
  firstPartyRequest,
  requireMutationRequest,
} from './request-security.js';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import {
  emailDeliveryEnabled,
  loadConfig,
  flagDefaults,
  type Config,
  type Flag,
} from './config.js';
import { AccountMail, accountMailRoutes, retireAccountMail } from './account-mail.js';
import { Store, openStoreForStartup } from './db.js';
import { buildInfo } from './build-info.js';
import {
  HttpError,
  accountOnboardingError,
  accountOnboardingRequired,
  browserCookieName,
  sessionCookieName,
  chargeBudgets,
  currentSession,
  equal,
  signableAdminExists,
  hasSteamOnlyAccounts,
  currentUser,
  rateLimit,
  requireSession,
  requireUser,
  safeReturnPath,
  sessionUser,
  token,
  touchSession,
} from './security.js';
import { faceitId, linkedSteamId, matchEvidence } from './match-library.js';
import { abandonUpload, accessDemo, reserve, validateMagic } from './ingestion.js';
import {
  adminAccess,
  adminDenialRecorder,
  adminApi,
  adminPage,
  adminPublicationAccountedFor,
} from './admin-access.js';
import { adminRoutes } from './admin-routes.js';
import {
  cleanupDeletedDemos,
  demoWriteTimeoutMs,
  enqueueUserDemoDeletion,
} from './demo-deletion.js';
import { adminClientAddress, adminNetworkDenial, trustProxyAddress } from './admin-network.js';
import { hasPermission } from './roles.js';
import { authRoutes } from './auth.js';
import {
  accountEntry,
  allowedAccountOnboarding,
  allowedAnonymous,
  allowedBeforeSetup,
  allowedPending,
  authShellRoute,
  isRead,
} from './auth-routes.js';
import { registerFactorRoutes } from './factors.js';
import { recoveryRoutes } from './recovery.js';
import { ProviderRequests } from './provider-requests.js';
import { createSteamCoordinator } from './steam-coordinator.js';
import { steamImportRoutes } from './steam-import.js';
import { prepareSteamImports, SteamAutoImporter } from './steam-auto-import.js';
import { steamHistoryRoutes } from './steam-history.js';
import { openEncryptionKey, openEncryptionKeyForStartup } from './encryption-key.js';
import { providerRoutes } from './providers.js';
import { captionArtifactName } from './captions.js';
import { requeueTranscription } from './transcription-worker.js';
import { gameplaySoundAssetRoutes } from './gameplay-sound-assets.js';
import { effectAssetRoutes } from './effect-assets.js';
import { equipmentAssetRoutes } from './equipment-assets.js';
import { equipmentModelAssetRoutes } from './equipment-model-assets.js';
import { viewmodelAssetRoutes } from './viewmodel-assets.js';
import { mapAssetRoutes } from './map-assets.js';
import { mapModelFileRoutes } from './model-files.js';
import { mapPreviewRoutes } from './map-preview.js';
import { mapManagementRoutes } from './map-management.js';
import { demoMapAssetRoutes } from './demo-map-assets.js';
import { cleanupMapRequestTemps } from './map-jobs.js';
import { cleanupPresentationRetryTemps } from './presentation-assets.js';
import { cleanupAgentModelRequestTemps, syncAgentModelRequests } from './agent-model-requests.js';
import {
  confirmGuestDelivery,
  currentGuest,
  currentReservedGuest,
  guestRoutes,
  guestUploadsEnabled,
} from './guest.js';
import { prepareSetup, provisionAdmin, setupRequired, setupRoutes } from './setup.js';
import { requestLogger } from './request-logger.js';

export async function createApp(
  c: Config,
  db = new Store(c.dataDir),
  providerDownload?: Parameters<typeof providerRoutes>[4],
  steam: {
    steamCoordinator?: Parameters<typeof steamImportRoutes>[3];
    steamDownload?: Parameters<typeof steamImportRoutes>[5];
  } = {},
) {
  process.umask(0o077);
  const key = openEncryptionKey(c, db);
  if (Boolean(c.adminUsername) !== Boolean(c.adminPassword))
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured together.');
  if (c.adminEmail && !c.adminUsername)
    throw new Error('ADMIN_EMAIL requires ADMIN_USERNAME and ADMIN_PASSWORD.');
  await provisionAdmin(db, c);
  const lockedSteamOnlyAccounts = db.transaction(() => {
    if (!setupRequired(db) && !signableAdminExists(db, c))
      throw new Error(
        'No administrator can sign in with the configured providers. Run create-admin in the local account CLI.',
      );
    db.bindRelyingParty(c);
    db.retireIneligibleSessions(c);
    if (!emailDeliveryEnabled(db, c)) retireAccountMail(db);
    return c.flags.steam_enabled === false && hasSteamOnlyAccounts(db);
  });
  prepareSetup(db);
  // One web process owns request publication. Reclaim only its recognized
  // orphan temporary files before any HTTP request can begin a live write.
  await cleanupMapRequestTemps(c.mapJobsDir);
  await cleanupPresentationRetryTemps(c.mapJobsDir);
  await cleanupAgentModelRequestTemps(c.mapJobsDir);
  const app = Fastify({
    logger: requestLogger(),
    bodyLimit: 65536,
    requestTimeout: demoWriteTimeoutMs,
    connectionTimeout: connectionTimeoutMs,
    trustProxy: c.trustProxy ? (ip) => trustProxyAddress(c, ip) : false,
  });
  const mail = new AccountMail(db, c, () => app.log.warn('Account email submission failed.'));
  const recordAdminDenial = adminDenialRecorder(db, c);
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.decorateRequest('clientAddress', null);
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
  if (lockedSteamOnlyAccounts)
    app.log.warn(
      'STEAM_ENABLED=false blocks sign-in for accounts that rely on Steam. Restore Steam until members add another sign-in method or use individual password recovery in Administration.',
    );
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: c.maxUploadMb * 1024 ** 2 },
    throwFileSizeLimit: true,
  });
  function sessionChanged(reply: FastifyReply) {
    reply.header('X-Session-Changed', '1');
    return new HttpError(409, 'Session expired. Refresh the page and try again.');
  }
  function checkReadContext(r: FastifyRequest, reply: FastifyReply) {
    revalidatePrincipal(r);
    const context = r.headers['x-session-context'];
    const guest = r.headers['x-guest-context'];
    if (
      context !== undefined &&
      (typeof context !== 'string' || !equal(context, currentSession(db, r, c)?.csrf ?? ''))
    )
      throw sessionChanged(reply);
    if (
      guest !== undefined &&
      (typeof guest !== 'string' || !equal(guest, currentGuest(db, r, c)?.csrf ?? ''))
    )
      throw sessionChanged(reply);
  }
  app.addHook('onRequest', async (r, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
      );
    if (r.headers.host !== c.host) throw new HttpError(400, 'Invalid host.');
    r.clientAddress = adminClientAddress(r, c)?.ip ?? null;
    const session = currentSession(db, r, c);
    r.authSession = session;
    const onboarding = accountOnboardingRequired(db, c, session);
    r.user = session?.stage === 'full' && !onboarding ? sessionUser(session) : null;
    const path = r.url.split('?')[0];
    const route = r.routeOptions.url ?? '';
    const apiRoute = route.startsWith('/api/') || path.startsWith('/api/');
    // A browser view may still hold another tab's old account context. Bind
    // its opt-in reads to the session before any private response is selected.
    const context = r.headers['x-session-context'];
    if (
      (isRead(r) || adminApi(route)) &&
      apiRoute &&
      context !== undefined &&
      (typeof context !== 'string' || !session || !equal(context, session.csrf))
    ) {
      throw sessionChanged(reply);
    }
    if (isRead(r) && adminPage(r.url)) {
      let destination: string | undefined;
      if (setupRequired(db)) destination = '/setup';
      else if (onboarding) destination = '/account?returnTo=%2Fadmin';
      else if (!r.user) destination = '/login?returnTo=%2Fadmin';
      if (destination) {
        recordAdminDenial(r);
        return reply.redirect(destination);
      }
      adminAccess(db, c, r, false);
    }
    const pending =
      session?.stage === 'challenge' || session?.stage === 'enroll' ? session.stage : null;
    if (setupRequired(db) && apiRoute && !allowedBeforeSetup(r))
      throw new HttpError(503, 'Instance setup is required.');
    if (pending && !allowedPending(r, pending) && !authShellRoute(r, path, true)) {
      if (authShellRoute(r, path, false)) {
        const entry = pending === 'enroll' ? '/account' : '/login';
        return reply.redirect(
          entry + '?' + new URLSearchParams({ returnTo: safeReturnPath(r.url) }),
          303,
        );
      }
      throw new HttpError(403, 'Complete sign-in to continue.');
    }
    if (onboarding && !allowedAccountOnboarding(r) && !authShellRoute(r, path, true)) {
      if (authShellRoute(r, path, false))
        return reply.redirect(
          '/account?' + new URLSearchParams({ returnTo: safeReturnPath(r.url) }),
          303,
        );
      throw accountOnboardingError();
    }
    if (
      !db.flag(c, 'public_access') &&
      !r.user &&
      !pending &&
      !onboarding &&
      !allowedAnonymous(r) &&
      !authShellRoute(r, path, false)
    )
      throw new HttpError(401, 'This instance is private. Sign in to continue.');
    r.guest = pending || onboarding || r.user ? null : currentGuest(db, r, c);
    if (!isRead(r) && r.method !== 'OPTIONS') {
      // A request that supplied a retired browser grant cannot silently switch
      // to capability-only authority while a successor cookie is in transit.
      if (
        r.guest &&
        !session &&
        (r.cookies[browserCookieName(c)] !== undefined ||
          r.cookies[sessionCookieName(c)] !== undefined)
      )
        throw sessionChanged(reply);
      const accountRoute =
        route.startsWith('/api/auth/') ||
        route === '/api/setup' ||
        route === '/api/account/email/verification/request';
      const csrf = accountRoute ? session?.csrf : (r.user?.csrf ?? r.guest?.csrf ?? session?.csrf);
      const hasBody =
        r.method !== 'DELETE' ||
        ['content-type', 'content-length', 'transfer-encoding'].some(
          (name) => r.headers[name] !== undefined,
        );
      requireMutationRequest(
        r,
        c,
        csrf,
        (accountRoute || route === '/api/guest/session') && hasBody,
      );
    }
    if (route === '/api/demos' && r.method === 'POST') {
      if (r.user) rateLimit(db, r, 'upload', 15, 3600, r.user.id);
      else {
        if (!r.guest || !guestUploadsEnabled(db, c))
          throw new HttpError(401, 'Sign in to continue.');
        confirmGuestDelivery(db, r.guest);
        rateLimit(db, r, 'guest-upload-ip', 6, 3600);
      }
    }
  });
  app.addHook('onRequest', async (r) => {
    if (adminApi(r.routeOptions.url)) adminAccess(db, c, r, !isRead(r));
  });
  function revalidatePrincipal(r: FastifyRequest) {
    if (r.authSession && currentSession(db, r, c)?.token_hash !== r.authSession.token_hash)
      throw new HttpError(401, 'Session expired. Refresh the page and try again.');
    if (r.guest && !r.user && currentGuest(db, r, c)?.csrf !== r.guest.csrf)
      throw new HttpError(401, 'Session expired. Refresh the page and try again.');
  }
  app.addHook('preHandler', async (r) => {
    if (adminApi(r.routeOptions.url) || adminPage(r.url)) adminAccess(db, c, r, !isRead(r));
    // Body parsing may yield after the request gate accepted a credential.
    if (r.authSession && firstPartyRequest(r, c)) touchSession(db, r.authSession, c);
    revalidatePrincipal(r);
    if (r.guest && r.routeOptions.url === '/api/auth/me' && firstPartyRequest(r, c))
      confirmGuestDelivery(db, r.guest);
  });
  app.addHook('onSend', async (r, reply, payload) => {
    const route = r.routeOptions.url ?? '';
    if (
      reply.statusCode < 400 &&
      isRead(r) &&
      (route === '/map-assets/*' ||
        /^\/api\/(?:assets|maps|map-preview|sound-assets|effect-assets)(?:\/|$)/.test(route))
    ) {
      try {
        revalidatePrincipal(r);
        if (!db.flag(c, 'public_access') && !currentUser(db, r, c))
          throw new HttpError(401, 'This instance is private. Sign in to continue.');
      } catch (error) {
        if (
          payload &&
          typeof payload === 'object' &&
          'destroy' in payload &&
          typeof payload.destroy === 'function'
        )
          payload.destroy();
        for (const name of [
          'ETag',
          'Content-Length',
          'Content-Type',
          'Content-Range',
          'Accept-Ranges',
          'Content-Encoding',
          'X-File-Size',
          'Last-Modified',
        ])
          reply.removeHeader(name);
        reply.header('Cache-Control', 'no-store');
        throw error;
      }
    }
    return payload;
  });
  app.addHook('onError', async (r) => {
    if (adminPublicationAccountedFor(r) || (!adminApi(r.routeOptions.url) && !adminPage(r.url)))
      return;
    try {
      recordAdminDenial(r);
    } catch {
      r.log.error('Administration denial could not be recorded');
    }
  });
  const frontendIndex = join(c.frontendDir, 'index.html');
  function sendAppShell(reply: FastifyReply) {
    if (!existsSync(frontendIndex)) throw new HttpError(503, 'Build the frontend first.');
    return reply.type('text/html').send(createReadStream(frontendIndex));
  }
  app.setErrorHandler((error, r, reply) => {
    let e = error as Error & { statusCode?: number; code?: string };
    const { code } = e;
    const context = r.headers['x-session-context'];
    const guestContext = r.headers['x-guest-context'];
    const adminRequest = adminApi(r.routeOptions.url);
    if (
      e instanceof HttpError &&
      (e.statusCode === 401 || e.statusCode === 403) &&
      (isRead(r) || adminRequest) &&
      (context !== undefined || guestContext !== undefined)
    ) {
      const live = currentSession(db, r, c);
      const changed =
        (context !== undefined &&
          (typeof context !== 'string' || !live || !equal(live.csrf, context))) ||
        (guestContext !== undefined &&
          (typeof guestContext !== 'string' ||
            !equal(currentGuest(db, r, c)?.csrf ?? '', guestContext))) ||
        (adminRequest && (!live || live.stage !== 'full' || !hasPermission(live.role, 'admin')));
      if (changed) e = sessionChanged(reply);
    }
    if (
      r.routeOptions.url === '/api/auth/steam/callback' &&
      r.headers.host === c.host &&
      (e instanceof HttpError || e instanceof ZodError) &&
      acceptsHtml(r)
    ) {
      // A browser may return after its account or state expired. Only an
      // already authenticated, bound callback may use its saved destination.
      return reply.redirect('/login?steam=verification-failed', 303);
    }
    if (e instanceof ZodError)
      return reply.code(400).send({ detail: 'Check the form fields and try again.' });
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply.code(413).send({ detail: 'Request exceeds the configured upload limit.' });
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    // The static application shell contains no private data. Keep the denial
    // on the requested page while privileged API responses stay independent.
    if (status === 403 && r.user && isRead(r) && adminPage(r.url) && acceptsHtml(r))
      return sendAppShell(reply.code(403));
    if (status >= 500) r.log.error({ err: { code, statusCode: status } }, 'Request failed');
    if (
      (status === 429 || (status === 503 && e instanceof HttpError && e.retryAfter)) &&
      !reply.hasHeader('retry-after')
    )
      reply.header('Retry-After', String(e instanceof HttpError ? (e.retryAfter ?? 60) : 60));
    return reply.code(status).send({
      ...(e instanceof HttpError && e.code ? { code: e.code } : {}),
      detail:
        e instanceof HttpError
          ? e.message
          : status < 500
            ? 'Invalid request. Check the fields and try again.'
            : 'The request could not be completed. Try again later.',
    });
  });
  const requests = new ProviderRequests(db, c.providerLimits);
  const providers = await providerRoutes(app, db, c, requests, providerDownload);
  await authRoutes(app, db, c, requests, providers.invalidate, mail);
  await registerFactorRoutes(app, db, c, key);
  await recoveryRoutes(app, db, c);
  accountMailRoutes(app, db, c, mail);
  await setupRoutes(app, db, c);
  await guestRoutes(app, db, c);
  prepareSteamImports(db);
  const coordinator =
    steam.steamCoordinator ??
    createSteamCoordinator(c, requests, {
      onFailure: (diagnostic) => app.log.warn(diagnostic, 'Steam Coordinator request failed'),
    });
  const imports = steamImportRoutes(app, db, c, coordinator, requests, steam.steamDownload);
  const sync = steamHistoryRoutes(app, db, c, key, requests, (userId) =>
    autoImports.cancel(userId),
  );
  const autoImports = new SteamAutoImporter(db, c, sync, imports.importAutomatic);
  let stopAgentModelRequests: (() => void) | undefined;
  app.addHook('onReady', async () => {
    autoImports.start(() => app.log.error('Steam automatic import queue could not be checked'));
    // Official agents recorded by ready demos, for the asset worker to prepare.
    stopAgentModelRequests = syncAgentModelRequests(db, c.mapJobsDir, () =>
      app.log.error('Agent model requests could not be published'),
    );
  });
  await equipmentAssetRoutes(app, db.root, c.mapAssetsDir, c.mapJobsDir);
  await gameplaySoundAssetRoutes(app, db.root, c.mapAssetsDir);
  await effectAssetRoutes(app, c.mapAssetsDir);
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
    source: row.source_ref?.startsWith('steam:') ? 'steam' : row.source,
    owned: row.owner_id === uid,
    guest_owned: row.owner_id === guestId,
    expires_at:
      db.one('SELECT expires_at FROM guest_sessions WHERE owner_id=?', row.owner_id)?.expires_at ??
      null,
  });
  app.get('/api/health', accountEntry('setup'), async () => {
    db.one('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/config', accountEntry('status'), async (r, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return db.transaction(() => {
      checkReadContext(r, reply);
      const administrator = hasPermission(r.user?.role, 'admin');
      const denial = administrator ? adminNetworkDenial(r, c) : null;
      const adminAccess = administrator && !denial;
      return {
        build: buildInfo,
        admin_access: adminAccess,
        ...(denial
          ? { admin_network_denial: denial.reason, admin_network_diagnostic: denial.diagnostic }
          : {}),
        ...Object.fromEntries(Object.keys(flagDefaults).map((k) => [k, db.flag(c, k as Flag)])),
        guest_uploads_enabled: guestUploadsEnabled(db, c),
        email_delivery_enabled: emailDeliveryEnabled(db, c),
        guest_retention_hours: c.guestRetentionHours,
        setup_required: setupRequired(db),
        max_upload_mb:
          !r.user && guestUploadsEnabled(db, c)
            ? Math.min(c.maxUploadMb, c.guestStorageMb)
            : c.maxUploadMb,
        retention_days: c.retentionDays,
        ...(adminAccess ? { steam_discovery: Boolean(c.steamApiKey) } : {}),
        transcription_configured: Boolean(c.transcriptionModelDir),
      };
    });
  });
  app.get('/api/demos', async (r) => {
    const q = z
      .object({
        scope: z.literal('mine').default('mine'),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        q: z.string().trim().max(120).default(''),
        source: z.enum(['upload', 'faceit', 'steam']).optional(),
      })
      .parse(r.query);
    const filter = 'owner_id=?';
    const member = requireUser(r).id;
    const args: (string | number)[] = [member];
    const search = q.q
      ? " AND (name LIKE ? ESCAPE '\\' OR coalesce(map,'') LIKE ? ESCAPE '\\')"
      : '';
    if (q.q) {
      const pattern = '%' + q.q.replace(/[\\%_]/g, '\\$&') + '%';
      args.push(pattern, pattern);
    }
    const source = q.source
      ? " AND CASE WHEN source_ref LIKE 'steam:%' THEN 'steam' ELSE source END=?"
      : '';
    if (q.source) args.push(q.source);
    const where = `WHERE ${filter}${search}${source}`;
    const rows = db.all(
      `SELECT * FROM demos ${where} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?`,
      ...args,
      q.offset,
    );
    const total = db.one(`SELECT count(*) AS count FROM demos ${where}`, ...args)!.count;
    const subject = linkedSteamId(db, member);
    const faceitSubject = db.one(
      "SELECT subject FROM identities WHERE user_id=? AND provider='faceit'",
      member,
    )?.subject;
    return {
      demos: rows.map((row) => ({
        ...visible(row, member),
        ...matchEvidence(row, subject, faceitSubject),
      })),
      total,
    };
  });
  app.post('/api/demos', async (r, reply) => {
    const u = r.user || r.guest || requireUser(r);
    const { steam_match, faceit_match } = z
      .object({
        faceit_match: faceitId.optional(),
        steam_match: z
          .string()
          .regex(/^[1-9]\d{0,19}$/)
          .optional(),
      })
      .parse(r.query);
    if (steam_match && faceit_match) throw new HttpError(400, 'Choose one match for this upload.');
    const operation = faceit_match ? providers.operationFor(requireUser(r).id) : undefined;
    try {
      const faceit = faceit_match
        ? await providers.verifyFaceitUpload(r, requireUser(r), faceit_match)
        : undefined;
      const anonymousUpload = !r.user && r.authSession?.stage === 'anonymous';
      function checkUploadOwner(reservedDemo?: string) {
        if (faceit) {
          providers.revalidateFaceit(r, requireUser(r), faceit.subject);
          if (operation?.signal.aborted)
            throw new HttpError(409, 'The FACEIT connection changed. Try again.');
        }
        const live = r.user
          ? currentUser(db, r, c)
          : anonymousUpload && reservedDemo
            ? currentReservedGuest(db, r, c, reservedDemo)
            : currentGuest(db, r, c);
        if (!live || live.id !== u.id || live.csrf !== u.csrf)
          throw new HttpError(401, 'Session expired. Refresh the page and try again.');
        if (
          steam_match &&
          (!r.user ||
            !db.one(
              'SELECT 1 FROM steam_matches WHERE user_id=? AND match_id=?',
              u.id,
              steam_match,
            ))
        )
          throw new HttpError(404, 'This Steam match is no longer in your history.');
      }
      checkUploadOwner();
      const uploadMb = r.user ? c.maxUploadMb : Math.min(c.maxUploadMb, c.guestStorageMb),
        file = await r.file({ limits: { fileSize: uploadMb * 1024 ** 2 } });
      const formats = steam_match
        ? {
            extensions: ['.dem', '.dem.zst', '.dem.bz2'],
            choose: 'Choose a .dem, .dem.zst or .dem.bz2 file.',
            unsupported: 'Only .dem, .dem.zst and .dem.bz2 files are supported for Steam matches.',
          }
        : faceit
          ? {
              extensions: ['.dem', '.dem.zst', '.dem.gz'],
              choose: 'Choose a .dem, .dem.zst or .dem.gz file.',
              unsupported:
                'Only .dem, .dem.zst and .dem.gz files are supported for FACEIT matches.',
            }
          : {
              extensions: ['.dem', '.dem.zst'],
              choose: 'Choose a .dem or .dem.zst file.',
              unsupported: 'Only .dem and .dem.zst files are supported.',
            };
      if (!file) throw new HttpError(400, formats.choose);
      const filename = basename(file.filename),
        lower = filename.toLowerCase(),
        suffix = formats.extensions.find((candidate) => lower.endsWith(candidate));
      if (!suffix) {
        file.file.resume();
        throw new HttpError(400, formats.unsupported);
      }
      const ext = suffix.slice(suffix.lastIndexOf('.'));
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
      checkUploadOwner();
      const { id, folder, writeExpiresAt } = reserve(
        db,
        quota,
        u.id,
        name,
        r.user ? 'upload' : 'guest',
        null,
        steam_match ? 'steam:' + steam_match : null,
        (deadline) => {
          checkUploadOwner();
          if (r.user) return;
          const browser = anonymousUpload ? requireSession(db, r, c, ['anonymous']) : null;
          if (browser && browser.expires_at * 1000 < deadline)
            throw new HttpError(409, 'Could not start a private upload. Try again.');
          chargeBudgets(db, r, [['guest-upload', c.guestDemoLimit, 86400, u.id]]);
          return browser?.token_hash;
        },
      );
      const deadline = AbortSignal.timeout(
        Math.max(1, Math.min(demoWriteTimeoutMs, writeExpiresAt - Date.now())),
      );
      const signal = operation ? AbortSignal.any([operation.signal, deadline]) : deadline;
      let size = 0;
      file.file.on('data', (chunk) => {
        size += chunk.length;
      });
      try {
        await pipeline(file.file, createWriteStream(join(folder, 'input' + ext), { mode: 0o600 }), {
          signal,
        });
        if (file.file.truncated) throw new HttpError(413, 'Demo exceeds the upload limit.');
        validateMagic(join(folder, 'input' + ext), ext);
        db.transaction(() => {
          if (Date.now() >= writeExpiresAt)
            throw new HttpError(408, 'The upload timed out. Try again.');
          checkUploadOwner(id);
          const updated = db.run(
            "UPDATE demos SET status='queued',size=?,source_ref=?,source=?,faceit_match_id=?,metadata=? WHERE id=? AND owner_id=? AND status='uploading'",
            size,
            steam_match ? 'steam:' + steam_match : null,
            faceit ? 'faceit' : r.user ? 'upload' : 'guest',
            faceit_match ?? null,
            faceit
              ? JSON.stringify({ faceitMatch: faceit.summary, faceitSubject: faceit.subject })
              : null,
            id,
            u.id,
          );
          if (updated.changes !== 1) throw new HttpError(409, 'Upload is no longer active.');
          if (anonymousUpload) db.run('DELETE FROM guest_upload_grants WHERE demo_id=?', id);
        });
      } catch (e) {
        abandonUpload(db, id);
        if (operation?.signal.aborted)
          throw new HttpError(409, 'The FACEIT connection changed. Try again.');
        if (deadline.aborted) throw new HttpError(408, 'The upload timed out. Try again.');
        throw e;
      }
      db.audit(r.user?.id ?? null, 'demo.uploaded');
      reply.code(202);
      return { id };
    } finally {
      operation?.finish();
    }
  });
  app.get<{ Params: { id: string } }>('/api/demos/:id', (r, reply) =>
    db.transaction(() => {
      checkReadContext(r, reply);
      return visible(accessDemo(db, r.params.id, r.user, false, r.guest), r.user?.id, r.guest?.id);
    }),
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
    const result = requeueTranscription(db, c, demo, () => revalidatePrincipal(r));
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
  app.patch<{ Params: { id: string } }>('/api/demos/:id', (r) =>
    db.transaction(() => {
      revalidatePrincipal(r);
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
    }),
  );
  app.delete<{ Params: { id: string } }>('/api/demos/:id', async (r) => {
    db.transaction(() => {
      revalidatePrincipal(r);
      const owner = r.user || r.guest || requireUser(r);
      const d = accessDemo(db, r.params.id, r.user, true, r.guest);
      if (['uploading', 'processing'].includes(d.status))
        throw new HttpError(409, 'Wait for processing to finish before deleting.');
      enqueueUserDemoDeletion(db, c, owner.id, d.id);
      db.run('DELETE FROM demos WHERE id=?', d.id);
      db.audit(r.user?.id ?? null, 'demo.deleted');
    });
    cleanupDeletedDemos(db, r.params.id);
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
  app.post<{ Params: { id: string } }>('/api/demos/:id/bookmarks', (r, reply) =>
    db.transaction(() => {
      revalidatePrincipal(r);
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
      chargeBudgets(db, r, [['bookmarks', 100, 3600, u.id]]);
      const id = token().slice(0, 32);
      db.run('INSERT INTO bookmarks VALUES(?,?,?,?,?)', id, d.id, u.id, b.tick, b.label);
      reply.code(201);
      return { id, ...b };
    }),
  );
  app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', (r) =>
    db.transaction(() => {
      revalidatePrincipal(r);
      const u = requireUser(r);
      db.run('DELETE FROM bookmarks WHERE id=? AND user_id=?', r.params.id, u.id);
      return { ok: true };
    }),
  );
  adminRoutes(app, db, c, mail);
  if (existsSync(join(c.frontendDir, 'assets')))
    await app.register(staticFiles, {
      root: join(c.frontendDir, 'assets'),
      prefix: '/assets/',
      preCompressed: true,
      setHeaders(reply, path) {
        // Only Vite's fingerprinted application files are immutable across deployments.
        if (/-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|svg)(?:\.(?:br|gz))?$/.test(path))
          reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      },
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
    return sendAppShell(reply);
  });
  app.addHook('onClose', async () => {
    stopAgentModelRequests?.();
    await autoImports.close();
    await coordinator.close();
    await mail.close();
    db.close();
  });
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const c = loadConfig();
  const db = openStoreForStartup(c.dataDir);
  openEncryptionKeyForStartup(c, db);
  const app = await createApp(c, db);
  await app.listen({ port: c.port, host: '0.0.0.0' });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
