import type { FastifyInstance } from 'fastify';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MapEnvironment } from '../../shared/map-assets.js';
import {
  bytesFrom,
  fileDigest,
  fileVersion,
  regularFile,
  withDirectory,
} from './map-asset-files.js';
import { validPng } from './png.js';
import { HttpError } from './security.js';
import { mapCubeFogSchema } from './map-fog.js';

/** Prepared offline in viewer Y-up cube order; no runtime Source rotation. */
export const environmentFaces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
type Face = (typeof environmentFaces)[number];
export const environmentLimits = {
  bytes: 8 * 1024 ** 2,
  dimension: 1024,
  pixels: 1024 ** 2,
  square: true,
  aggregateBytes: 32 * 1024 ** 2,
  cacheBytes: 32 * 1024 ** 2,
  metadataBytes: 16384,
  manifestBytes: 32768,
} as const;
const mapName = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const assetVersion = z.string().trim().min(1).max(100);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    map: mapName,
    assetVersion,
    source: z.string().trim().min(1).max(500),
    landscape: z.boolean(),
    fog: mapCubeFogSchema.optional(),
    sky: z
      .object({
        brightness: z.number().finite().min(0).max(16),
        faces: z
          .object({ px: sha256, nx: sha256, py: sha256, ny: sha256, pz: sha256, nz: sha256 })
          .strict(),
      })
      .strict(),
  })
  .strict();
const mapManifestSchema = z.object({
  schemaVersion: z.literal(1),
  map: mapName,
  assetVersion,
  tier: z.enum(['desktop', 'mobile']),
});
export const validEnvironmentPng = (data: Buffer) => validPng(data, environmentLimits);

/** Pair the environment with both small, prepared tier manifests, without reading
 * or hashing GLBs. An old environment never attaches to a replacement map pack. */
async function preparedMapPair(root: string, name: string) {
  const versions: string[] = [];
  let version: string | undefined;
  for (const tier of ['desktop', 'mobile'] as const) {
    const result = await withDirectory(root, ['maps', name, tier], async (directory) => {
      const file = await regularFile(
        directory,
        'manifest.json',
        2,
        environmentLimits.manifestBytes,
      );
      if (!file) return;
      try {
        const before = await fileVersion(file);
        const content = await bytesFrom(
          file,
          (await file.stat()).size,
          environmentLimits.manifestBytes,
        );
        const parsed = mapManifestSchema.parse(JSON.parse(content.toString('utf8')));
        if (parsed.map !== name || parsed.tier !== tier || before !== (await fileVersion(file)))
          return;
        return {
          fingerprint: `${before}:${createHash('sha256').update(content).digest('hex')}`,
          assetVersion: parsed.assetVersion,
        };
      } finally {
        await file.close();
      }
    });
    if (!result || (version !== undefined && result.assetVersion !== version)) return;
    version = result.assetVersion;
    versions.push(result.fingerprint);
  }
  return { assetVersion: version!, fingerprint: versions.join(':') };
}

type EnvironmentItem = {
  version: string;
  metadataDigest: string;
  imageDigests: Record<Face, string>;
  environment: MapEnvironment;
  images: Record<Face, Buffer>;
  bytes: number;
};

export function mapEnvironmentAssets(app: FastifyInstance, dataRoot: string) {
  const cache = new Map<string, EnvironmentItem>();
  const inFlight = new Map<string, Promise<EnvironmentItem | undefined>>();
  let cachedBytes = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const discard = (name: string) => {
    const previous = cache.get(name);
    if (previous) cachedBytes -= previous.bytes;
    cache.delete(name);
  };
  const loadNow = async (name: string) => {
    const pair = await preparedMapPair(dataRoot, name);
    if (!pair) {
      discard(name);
      return;
    }
    const result = await withDirectory(
      dataRoot,
      ['maps', 'environments', name],
      async (directory) => {
        const files: FileHandle[] = [];
        try {
          const metadata = await regularFile(
            directory,
            'environment.json',
            2,
            environmentLimits.metadataBytes,
          );
          if (!metadata) return;
          files.push(metadata);
          let totalBytes = 0;
          for (const face of environmentFaces) {
            const file = await regularFile(directory, `${face}.png`, 57, environmentLimits.bytes);
            if (!file) return;
            files.push(file);
            totalBytes += (await file.stat()).size;
            if (totalBytes > environmentLimits.aggregateBytes) return;
          }
          const fingerprint = async () =>
            `${pair.fingerprint}:${(await Promise.all(files.map(fileVersion))).join(':')}`;
          const version = await fingerprint();
          const previous = cache.get(name);
          const metadataBytes = await bytesFrom(
            metadata,
            (await metadata.stat()).size,
            environmentLimits.metadataBytes,
          );
          const metadataDigest = createHash('sha256').update(metadataBytes).digest('hex');
          if (previous?.version === version && previous.metadataDigest === metadataDigest) {
            let unchanged = true;
            for (const [index, face] of environmentFaces.entries())
              if (
                (await fileDigest(files[index + 1], environmentLimits.bytes)) !==
                previous.imageDigests[face]
              ) {
                unchanged = false;
                break;
              }
            if (
              unchanged &&
              version === (await fingerprint()) &&
              (await preparedMapPair(dataRoot, name))?.fingerprint === pair.fingerprint
            ) {
              cache.delete(name);
              cache.set(name, previous);
              return previous;
            }
          }
          discard(name);
          const parsed = metadataSchema.parse(JSON.parse(metadataBytes.toString('utf8')));
          if (parsed.map !== name || parsed.assetVersion !== pair.assetVersion) return;
          const images = {} as Record<Face, Buffer>;
          let dimension: number | undefined;
          let readBytes = 0;
          for (const [index, face] of environmentFaces.entries()) {
            const file = files[index + 1];
            const size = (await file.stat()).size;
            readBytes += size;
            if (readBytes > environmentLimits.aggregateBytes) return;
            const image = await bytesFrom(file, size, environmentLimits.bytes);
            if (
              !validEnvironmentPng(image) ||
              createHash('sha256').update(image).digest('hex') !== parsed.sky.faces[face]
            )
              return;
            const width = image.readUInt32BE(16);
            if (dimension !== undefined && width !== dimension) return;
            dimension = width;
            images[face] = image;
          }
          if (
            version !== (await fingerprint()) ||
            (await preparedMapPair(dataRoot, name))?.fingerprint !== pair.fingerprint
          )
            return;
          const environment: MapEnvironment = {
            assetVersion: parsed.assetVersion,
            landscape: parsed.landscape,
            sky: {
              brightness: parsed.sky.brightness,
              faces: environmentFaces.map(
                (face) => `/api/maps/${name}/environment/${face}.png`,
              ) as MapEnvironment['sky']['faces'],
            },
            ...(parsed.fog ? { fog: parsed.fog } : {}),
          };
          const item = {
            version,
            metadataDigest,
            imageDigests: parsed.sky.faces,
            environment,
            images,
            bytes: readBytes,
          };
          cache.set(name, item);
          cachedBytes += item.bytes;
          while (cachedBytes > environmentLimits.cacheBytes) discard(cache.keys().next().value!);
          return item;
        } finally {
          for (const file of files) await file.close();
        }
      },
    );
    if (!result) discard(name);
    return result;
  };
  const load = (name: string): Promise<EnvironmentItem | undefined> => {
    const pending = inFlight.get(name);
    if (pending) return pending;
    if (!mapName.safeParse(name).success || inFlight.size >= 32) return Promise.resolve(undefined);
    // Serialize image allocation across maps and coalesce simultaneous six-face
    // requests. At most one bounded pack is decoded/read alongside the cache.
    const next = queue.then(() => loadNow(name));
    queue = next.catch(() => undefined);
    const tracked = next.finally(() => inFlight.delete(name));
    inFlight.set(name, tracked);
    return tracked;
  };
  app.get<{ Params: { name: string; face: string } }>(
    '/api/maps/:name/environment/:face.png',
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const { name, face } = request.params;
      if (!mapName.safeParse(name).success || !environmentFaces.includes(face as Face))
        throw new HttpError(404, 'Map environment not found.');
      const item = await load(name);
      if (!item) throw new HttpError(404, 'Map environment not found.');
      return reply.type('image/png').send(item.images[face as Face]);
    },
  );
  app.addHook('onClose', async () => {
    await queue;
    cache.clear();
  });
  return load;
}
