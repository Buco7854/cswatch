import type { FastifyInstance } from 'fastify';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MapAssets, MapOverview } from '../../shared/map-assets.js';
import { HttpError } from './security.js';
import { validPng } from './png.js';
import {
  bytesFrom,
  fileDigest,
  fileVersion,
  regularFile,
  withDirectory,
} from './map-asset-files.js';
import { mapEnvironmentAssets } from './map-environment.js';
import { openMapModel } from './map-model-files.js';
import { legacyMapLocation, type MapAssetLocation } from './map-asset-location.js';

export const overviewLimits = {
  bytes: 8 * 1024 ** 2,
  dimension: 2048,
  pixels: 2048 ** 2,
  square: true,
  metadataBytes: 16384,
  cacheBytes: 32 * 1024 ** 2,
} as const;
const mapName = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const overviewMetadata = z
  .object({
    schemaVersion: z.literal(1),
    map: mapName,
    origin: z
      .object({
        x: z.number().finite().min(-1e7).max(1e7),
        y: z.number().finite().min(-1e7).max(1e7),
      })
      .strict(),
    scale: z.number().finite().min(0.001).max(10000),
    referenceSize: z.literal(1024),
    assetVersion: z.string().trim().min(1).max(100),
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const validOverviewPng = (data: Buffer) => validPng(data, overviewLimits);

/** Header validation establishes a bounded regular GLB, not visual alignment or
 * successful GPU loading. Renderer failure remains a separate visible state. */
async function hasGlb(location: MapAssetLocation, parts: string[], filename: string) {
  const model = await openMapModel(location.root, parts, filename, location.parts);
  if (!model) return false;
  await model.file.close();
  return true;
}

export async function mapAssetRoutes(
  app: FastifyInstance,
  dataRoot: string,
  defaultLocation = legacyMapLocation(dataRoot),
) {
  const loadEnvironment = mapEnvironmentAssets(app, dataRoot, defaultLocation);
  const cache = new Map<
    string,
    {
      version: string;
      metadataDigest: string;
      imageDigest: string;
      overview: MapOverview;
      image: Buffer;
    }
  >();
  let cachedBytes = 0;
  const discard = (name: string) => {
    const item = cache.get(name);
    if (item) cachedBytes -= item.image.length;
    cache.delete(name);
  };
  const readOverview = async (name: string, location: MapAssetLocation) => {
    const key = `${location.key}:${name}`;
    const result = await withDirectory(
      location.root,
      [...location.parts, 'overviews', name],
      async (directory) => {
        let metadata: FileHandle | undefined, image: FileHandle | undefined;
        try {
          metadata = await regularFile(directory, 'overview.json', 2, overviewLimits.metadataBytes);
          image = await regularFile(directory, 'overview.png', 57, overviewLimits.bytes);
          if (!metadata || !image) return;
          const version = `${await fileVersion(metadata)}:${await fileVersion(image)}`;
          const previous = cache.get(key);
          const metadataBytes = await bytesFrom(
            metadata,
            (await metadata.stat()).size,
            overviewLimits.metadataBytes,
          );
          const metadataDigest = createHash('sha256').update(metadataBytes).digest('hex');
          if (
            previous?.version === version &&
            previous.metadataDigest === metadataDigest &&
            (await fileDigest(image, overviewLimits.bytes)) === previous.imageDigest &&
            version === `${await fileVersion(metadata)}:${await fileVersion(image)}`
          )
            return previous;
          discard(key);
          const parsed = overviewMetadata.parse(JSON.parse(metadataBytes.toString('utf8')));
          if (parsed.map !== name) return;
          const data = await bytesFrom(image, (await image.stat()).size, overviewLimits.bytes);
          if (
            !validOverviewPng(data) ||
            createHash('sha256').update(data).digest('hex') !== parsed.imageSha256 ||
            version !== `${await fileVersion(metadata)}:${await fileVersion(image)}`
          )
            return;
          const overview: MapOverview = {
            image: `${location.apiPrefix}/${name}/overview.png`,
            origin: parsed.origin,
            scale: parsed.scale,
            referenceSize: parsed.referenceSize,
            assetVersion: parsed.assetVersion,
          };
          discard(key);
          const item = {
            version,
            metadataDigest,
            imageDigest: parsed.imageSha256,
            overview,
            image: data,
          };
          cache.set(key, item);
          cachedBytes += data.length;
          while (cachedBytes > overviewLimits.cacheBytes) discard(cache.keys().next().value!);
          return item;
        } finally {
          await metadata?.close();
          await image?.close();
        }
      },
    );
    if (!result) discard(key);
    return result;
  };
  let overviewQueue: Promise<unknown> = Promise.resolve();
  const overviewPending = new Map<string, ReturnType<typeof readOverview>>();
  const loadOverview = (name: string, location = defaultLocation) => {
    const key = `${location.key}:${name}`;
    const pending = overviewPending.get(key);
    if (pending) return pending;
    if (!mapName.safeParse(name).success || overviewPending.size >= 32)
      return Promise.resolve(undefined);
    const task = overviewQueue.then(() => readOverview(name, location));
    overviewQueue = task.catch(() => undefined);
    const tracked = task.finally(() => overviewPending.delete(key));
    overviewPending.set(key, tracked);
    return tracked;
  };
  app.addHook('onClose', async () => {
    await overviewQueue;
    cache.clear();
  });
  const describe = async (name: string, location = defaultLocation): Promise<MapAssets> => {
    mapName.parse(name);
    const [desktop, mobile, compact, overview, environment] = await Promise.all([
      hasGlb(location, [name, 'desktop'], 'scene.glb'),
      hasGlb(location, [name, 'mobile'], 'scene.glb'),
      hasGlb(location, [name, 'compact'], 'scene.glb'),
      loadOverview(name, location),
      loadEnvironment(name, location),
    ]);
    return {
      model: desktop ? `${location.modelPrefix}/${name}/desktop/scene.glb` : null,
      mobile: mobile ? `${location.modelPrefix}/${name}/mobile/scene.glb` : null,
      ...(compact ? { compact: `${location.modelPrefix}/${name}/compact/scene.glb` } : {}),
      overview: overview?.overview ?? null,
      environment: environment?.environment ?? null,
    };
  };
  app.get<{ Params: { name: string } }>('/api/maps/:name', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return describe(request.params.name);
  });
  app.get<{ Params: { name: string } }>('/api/maps/:name/overview.png', async (request, reply) => {
    const name = mapName.parse(request.params.name);
    const item = await loadOverview(name);
    if (!item) throw new HttpError(404, 'Map overview not found.');
    return reply.header('Cache-Control', 'private, no-store').type('image/png').send(item.image);
  });
  app.get('/api/assets/agents', async () => ({
    ct: (await hasGlb(defaultLocation, ['agents'], 'ct.glb')) ? '/map-assets/agents/ct.glb' : null,
    t: (await hasGlb(defaultLocation, ['agents'], 't.glb')) ? '/map-assets/agents/t.glb' : null,
  }));
  return { describe, loadOverview, loadEnvironment };
}
