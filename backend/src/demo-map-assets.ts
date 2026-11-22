import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MapAssets } from '../../shared/map-assets.js';
import type {
  DemoMapAssets,
  MapResolution,
  MapReadinessReason,
} from '../../shared/map-acquisition.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { accessDemo } from './ingestion.js';
import { HttpError, rateLimit } from './security.js';
import {
  readMapCatalog,
  resolveMap,
  mapPackId,
  latestOfficialSelection,
  latestMapRequestId,
  latestMapPackMarkerSchema,
} from './map-catalog.js';
import { readMapPreparationState } from './map-readiness.js';
import { unsettledMapRemoval } from './map-removals.js';
import { mapIdentitySchema, officialMapName } from './map-identity.js';
import { withDirectory, regularFile, bytesFrom, fileVersion } from './map-asset-files.js';
import {
  enqueueMapRequest,
  retryMapRequest,
  canRetryMapResult,
  packIdSchema,
  readMapRequest,
  readMapResult,
  readOfficialMapInventory,
  latestMapResultMatches,
  enqueueLatestMapRequest,
  retryLatestMapRequest,
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
  const recordedIdentity = (demo: Record<string, any>) => {
    try {
      const raw = JSON.parse(demo.metadata || '{}').mapIdentity;
      if (raw === undefined) return { invalid: false };
      const identity = mapIdentitySchema.parse(raw);
      if (identity.map !== demo.map || identity.conflicted) return { invalid: true };
      return { identity, invalid: false };
    } catch {
      return { invalid: true };
    }
  };
  type PreparationState = Awaited<ReturnType<typeof readMapPreparationState>>;
  const resolutionFor = async (
    demo: Record<string, any>,
    state: PreparationState,
  ): Promise<MapResolution> => {
    const recorded = recordedIdentity(demo);
    if (recorded.invalid) return { status: 'unknown' };
    const identity = recorded.identity;
    const exact = resolveMap(identity, state.catalog);
    if (identity?.addonPresence === 'present') return exact;
    if (exact.status === 'approved') {
      const result = await readMapResult(c.mapJobsDir, exact.packId);
      if (result?.status !== 'failed' || result.code !== 'source_unavailable') return exact;
    }
    if (!officialMapName.safeParse(demo.map).success) return exact;
    const fresh = state.inventoryFresh;
    const inventory = state.inventory;
    const selection = inventory && latestOfficialSelection(inventory, demo.map);
    if (selection && !fresh) {
      const requestId = latestMapRequestId(selection),
        queued = await readMapRequest(c.mapJobsDir, requestId),
        result = await readMapResult(c.mapJobsDir, requestId);
      if (
        !queued ||
        result?.status !== 'ready' ||
        !latestMapResultMatches(queued, result) ||
        !(await latestReadyPack(result.assetPackId!, demo.map))
      )
        return exact;
    }
    return selection
      ? { status: 'latest', selection, inventoryUpdatedAt: inventory!.updatedAt, source: null }
      : exact;
  };
  const latestReadyPack = async (assetPackId: string, name: string): Promise<boolean> => {
    const marker = await withDirectory(
      c.mapAssetsDir,
      ['packs', assetPackId],
      async (directory) => {
        const file = await regularFile(directory, 'pack.json', 2, 16384);
        if (!file) return;
        try {
          const version = await fileVersion(file),
            data = await bytesFrom(file, (await file.stat()).size, 16384);
          if (version !== (await fileVersion(file))) return;
          return latestMapPackMarkerSchema.parse(JSON.parse(data.toString('utf8')));
        } finally {
          await file.close();
        }
      },
    );
    if (marker && marker.packId === assetPackId && marker.selection.map === name) {
      const selected = await readMapRequest(c.mapJobsDir, marker.requestId),
        result = await readMapResult(c.mapJobsDir, marker.requestId);
      // Stale metadata cannot choose a NEW source, but does not invalidate a
      // previously verified immutable source when the supervisor is stopped.
      const inventory = await readOfficialMapInventory(
        c.mapJobsDir,
        Math.floor(Date.now() / 1000),
        { allowStale: true },
      );
      if (
        selected?.kind === 'latest-official' &&
        result?.status === 'ready' &&
        latestMapResultMatches(selected, result) &&
        result.assetPackId === assetPackId &&
        latestMapRequestId(selected.selection) === marker.requestId &&
        inventory?.maps.some((item) => item.map === name) &&
        marker.preparedAt <= Math.floor(Date.now() / 1000) + 300 &&
        result.sourceCheckedAt! <= Math.floor(Date.now() / 1000) + 300
      )
        return true;
    }
    return false;
  };
  const describeAssets = async (
    request: FastifyRequest,
    demo: Record<string, any>,
    state: PreparationState,
  ): Promise<DemoMapAssets> => {
    let resolution = await resolutionFor(demo, state);
    const enabled = state.diagnostics.enabled;
    const owned = request.user?.id === demo.owner_id || request.guest?.id === demo.owner_id;
    if (resolution.status === 'approved' || resolution.status === 'latest') {
      const requestId =
        resolution.status === 'approved'
          ? resolution.packId
          : latestMapRequestId(resolution.selection);
      const result = await readMapResult(c.mapJobsDir, requestId);
      const queuedRequest =
        resolution.status === 'latest' ? await readMapRequest(c.mapJobsDir, requestId) : undefined;
      const validLatest =
        resolution.status === 'latest' &&
        result &&
        queuedRequest &&
        latestMapResultMatches(queuedRequest, result);
      if (resolution.status === 'latest' && validLatest)
        resolution = { ...resolution, source: result!.source! };
      const assetPackId =
        resolution.status === 'approved'
          ? resolution.packId
          : validLatest
            ? result!.assetPackId!
            : null;
      if (assetPackId && (await unsettledMapRemoval(c.mapJobsDir, assetPackId)))
        return {
          resolution,
          acquisition: 'failed',
          canAcquire: false,
          verification: 'unavailable',
          packId: resolution.status === 'approved' ? resolution.packId : null,
          code: 'removed_by_admin',
          assets: emptyAssets,
        };
      if (result?.status === 'ready') {
        if (
          !assetPackId ||
          (resolution.status === 'latest' &&
            !(await latestReadyPack(assetPackId, resolution.selection.map)))
        )
          return {
            resolution,
            acquisition: 'failed',
            canAcquire: false,
            verification: 'unavailable',
            packId: null,
            code: 'preparation_failed',
            assets: emptyAssets,
          };
        const assets = await repository.describe(
          resolution.status === 'approved'
            ? resolution.approval.identity.map
            : resolution.selection.map,
          packLocation(c, assetPackId),
        );
        if (assets.model && assets.mobile && assets.overview && assets.environment)
          return {
            resolution,
            acquisition: 'ready',
            canAcquire: false,
            verification:
              resolution.status === 'approved' ? 'operator-approved' : 'latest-official',
            packId: assetPackId,
            assets,
          };
        return {
          resolution,
          acquisition: 'failed',
          canAcquire: false,
          verification: 'unavailable',
          packId: assetPackId,
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
            state.diagnostics.worker.available &&
            (result.code !== 'removed_by_admin' ||
              !(await unsettledMapRemoval(c.mapJobsDir, result.assetPackId || requestId))),
          ),
          verification: 'unavailable',
          packId: resolution.status === 'approved' ? resolution.packId : null,
          ...(result.code ? { code: result.code } : {}),
          assets: emptyAssets,
        };
      const queued = queuedRequest ?? (await readMapRequest(c.mapJobsDir, requestId));
      if (queued)
        return {
          resolution,
          acquisition: 'queued',
          canAcquire: false,
          verification: 'unavailable',
          packId: resolution.status === 'approved' ? resolution.packId : null,
          assets: emptyAssets,
        };
      if (enabled)
        return {
          resolution,
          acquisition: 'unavailable',
          canAcquire: owned && state.diagnostics.worker.available,
          verification: 'unavailable',
          packId: resolution.status === 'approved' ? resolution.packId : null,
          assets: emptyAssets,
        };
    }
    // Manual operator installation remains an explicit, version-unverified mode.
    // Automatic mode never quietly substitutes a same-name/current map pack.
    if (!enabled && /^[a-zA-Z0-9_-]{1,80}$/.test(demo.map || '')) {
      const assets = await repository.describe(demo.map);
      const renderable = Boolean(
        assets.model || assets.mobile || assets.compact || assets.overview,
      );
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
  const describe = async (
    request: FastifyRequest,
    demo: Record<string, any>,
  ): Promise<DemoMapAssets> => {
    const enabled = db.flag(c, 'auto_official_maps_enabled');
    const state = await readMapPreparationState(c, enabled);
    const assets = await describeAssets(request, demo, state);
    if (
      assets.acquisition === 'ready' ||
      assets.acquisition === 'queued' ||
      assets.acquisition === 'processing' ||
      assets.verification === 'version-unverified'
    )
      return assets;
    // Existing terminal source failures retain their evidence and recovery rules.
    if (assets.acquisition === 'failed' && assets.code !== 'source_unavailable') return assets;
    let readinessReason: MapReadinessReason | undefined;
    if (recordedIdentity(demo).invalid || !officialMapName.safeParse(demo.map).success)
      readinessReason = 'identity_invalid';
    else if (assets.resolution.status === 'addon' || assets.resolution.status === 'ambiguous')
      return assets;
    else if (!enabled) readinessReason = 'automatic_disabled';
    else if (!state.diagnostics.worker.available) readinessReason = 'worker_unavailable';
    else if (assets.resolution.status !== 'approved' && assets.resolution.status !== 'latest') {
      readinessReason =
        state.diagnostics.inventory.status === 'unavailable'
          ? 'inventory_unavailable'
          : state.diagnostics.inventory.status === 'stale'
            ? 'inventory_stale'
            : 'official_map_unknown';
    } else if (request.user?.id !== demo.owner_id && request.guest?.id !== demo.owner_id)
      readinessReason = 'owner_required';
    return readinessReason ? { ...assets, readinessReason } : assets;
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
    if (!before.canAcquire || !['approved', 'latest'].includes(before.resolution.status))
      return before;
    rateLimit(db, request, 'map-acquisition', 6, 3600, request.user?.id || request.guest!.id);
    rateLimit(db, request, 'map-acquisition-ip', 12, 3600);
    const queued =
      before.resolution.status === 'approved'
        ? before.acquisition === 'failed'
          ? await retryMapRequest(c.mapJobsDir, before.resolution.approval)
          : await enqueueMapRequest(c.mapJobsDir, before.resolution.approval)
        : before.resolution.status === 'latest'
          ? before.acquisition === 'failed'
            ? await retryLatestMapRequest(c.mapJobsDir, before.resolution.selection)
            : await enqueueLatestMapRequest(c.mapJobsDir, before.resolution.selection)
          : 'ineligible';
    if (queued === 'ineligible') return describe(request, demo);
    reply.code(queued === 'full' ? 503 : 202);
    if (queued === 'full') return { ...before, canAcquire: false, code: 'queue_full' };
    return describe(request, demo);
  });

  /** Delivery requires a current exact approval, or a worker-proven immutable
   * latest snapshot. A refreshed inventory must not relabel an older snapshot. */
  const readyLocation = async (request: FastifyRequest) => {
    const params = request.params as { packId?: string; name?: string; '*'?: string };
    const id = packIdSchema.safeParse(params.packId);
    if (!id.success) throw new HttpError(404, 'Map pack not found.');
    if (await unsettledMapRemoval(c.mapJobsDir, id.data))
      throw new HttpError(404, 'Map pack not found.');
    const catalog = await readMapCatalog(c.mapCatalogFile);
    const approvals = catalog?.entries.filter((entry) => mapPackId(entry) === id.data) || [];
    const name = params.name ?? params['*']?.split('/')[0];
    if (
      approvals.length &&
      resolveMap(approvals[0].identity, catalog).status === 'approved' &&
      (await readMapResult(c.mapJobsDir, id.data))?.status === 'ready' &&
      name === approvals[0].identity.map
    )
      return packLocation(c, id.data);
    if (name && (await latestReadyPack(id.data, name))) return packLocation(c, id.data);
    throw new HttpError(404, 'Map pack not found.');
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
