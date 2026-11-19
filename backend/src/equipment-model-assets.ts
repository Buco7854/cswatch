import type { FastifyInstance } from 'fastify';
import type { FileHandle } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
import type { EquipmentModel, EquipmentModelCatalog } from '../../shared/equipment-models.js';
import {
  bytesFrom,
  fileDigest,
  fileVersion,
  regularFile,
  withDirectory,
} from './map-asset-files.js';
import { HttpError } from './security.js';
import { presentationCatalogComplete } from './presentation-assets.js';

const registry = JSON.parse(
  readFileSync(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../../shared/equipment-models.json'
        : './equipment-models.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
export const equipmentModelKeys = Object.freeze(Object.keys(registry.items) as string[]);
if (
  registry.schemaVersion !== 1 ||
  equipmentModelKeys.length < 1 ||
  equipmentModelKeys.length > 96 ||
  equipmentModelKeys.some((id) => !/^[a-z0-9]{1,40}$/.test(id))
)
  throw new Error('Invalid fixed equipment model registry');
const known = new Set(equipmentModelKeys);
export const equipmentModelLimits = {
  manifestBytes: 16384,
  bytes: 16 * 1024 ** 2,
  decodedTextureBytes: 16 * 1024 ** 2,
  geometryBytes: 8 * 1024 ** 2,
  cacheBytes: 64 * 1024 ** 2,
} as const;
const vector = (bound: number) =>
  z.tuple([
    z.number().finite().min(-bound).max(bound),
    z.number().finite().min(-bound).max(bound),
    z.number().finite().min(-bound).max(bound),
  ]);
const rotation = z.tuple([
  z
    .number()
    .finite()
    .min(-Math.PI * 2)
    .max(Math.PI * 2),
  z
    .number()
    .finite()
    .min(-Math.PI * 2)
    .max(Math.PI * 2),
  z
    .number()
    .finite()
    .min(-Math.PI * 2)
    .max(Math.PI * 2),
]);
const transform = z
  .object({ position: vector(4), rotation, scale: z.number().finite().min(0.1).max(4) })
  .strict();
export const equipmentModelManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.enum(equipmentModelKeys as [string, ...string[]]),
    coordinateSystem: z.literal('viewer-meters-y-up-x-forward'),
    assetVersion: z.string().trim().min(1).max(100),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(24).max(equipmentModelLimits.bytes),
    decodedTextureBytes: z.number().int().min(0).max(equipmentModelLimits.decodedTextureBytes),
    geometryBytes: z.number().int().min(0).max(equipmentModelLimits.geometryBytes),
    bounds: z
      .object({ min: vector(8), max: vector(8) })
      .strict()
      .refine((value) =>
        value.min.every((minimum, i) => minimum <= value.max[i] && value.max[i] - minimum <= 8),
      ),
    attachments: z
      .object({ approximate: z.literal(true), hold: transform, pov: transform })
      .strict(),
  })
  .strict();

/** The operator packer validates geometry/textures. HTTP additionally rejects external
 * resources and malformed containers before exposing the hash-bound local binary. */
export function validEquipmentGlb(bytes: Buffer): boolean {
  try {
    if (
      bytes.length < 24 ||
      bytes.length > equipmentModelLimits.bytes ||
      bytes.toString('ascii', 0, 4) !== 'glTF' ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length
    )
      return false;
    const length = bytes.readUInt32LE(12);
    if (
      length < 4 ||
      length % 4 ||
      length > 1024 ** 2 ||
      length > bytes.length - 20 ||
      bytes.readUInt32LE(16) !== 0x4e4f534a
    )
      return false;
    const json = JSON.parse(bytes.toString('utf8', 20, 20 + length));
    if (json?.asset?.version !== '2.0') return false;
    const queue: unknown[] = [json];
    let nodes = 0;
    while (queue.length) {
      const value = queue.pop();
      if (!value || typeof value !== 'object') continue;
      if (++nodes > 100000 || Object.hasOwn(value, 'uri')) return false;
      queue.push(...Object.values(value));
    }
    const end = length + 20;
    if (end === bytes.length) return !json.buffers?.length;
    return (
      end + 8 <= bytes.length &&
      bytes.readUInt32LE(end + 4) === 0x004e4942 &&
      bytes.readUInt32LE(end) % 4 === 0 &&
      end + 8 + bytes.readUInt32LE(end) === bytes.length
    );
  } catch {
    return false;
  }
}

export async function equipmentModelAssetRoutes(
  app: FastifyInstance,
  root: string,
  mapsRoot = join(root, 'maps'),
  jobsRoot?: string,
) {
  const cache = new Map<string, { manifestDigest: string; sha256: string; data: Buffer }>();
  let cachedBytes = 0;
  const discard = (id: string) => {
    const previous = cache.get(id);
    if (previous) cachedBytes -= previous.data.length;
    cache.delete(id);
  };
  const withPack = <T>(id: string, read: (directory: FileHandle) => Promise<T>) =>
    withDirectory(mapsRoot, ['equipment-models', id], read);
  const descriptor = async (id: string, directory: FileHandle) => {
    let file: FileHandle | undefined, model: FileHandle | undefined;
    try {
      file = await regularFile(directory, 'manifest.json', 2, equipmentModelLimits.manifestBytes);
      model = await regularFile(directory, 'model.glb', 24, equipmentModelLimits.bytes);
      if (!file || !model) return;
      const version = await fileVersion(file);
      const raw = await bytesFrom(
        file,
        (await file.stat()).size,
        equipmentModelLimits.manifestBytes,
      );
      const parsed = equipmentModelManifestSchema.parse(JSON.parse(raw.toString('utf8')));
      if (
        parsed.id !== id ||
        parsed.bytes !== (await model.stat()).size ||
        version !== (await fileVersion(file))
      )
        return;
      const header = await bytesFrom(model, 20, 20);
      if (
        header.toString('ascii', 0, 4) !== 'glTF' ||
        header.readUInt32LE(4) !== 2 ||
        header.readUInt32LE(8) !== parsed.bytes ||
        header.readUInt32LE(16) !== 0x4e4f534a
      )
        return;
      const { schemaVersion: _schema, id: _id, coordinateSystem: _axes, ...publicFields } = parsed;
      return {
        model: {
          ...publicFields,
          model: `/api/assets/equipment-models/${id}.glb`,
        } satisfies EquipmentModel,
        digest: createHash('sha256').update(raw).digest('hex'),
      };
    } catch {
      return;
    } finally {
      await file?.close();
      await model?.close();
    }
  };
  const load = async (id: string) =>
    withPack(id, async (directory) => {
      const metadata = await descriptor(id, directory);
      if (!metadata) {
        discard(id);
        return;
      }
      let file: FileHandle | undefined;
      try {
        file = await regularFile(directory, 'model.glb', 24, equipmentModelLimits.bytes);
        if (!file || (await file.stat()).size !== metadata.model.bytes) {
          discard(id);
          return;
        }
        const version = await fileVersion(file);
        const previous = cache.get(id);
        if (
          previous?.manifestDigest === metadata.digest &&
          previous.sha256 === metadata.model.sha256 &&
          (await fileDigest(file, equipmentModelLimits.bytes)) === previous.sha256 &&
          version === (await fileVersion(file))
        ) {
          const after = await descriptor(id, directory);
          if (after?.digest === metadata.digest) return previous.data;
          discard(id);
          return;
        }
        discard(id);
        const data = await bytesFrom(file, metadata.model.bytes, equipmentModelLimits.bytes);
        if (
          !validEquipmentGlb(data) ||
          createHash('sha256').update(data).digest('hex') !== metadata.model.sha256 ||
          version !== (await fileVersion(file))
        )
          return;
        const after = await descriptor(id, directory);
        if (after?.digest !== metadata.digest) return;
        cache.set(id, { manifestDigest: metadata.digest, sha256: metadata.model.sha256, data });
        cachedBytes += data.length;
        while (cachedBytes > equipmentModelLimits.cacheBytes) discard(cache.keys().next().value!);
        return data;
      } finally {
        await file?.close();
      }
    });
  // One bounded binary allocation at a time; duplicate requests share the same work.
  let sequence: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<Buffer | undefined>>();
  const queued = (id: string) => {
    const existing = pending.get(id);
    if (existing) return existing;
    const promise = sequence.then(() => load(id)).finally(() => pending.delete(id));
    sequence = promise.then(
      () => {},
      () => {},
    );
    pending.set(id, promise);
    return promise;
  };
  app.get(
    '/api/assets/equipment-models',
    async (_request, reply): Promise<EquipmentModelCatalog> => {
      reply.header('Cache-Control', 'private, no-store');
      const items: Record<string, EquipmentModel> = {};
      for (const id of equipmentModelKeys) {
        const value = await withPack(id, (directory) => descriptor(id, directory));
        if (value) items[id] = value.model;
      }
      const complete = await presentationCatalogComplete(
        jobsRoot,
        'equipment-models',
        Object.keys(items).length,
      );
      return { schemaVersion: 1, items, ...(complete === undefined ? {} : { complete }) };
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/assets/equipment-models/:id.glb',
    async (request, reply) => {
      if (!known.has(request.params.id))
        throw new HttpError(404, 'Equipment model is unavailable.');
      const data = await queued(request.params.id);
      if (!data) throw new HttpError(404, 'Equipment model is unavailable.');
      return reply
        .header('Cache-Control', 'private, no-store')
        .type('model/gltf-binary')
        .send(data);
    },
  );
}
