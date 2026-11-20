import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bytesFrom, fileDigest, regularFile, withDirectory } from './map-asset-files.js';
import { validEquipmentGlb } from './equipment-model-assets.js';
import { HttpError } from './security.js';

const viewmodels = JSON.parse(
  readFileSync(
    new URL(
      import.meta.url.endsWith('.ts') ? '../../shared/viewmodels.json' : './viewmodels.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Record<string, { sha256: string; bytes: number }>;

/** Each exact route admits a byte-pinned optional operator pack under the instance policy. */
export function viewmodelAssetRoutes(app: FastifyInstance, mapsRoot: string) {
  for (const [id, { sha256, bytes }] of Object.entries(viewmodels)) {
    const fileName = sha256 + '.glb';
    let verified: Buffer | undefined;
    let pending: Promise<Buffer | undefined> | undefined;
    const read = () =>
      withDirectory(mapsRoot, ['viewmodels', id], async (directory) => {
        const file = await regularFile(directory, fileName, bytes, bytes);
        if (!file) return;
        try {
          if (verified) return (await fileDigest(file, bytes)) === sha256 ? verified : undefined;
          const data = await bytesFrom(file, bytes, bytes);
          if (
            createHash('sha256').update(data).digest('hex') !== sha256 ||
            !validEquipmentGlb(data)
          )
            return;
          return (verified = data);
        } finally {
          await file.close();
        }
      });
    app.get(`/api/assets/viewmodels/${id}/${fileName}`, async (_request, reply) => {
      pending ??= read().finally(() => {
        pending = undefined;
      });
      const data = await pending;
      if (!data) throw new HttpError(404, 'First-person model is unavailable.');
      return reply
        .header('Cache-Control', 'private, no-store')
        .type('model/gltf-binary')
        .send(data);
    });
  }
}
