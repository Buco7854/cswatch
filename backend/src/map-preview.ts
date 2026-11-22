import type { FastifyInstance } from 'fastify';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { join } from 'node:path';
import {
  bytesFrom,
  fileDigest,
  fileVersion,
  regularFile,
  withDirectory,
} from './map-asset-files.js';
import { validPng } from './png.js';
import { HttpError } from './security.js';
import type { MapPreview } from '../../shared/map-assets.js';

/** Public artwork identities are fixed in code. No directory listing, URL or filename is accepted. */
const mapPreviewMaps = Object.freeze(
  z
    .object({
      schemaVersion: z.literal(1),
      maps: z
        .array(z.string().regex(/^[a-z0-9_]{1,80}$/))
        .min(1)
        .max(8),
    })
    .strict()
    .parse(
      JSON.parse(
        readFileSync(
          new URL(
            import.meta.url.endsWith('.ts')
              ? '../../shared/map-previews.json'
              : './map-previews.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    ).maps,
);
export const mapPreviewLimits = {
  bytes: 8 * 1024 ** 2,
  dimension: 2560,
  pixels: 2560 * 1440,
  metadataBytes: 16384,
  cacheBytes: 16 * 1024 ** 2,
} as const;
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    map: z.enum(mapPreviewMaps),
    assetVersion: z.string().trim().min(1).max(100),
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const known = new Set<string>(mapPreviewMaps);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function validMapPreview(bytes: Buffer) {
  return (
    validPng(bytes, mapPreviewLimits) &&
    bytes.readUInt32BE(16) <= 2560 &&
    bytes.readUInt32BE(20) <= 1440
  );
}
type Preview = { version: string; metadataSha: string; imageSha: string; bytes: Buffer };

export async function mapPreviewRoutes(
  app: FastifyInstance,
  root: string,
  mapsRoot = join(root, 'maps'),
) {
  const cache = new Map<string, Preview>(),
    pending = new Map<string, Promise<Preview | undefined>>();
  let cachedBytes = 0,
    sequence: Promise<unknown> = Promise.resolve();
  const discard = (map: string) => {
    const previous = cache.get(map);
    if (previous) cachedBytes -= previous.bytes.length;
    cache.delete(map);
  };
  const read = async (map: string) => {
    const result = await withDirectory(mapsRoot, ['previews', map], async (directory) => {
      let metadata: FileHandle | undefined, image: FileHandle | undefined;
      try {
        metadata = await regularFile(directory, 'preview.json', 2, mapPreviewLimits.metadataBytes);
        image = await regularFile(directory, 'preview.png', 57, mapPreviewLimits.bytes);
        if (!metadata || !image) return;
        const version = `${await fileVersion(metadata)}:${await fileVersion(image)}`;
        const raw = await bytesFrom(
            metadata,
            (await metadata.stat()).size,
            mapPreviewLimits.metadataBytes,
          ),
          metadataSha = sha(raw);
        const parsed = metadataSchema.parse(JSON.parse(raw.toString('utf8')));
        if (parsed.map !== map) return;
        const previous = cache.get(map);
        if (
          previous?.version === version &&
          previous.metadataSha === metadataSha &&
          previous.imageSha === parsed.imageSha256 &&
          (await fileDigest(image, mapPreviewLimits.bytes)) === previous.imageSha &&
          version === `${await fileVersion(metadata)}:${await fileVersion(image)}`
        )
          return previous;
        discard(map);
        const bytes = await bytesFrom(image, (await image.stat()).size, mapPreviewLimits.bytes);
        if (
          !validMapPreview(bytes) ||
          sha(bytes) !== parsed.imageSha256 ||
          version !== `${await fileVersion(metadata)}:${await fileVersion(image)}`
        )
          return;
        const item = { version, metadataSha, imageSha: parsed.imageSha256, bytes };
        cache.set(map, item);
        cachedBytes += bytes.length;
        while (cachedBytes > mapPreviewLimits.cacheBytes) discard(cache.keys().next().value!);
        return item;
      } finally {
        await metadata?.close();
        await image?.close();
      }
    });
    if (!result) discard(map);
    return result;
  };
  // Four known identities cap queued work. Each read closes its descriptors before returning a Buffer.
  const load = (map: string) => {
    const existing = pending.get(map);
    if (existing) return existing;
    const next = sequence.then(() => read(map)).finally(() => pending.delete(map));
    sequence = next.then(
      () => {},
      () => {},
    );
    pending.set(map, next);
    return next;
  };
  app.get('/api/map-preview', async (_request, reply): Promise<MapPreview> => {
    reply.header('Cache-Control', 'private, no-store');
    for (const map of mapPreviewMaps)
      if (await load(map)) return { image: `/api/map-preview/${map}.png`, map };
    return { image: null, map: null };
  });
  app.route<{ Params: { map: string } }>({
    method: ['GET', 'HEAD'],
    url: '/api/map-preview/:map.png',
    handler: async (request, reply) => {
      const map = request.params.map;
      if (!known.has(map)) throw new HttpError(404, 'Map preview is unavailable.');
      const item = await load(map);
      if (!item) throw new HttpError(404, 'Map preview is unavailable.');
      reply
        .header('Cache-Control', 'private, no-store')
        .type('image/png')
        .header('Content-Length', item.bytes.length);
      return request.method === 'HEAD' ? reply.send() : reply.send(item.bytes);
    },
  });
}
