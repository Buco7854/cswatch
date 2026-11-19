import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { z } from 'zod';
import { currentUser, equal, HttpError, rateLimit, requireAdmin } from './security.js';
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
    if (assets.model || assets.mobile || assets.overview) found.push({ map });
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
      const user = requireAdmin(request),
        kind = z.enum(presentationKinds).parse(request.params.kind);
      z.object({})
        .strict()
        .parse(request.body ?? {});
      rateLimit(db, request, 'presentation-retry', 12, 3600, user.id);
      if (!(await mapWorkerAvailable(config.mapJobsDir)))
        throw new HttpError(503, 'Start the assets service before retrying asset preparation.');
      const outcome = await enqueuePresentationRetry(config.mapJobsDir, kind, () => {
        const current = currentUser(db, request, config);
        if (
          !current?.is_admin ||
          current.id !== user.id ||
          !equal(String(request.headers['x-csrf-token'] || ''), current.csrf)
        )
          throw new HttpError(403, 'Session expired. Refresh the page and try again.');
      });
      if (outcome === 'stale')
        throw new HttpError(409, 'Asset preparation changed. Refresh its status and try again.');
      db.audit(user.id, 'assets.retry_requested');
      reply.code(202);
      return { queued: true };
    },
  );
  app.get('/api/admin/maps', async (request) => {
    const user = requireAdmin(request);
    rateLimit(db, request, 'managed-map-read', 60, 60, user.id);
    try {
      return {
        maps: await listManagedMaps(config.mapAssetsDir, config.mapJobsDir),
        operatorMaps: await operatorMaps(config.mapAssetsDir, repository.describe),
        workerAvailable: await mapWorkerAvailable(config.mapJobsDir),
      };
    } catch {
      throw new HttpError(503, 'Map management is unavailable. Check the assets service.');
    }
  });
  app.delete<{ Params: { packId: string } }>('/api/admin/maps/:packId', async (request, reply) => {
    const user = requireAdmin(request);
    const packId = packIdSchema.parse(request.params.packId);
    const body = z.object({ version: packIdSchema }).strict().parse(request.body);
    rateLimit(db, request, 'managed-map-removal', 12, 3600, user.id);
    if (!(await mapWorkerAvailable(config.mapJobsDir)))
      throw new HttpError(503, 'Start the assets service before deleting a map.');
    const authorize = () => {
      const current = currentUser(db, request, config);
      if (
        !current?.is_admin ||
        current.id !== user.id ||
        !equal(String(request.headers['x-csrf-token'] || ''), current.csrf)
      )
        throw new HttpError(403, 'Session expired. Refresh the page and try again.');
    };
    const outcome = await enqueueMapRemoval(
      config.mapAssetsDir,
      config.mapJobsDir,
      packId,
      body.version,
      authorize,
    );
    if (outcome === 'full')
      throw new HttpError(503, 'The map deletion queue is full. Try again later.');
    if (outcome === 'changed')
      throw new HttpError(409, 'This map changed. Refresh the list before deleting it.');
    db.audit(user.id, 'map.removal_requested');
    reply.code(202);
    return { queued: true };
  });
}
