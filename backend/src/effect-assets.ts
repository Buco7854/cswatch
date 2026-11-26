import type { FileHandle } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bytesFrom, regularFile, withDirectory, fileVersion } from './map-asset-files.js';
import { HttpError } from './security.js';
import type { EffectTextureCatalog } from '../../shared/effect-textures.js';
const {
  managedEffectDirectory,
  effectTextureRegistry,
  effectTextureLimits: limits,
}: typeof import('../../shared/effect-texture-bank.mjs') = await import(
  new URL(
    import.meta.url.endsWith('.ts')
      ? '../../shared/effect-texture-bank.mjs'
      : './effect-texture-bank.mjs',
    import.meta.url,
  ).href
);

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    width: z.number().int().min(1).max(limits.atlasEdge),
    height: z.number().int().min(1).max(limits.atlasEdge),
    cell: z.number().int().min(1).max(limits.atlasEdge),
    columns: z.number().int().min(1).max(limits.atlasEdge),
    sequences: z
      .array(
        z
          .object({
            start: z.number().int().min(0).max(limits.frames),
            count: z.number().int().min(1).max(limits.frames),
            clamp: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(limits.sequences),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(57).max(limits.atlasBytes),
  })
  .strict();
type Descriptor = z.infer<typeof manifestSchema>;

/** A published atlas: the manifest and PNG are re-read, size- and hash-checked on every request. */
async function readEffect(
  root: string,
  id: string,
  descriptorOnly: boolean,
): Promise<{ descriptor: Descriptor; data: Buffer } | undefined> {
  if (!Object.hasOwn(effectTextureRegistry.items, id)) return;
  return withDirectory(
    root,
    [managedEffectDirectory, 'effects', id],
    async (directory: FileHandle) => {
      const metadata = await regularFile(directory, 'manifest.json', 2, 8192);
      if (!metadata) return;
      let descriptor: Descriptor;
      try {
        const version = await fileVersion(metadata);
        descriptor = manifestSchema.parse(
          JSON.parse(
            (await bytesFrom(metadata, (await metadata.stat()).size, 8192)).toString('utf8'),
          ),
        );
        if (version !== (await fileVersion(metadata))) return;
      } finally {
        await metadata.close();
      }
      const frames = descriptor.sequences.reduce((n, s) => Math.max(n, s.start + s.count), 0);
      if (
        descriptor.id !== id ||
        descriptor.columns * descriptor.cell !== descriptor.width ||
        Math.ceil(frames / descriptor.columns) * descriptor.cell > descriptor.height
      )
        return;
      const file = await regularFile(directory, 'atlas.png', 57, limits.atlasBytes);
      if (!file) return;
      try {
        const version = await fileVersion(file),
          info = await file.stat();
        if (info.size !== descriptor.bytes) return;
        if (descriptorOnly) return { descriptor, data: Buffer.alloc(0) };
        const data = await bytesFrom(file, info.size, limits.atlasBytes);
        if (
          createHash('sha256').update(data).digest('hex') !== descriptor.sha256 ||
          version !== (await fileVersion(file)) ||
          data.readUInt32BE(0) !== 0x89504e47 ||
          data.readUInt32BE(16) !== descriptor.width ||
          data.readUInt32BE(20) !== descriptor.height
        )
          return;
        return { descriptor, data };
      } finally {
        await file.close();
      }
    },
  );
}

export async function effectAssetRoutes(app: FastifyInstance, mapsRoot: string) {
  let active = 0;
  app.get('/api/effect-assets', async () => {
    const items: EffectTextureCatalog['items'] = {};
    let bytes = 0;
    for (const id of Object.keys(effectTextureRegistry.items)) {
      const result = await readEffect(mapsRoot, id, true);
      if (!result) continue;
      const { sha256, width, height, cell, columns, sequences } = result.descriptor;
      bytes += result.descriptor.bytes;
      if (bytes > limits.bankBytes) break;
      items[id] = {
        url: `/api/effect-assets/${id}.png`,
        sha256,
        bytes: result.descriptor.bytes,
        width,
        height,
        cell,
        columns,
        sequences,
      };
    }
    return { schemaVersion: 1, items } satisfies EffectTextureCatalog;
  });
  app.get<{ Params: { filename: string } }>(
    '/api/effect-assets/:filename',
    async (request, reply) => {
      const match = /^([a-z0-9-]{1,40})\.png$/.exec(request.params.filename);
      if (!match) throw new HttpError(404, 'Effect texture is unavailable.');
      if (active >= 2) {
        reply.header('retry-after', '2');
        throw new HttpError(429, 'Effect texture loading is busy.');
      }
      active++;
      let result;
      try {
        result = await readEffect(mapsRoot, match[1], false);
      } finally {
        active--;
      }
      if (!result) throw new HttpError(404, 'Effect texture is unavailable.');
      reply
        .header('etag', `"${result.descriptor.sha256}"`)
        .header('cache-control', 'private, no-cache');
      return reply.type('image/png').send(result.data);
    },
  );
}
