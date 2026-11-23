import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { z } from 'zod';
import { HttpError, rateLimit } from './security.js';
import { adminAccess, adminPublication, recheckAdminAccessOnFailure } from './admin-access.js';
import { mapWorkerAvailable, packIdSchema } from './map-jobs.js';
import { listManagedMaps, enqueueMapRemoval } from './map-removals.js';
import { opendir } from 'node:fs/promises';
import { withDirectory } from './map-asset-files.js';
import type { mapAssetRoutes } from './map-assets.js';
import { enqueuePresentationRetry, presentationKinds } from './presentation-assets.js';

async function operatorMaps(
  assets: string,
  describe: Awaited<ReturnType<typeof mapAssetRoutes>>['describe'],
) {
  const names = new Set<string>();
  let scanned = 0;
  for (const parts of [[], ['overviews']]) {
    const result = await withDirectory(assets, parts, async (directory) => {
      try {
        const entries = await opendir(`/proc/self/fd/${directory.fd}`);
        for await (const entry of entries) {
          if (++scanned > 1024) throw Error('Manual map scan limit');
          if (entry.isDirectory() && /^[A-Za-z0-9_-]{1,80}$/.test(entry.name))
            names.add(entry.name);
          if (names.size > 256) throw Error('Manual map count limit');
        }
        return true;
      } catch {
        return false;
      }
    });
    if (result === false) throw Error('Manual map scan failed');
  }
  const found = [];
  for (const map of [...names].sort()) {
    const assets = await describe(map);
    if (assets.model || assets.mobile || assets.compact || assets.overview) found.push({ map });
  }
  return found;
}

/** The HTTP process only manages bounded queue records. Prepared assets stay
 * read-only here; the serialized asset supervisor owns filesystem removal. */
export async function mapManagementRoutes(
  app: FastifyInstance,
  db: Store,
  config: Config,
  repository: Awaited<ReturnType<typeof mapAssetRoutes>>,
) {
  app.post<{ Params: { kind: string } }>(
    '/api/admin/assets/presentation/:kind/retry',
    async (request, reply) => {
      const user = adminAccess(db, config, request, true);
      const kind = z.enum(presentationKinds).parse(request.params.kind);
      z.object({}).strict().parse(request.body);
      rateLimit(db, request, 'presentation-retry', 12, 3600, user.user_id);
      const rethrow = recheckAdminAccessOnFailure(db, config, request, true);
      const workerAvailable = await mapWorkerAvailable(config.mapJobsDir).catch(rethrow);
      adminAccess(db, config, request, true);
      if (!workerAvailable)
        throw new HttpError(503, 'Start the assets service before retrying asset preparation.');
      const outcome = await enqueuePresentationRetry(
        config.mapJobsDir,
        kind,
        adminPublication(db, config, request),
      ).catch(rethrow);
      adminAccess(db, config, request, true);
      if (outcome === 'stale')
        throw new HttpError(409, 'Asset preparation changed. Refresh its status and try again.');
      reply.code(202);
      return { queued: true };
    },
  );
  app.get('/api/admin/maps', async (request) => {
    const user = adminAccess(db, config, request, false);
    rateLimit(db, request, 'managed-map-read', 60, 60, user.user_id);
    const [maps, manualMaps, workerAvailable] = await Promise.all([
      listManagedMaps(config.mapAssetsDir, config.mapJobsDir),
      operatorMaps(config.mapAssetsDir, repository.describe),
      mapWorkerAvailable(config.mapJobsDir),
    ]).catch(() => {
      adminAccess(db, config, request, false);
      throw new HttpError(503, 'Map management is unavailable. Check the assets service.');
    });
    adminAccess(db, config, request, false);
    return { maps, operatorMaps: manualMaps, workerAvailable };
  });
  app.delete<{ Params: { packId: string } }>('/api/admin/maps/:packId', async (request, reply) => {
    const user = adminAccess(db, config, request, true);
    const packId = packIdSchema.parse(request.params.packId);
    const body = z.object({ version: packIdSchema }).strict().parse(request.body);
    rateLimit(db, request, 'managed-map-removal', 12, 3600, user.user_id);
    const rethrow = recheckAdminAccessOnFailure(db, config, request, true);
    const workerAvailable = await mapWorkerAvailable(config.mapJobsDir).catch(rethrow);
    adminAccess(db, config, request, true);
    if (!workerAvailable)
      throw new HttpError(503, 'Start the assets service before deleting a map.');
    const outcome = await enqueueMapRemoval(
      config.mapAssetsDir,
      config.mapJobsDir,
      packId,
      body.version,
      adminPublication(db, config, request),
    ).catch(rethrow);
    adminAccess(db, config, request, true);
    if (outcome !== 'queued') {
      if (outcome === 'full')
        throw new HttpError(503, 'The map deletion queue is full. Try again later.');
      throw new HttpError(409, 'This map changed. Refresh the list before deleting it.');
    }
    reply.code(202);
    return { queued: true };
  });
}
