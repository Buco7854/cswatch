import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { z } from 'zod';
import type { ViewmodelCatalog } from '../../shared/viewmodel-assets.js';
import { viewmodelManifest, presentationDirectory } from './asset-preparer.js';
import {
  bytesFrom,
  fileDigest,
  fileVersion,
  regularFile,
  withDirectory,
} from './map-asset-files.js';
import { equipmentModelKeys, validEquipmentGlb } from './equipment-model-assets.js';
import { presentationCatalogComplete } from './presentation-assets.js';
import { HttpError } from './security.js';

const MiB = 1024 ** 2;
const hash = z.string().regex(/^[a-f0-9]{64}$/);

async function readRig(directory: FileHandle, id: string, digest?: string) {
  let metadata: FileHandle | undefined, model: FileHandle | undefined;
  try {
    metadata = await regularFile(directory, 'manifest.json', 2, 4096);
    model = await regularFile(directory, 'model.glb', 24, 8 * MiB);
    if (!metadata || !model) return;
    const metaVersion = await fileVersion(metadata),
      version = await fileVersion(model);
    const value = viewmodelManifest.parse(
      JSON.parse((await bytesFrom(metadata, (await metadata.stat()).size, 4096)).toString('utf8')),
    );
    if (
      value.id !== id ||
      value.bytes !== (await model.stat()).size ||
      (digest !== undefined && digest !== value.sha256)
    )
      return;
    const header = await bytesFrom(model, 20, 20);
    if (
      header.toString('ascii', 0, 4) !== 'glTF' ||
      header.readUInt32LE(4) !== 2 ||
      header.readUInt32LE(8) !== value.bytes ||
      header.readUInt32LE(16) !== 0x4e4f534a
    )
      return;
    const data = digest ? await bytesFrom(model, value.bytes, 8 * MiB) : undefined;
    const sha = data
      ? createHash('sha256').update(data).digest('hex')
      : await fileDigest(model, 8 * MiB);
    if (
      sha !== value.sha256 ||
      (data && !validEquipmentGlb(data)) ||
      version !== (await fileVersion(model)) ||
      metaVersion !== (await fileVersion(metadata))
    )
      return;
    const { sha256, bytes, decodedGeometryBytes, decodedTextureBytes } = value;
    return {
      asset: {
        sha256,
        bytes,
        decodedGeometryBytes,
        decodedTextureBytes,
        model: `/api/assets/viewmodels/${id}/${sha256}.glb`,
      },
      data,
    };
  } catch {
    return;
  } finally {
    await metadata?.close();
    await model?.close();
  }
}

export function viewmodelAssetRoutes(app: FastifyInstance, mapsRoot: string, jobsRoot: string) {
  const keys = equipmentModelKeys.filter((id) => !['defuser', 'plantedc4'].includes(id));
  const known = new Set(keys);
  const read = (id: string, digest?: string) =>
    withDirectory(mapsRoot, [presentationDirectory, 'viewmodels', id], (directory) =>
      readRig(directory, id, digest),
    );
  // Coalesce concurrent discovery and bound binary verification/allocation.
  let discovery: Promise<ViewmodelCatalog> | undefined;
  const discover = async (): Promise<ViewmodelCatalog> => {
    const items: ViewmodelCatalog['items'] = {};
    for (const id of keys) {
      const rig = await read(id);
      if (rig) items[id] = rig.asset;
    }
    const complete = await presentationCatalogComplete(
      jobsRoot,
      'viewmodels',
      Object.keys(items).length,
    );
    return { items, ...(complete === undefined ? {} : { complete }) };
  };
  app.get('/api/assets/viewmodels', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return (discovery ??= discover().finally(() => {
      discovery = undefined;
    }));
  });
  let sequence: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, ReturnType<typeof read>>();
  app.get<{ Params: { id: string; sha: string } }>(
    '/api/assets/viewmodels/:id/:sha.glb',
    async (request, reply) => {
      const { id, sha } = request.params;
      if (!known.has(id) || !hash.safeParse(sha).success)
        throw new HttpError(404, 'First-person model is unavailable.');
      const key = id + '/' + sha;
      let work = pending.get(key);
      if (!work) {
        if (pending.size >= 16) throw new HttpError(503, 'First-person model is busy.');
        work = sequence.then(() => read(id, sha)).finally(() => pending.delete(key));
        sequence = work.catch(() => undefined);
        pending.set(key, work);
      }
      const rig = await work;
      if (!rig?.data) throw new HttpError(404, 'First-person model is unavailable.');
      return reply
        .header('Cache-Control', 'private, no-store')
        .type('model/gltf-binary')
        .send(rig.data);
    },
  );
}
