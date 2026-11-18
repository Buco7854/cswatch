import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MapAssets } from '../../shared/map-assets.js';
import type { DemoMapAssets, MapResolution } from '../../shared/map-acquisition.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { accessDemo } from './ingestion.js';
import { HttpError, rateLimit } from './security.js';
import { readMapCatalog, resolveMap, mapPackId } from './map-catalog.js';
import { mapIdentitySchema } from './map-identity.js';
import {
  enqueueMapRequest,
  retryMapRequest,
  canRetryMapResult,
  mapWorkerAvailable,
  packIdSchema,
  readMapRequest,
  readMapResult,
} from './map-jobs.js';
import type { mapAssetRoutes } from './map-assets.js';
import { environmentFaces } from './map-environment.js';
import { mapModelFileRoutes } from './map-model-files.js';
import type { MapAssetLocation } from './map-asset-location.js';
const emptyAssets: MapAssets = { model: null, mobile: null, overview: null, environment: null };
const packLocation = (c: Config, packId: string): MapAssetLocation => ({
  root: c.mapAssetsDir,
  parts: ['packs', packId, 'maps'],
  key: packId,
  apiPrefix: `/api/map-packs/${packId}/maps`,
  modelPrefix: `/api/map-packs/${packId}/models`,
});
type Repository = Awaited<ReturnType<typeof mapAssetRoutes>>;

/** Anonymous public access to the site never authorizes preparation of a private
 * demo. Sources are resolved entirely from validated recorded metadata/catalog. */
export async function demoMapAssetRoutes(
  app: FastifyInstance,
  db: Store,
  c: Config,
  repository: Repository,
) {
  const resolutionFor = async (demo: Record<string, any>): Promise<MapResolution> => {
    let identity;
    try {
      identity = mapIdentitySchema.parse(JSON.parse(demo.metadata || '{}').mapIdentity);
    } catch {
      return { status: 'unknown' };
    }
    if (identity.map !== demo.map) return { status: 'unknown' };
    return resolveMap(identity, await readMapCatalog(c.mapCatalogFile));
  };
  const describe = async (
    request: FastifyRequest,
    demo: Record<string, any>,
  ): Promise<DemoMapAssets> => {
    const resolution = await resolutionFor(demo),
      enabled = db.flag(c, 'auto_official_maps_enabled');
    const owned = request.user?.id === demo.owner_id || request.guest?.id === demo.owner_id;
    if (resolution.status === 'approved') {
      const result = await readMapResult(c.mapJobsDir, resolution.packId);
      if (result?.status === 'ready') {
        const assets = await repository.describe(
          resolution.approval.identity.map,
          packLocation(c, resolution.packId),
        );
        if (assets.model && assets.mobile && assets.overview && assets.environment)
          return {
            resolution,
            acquisition: 'ready',
            canAcquire: false,
            verification: 'operator-approved',
            packId: resolution.packId,
            assets,
          };
        return {
          resolution,
          acquisition: 'failed',
          canAcquire: false,
          verification: 'unavailable',
          packId: resolution.packId,
          code: 'preparation_failed',
          assets: emptyAssets,
        };
      }
      if (result)
        return {
          resolution,
          acquisition: result.status,
          canAcquire: Boolean(
            enabled &&
            owned &&
            canRetryMapResult(result) &&
            (await mapWorkerAvailable(c.mapJobsDir)),
          ),
          verification: 'unavailable',
          packId: resolution.packId,
          ...(result.code ? { code: result.code } : {}),
          assets: emptyAssets,
        };
      const queued = await readMapRequest(c.mapJobsDir, resolution.packId);
      if (queued)
        return {
          resolution,
          acquisition: 'queued',
          canAcquire: false,
          verification: 'unavailable',
          packId: resolution.packId,
          assets: emptyAssets,
        };
      if (enabled)
        return {
          resolution,
          acquisition: 'unavailable',
          canAcquire: owned && (await mapWorkerAvailable(c.mapJobsDir)),
          verification: 'unavailable',
          packId: resolution.packId,
          assets: emptyAssets,
        };
    }
    // Manual operator installation remains an explicit, version-unverified mode.
    // Automatic mode never quietly substitutes a same-name/current map pack.
    if (!enabled && /^[a-zA-Z0-9_-]{1,80}$/.test(demo.map || '')) {
      const assets = await repository.describe(demo.map);
      const renderable = Boolean(assets.model || assets.mobile || assets.overview);
      return {
        resolution,
        acquisition: 'disabled',
        canAcquire: false,
        verification: renderable ? 'version-unverified' : 'unavailable',
        packId: null,
        assets: renderable ? assets : emptyAssets,
      };
    }
    return {
      resolution,
      acquisition: enabled ? 'unavailable' : 'disabled',
      canAcquire: false,
      verification: 'unavailable',
      packId: null,
      assets: emptyAssets,
    };
  };
  app.get<{ Params: { id: string } }>('/api/demos/:id/map-assets', async (request, reply) => {
    const demo = accessDemo(db, request.params.id, request.user, false, request.guest);
    reply.header('Cache-Control', 'private, no-store');
    if (demo.status !== 'ready') throw new HttpError(409, 'This demo is not ready.');
    return describe(request, demo);
  });
  app.post<{ Params: { id: string } }>('/api/demos/:id/map-assets', async (request, reply) => {
    const demo = accessDemo(db, request.params.id, request.user, true, request.guest);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    if (demo.status !== 'ready') throw new HttpError(409, 'This demo is not ready.');
    const before = await describe(request, demo);
    if (
      before.acquisition === 'queued' ||
      before.acquisition === 'processing' ||
      before.acquisition === 'ready'
    )
      return before;
    if (!before.canAcquire || before.resolution.status !== 'approved') return before;
    rateLimit(db, request, 'map-acquisition', 6, 3600, request.user?.id || request.guest!.id);
    rateLimit(db, request, 'map-acquisition-ip', 12, 3600);
    const queued =
      before.acquisition === 'failed'
        ? await retryMapRequest(c.mapJobsDir, before.resolution.approval)
        : await enqueueMapRequest(c.mapJobsDir, before.resolution.approval);
    if (queued === 'ineligible') return describe(request, demo);
    reply.code(queued === 'full' ? 503 : 202);
    if (queued === 'full') return { ...before, canAcquire: false, code: 'queue_full' };
    return describe(request, demo);
  });

  /** Pack IDs never bypass current catalog approval or successful publication. */
  const readyLocation = async (request: FastifyRequest) => {
    const params = request.params as { packId?: string; name?: string; '*'?: string };
    const id = packIdSchema.safeParse(params.packId);
    if (!id.success) throw new HttpError(404, 'Map pack not found.');
    const catalog = await readMapCatalog(c.mapCatalogFile);
    const approvals = catalog?.entries.filter((entry) => mapPackId(entry) === id.data) || [];
    if (
      !approvals.length ||
      resolveMap(approvals[0].identity, catalog).status !== 'approved' ||
      (await readMapResult(c.mapJobsDir, id.data))?.status !== 'ready'
    )
      throw new HttpError(404, 'Map pack not found.');
    const name = params.name ?? params['*']?.split('/')[0];
    if (name !== approvals[0].identity.map) throw new HttpError(404, 'Map pack not found.');
    return packLocation(c, id.data);
  };
  await mapModelFileRoutes(app, c.mapAssetsDir, {
    url: '/api/map-packs/:packId/models/*',
    resolveLocation: readyLocation,
  });
  app.get<{ Params: { packId: string; name: string } }>(
    '/api/map-packs/:packId/maps/:name',
    async (request) => repository.describe(request.params.name, await readyLocation(request)),
  );
  app.get<{ Params: { packId: string; name: string } }>(
    '/api/map-packs/:packId/maps/:name/overview.png',
    async (request, reply) => {
      const item = await repository.loadOverview(request.params.name, await readyLocation(request));
      if (!item) throw new HttpError(404, 'Map overview not found.');
      return reply.header('Cache-Control', 'private, no-store').type('image/png').send(item.image);
    },
  );
  app.get<{ Params: { packId: string; name: string; face: string } }>(
    '/api/map-packs/:packId/maps/:name/environment/:face.png',
    async (request, reply) => {
      const location = await readyLocation(request);
      if (!environmentFaces.includes(request.params.face as (typeof environmentFaces)[number]))
        throw new HttpError(404, 'Map environment not found.');
      const item = await repository.loadEnvironment(request.params.name, location);
      if (!item) throw new HttpError(404, 'Map environment not found.');
      return reply
        .header('Cache-Control', 'private, no-store')
        .type('image/png')
        .send(item.images[request.params.face as (typeof environmentFaces)[number]]);
    },
  );
}
