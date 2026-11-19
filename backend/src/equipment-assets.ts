import type { FastifyInstance } from 'fastify';
import { constants, readFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { HttpError } from './security.js';
import { z } from 'zod';
import { join } from 'node:path';
import { validPng } from './png.js';
import { createHash } from 'node:crypto';
import { fileDigest, fileVersion } from './asset-content.js';
import { presentationCatalogComplete } from './presentation-assets.js';

/** Fixed, version-controlled registry shared with the operator CLI and frontend.
 * Builds copy it next to this module; development reads the same source registry. */
const registry = z
  .object({
    schema: z.literal(1),
    items: z
      .record(
        z.string().regex(/^[a-z0-9]{1,40}$/),
        z
          .string()
          .regex(/^(?:(?:icons\/ui|hud\/teamcounter|hud\/deathnotice)\/)?[a-z0-9_-]{1,80}\.svg$/),
      )
      .refine((items) => Object.keys(items).length > 0 && Object.keys(items).length <= 128),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          import.meta.url.endsWith('.ts')
            ? '../../shared/equipment-icons.json'
            : './equipment-icons.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
export const equipmentIconKeys = Object.freeze(Object.keys(registry.items));
const known = new Set<string>(equipmentIconKeys);
export const equipmentIconLimits = {
  bytes: 1024 ** 2,
  dimension: 2048,
  pixels: 2 * 1024 ** 2,
  cache: 16 * 1024 ** 2,
} as const;
/** Bounded raster structure, not an SVG/content-type assertion or a full image decoder. */
export function validEquipmentPng(data: Buffer): boolean {
  return validPng(data, equipmentIconLimits);
}

/** Linux directory descriptors anchor every child open even if an operator replaces a path.
 * Missing /proc or unsupported safe opens leave the optional asset pack unavailable. */
async function withDirectory<T>(
  root: string,
  read: (folder: FileHandle) => Promise<T>,
): Promise<T | undefined> {
  const handles: FileHandle[] = [];
  try {
    if (process.platform !== 'linux') return;
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    // DATA_DIR itself is trusted operator configuration; its children may never redirect opens.
    handles.push(await open(root, flags));
    for (const name of ['equipment'])
      handles.push(await open(`/proc/self/fd/${handles.at(-1)!.fd}/${name}`, flags));
    return await read(handles.at(-1)!);
  } catch {
    return;
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function equipmentAssetRoutes(
  app: FastifyInstance,
  dataRoot: string,
  mapsRoot = join(dataRoot, 'maps'),
  jobsRoot?: string,
) {
  const cache = new Map<string, { version: string; digest: string; data: Buffer }>();
  let cachedBytes = 0;
  const discard = (key: string) => {
    const item = cache.get(key);
    if (item) cachedBytes -= item.data.length;
    cache.delete(key);
  };
  const load = async (folder: FileHandle, key: string): Promise<Buffer | undefined> => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        `/proc/self/fd/${folder.fd}/${key}.png`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size < 57 ||
        stat.size > equipmentIconLimits.bytes
      ) {
        discard(key);
        return;
      }
      const version = await fileVersion(handle);
      const previous = cache.get(key);
      if (
        previous?.version === version &&
        (await fileDigest(handle, equipmentIconLimits.bytes)) === previous.digest &&
        version === (await fileVersion(handle))
      )
        return previous.data;
      discard(key);
      const data = Buffer.alloc(stat.size);
      let bytes = 0;
      while (bytes < data.length) {
        const part = await handle.read(data, bytes, data.length - bytes, bytes);
        if (!part.bytesRead) return;
        bytes += part.bytesRead;
      }
      // A growing/in-place replaced file cannot change the bytes already bounded and validated.
      if (!validEquipmentPng(data) || version !== (await fileVersion(handle))) return;
      // Another request may have populated this key while the descriptor read was awaited.
      discard(key);
      cache.set(key, { version, digest: createHash('sha256').update(data).digest('hex'), data });
      cachedBytes += data.length;
      while (cachedBytes > equipmentIconLimits.cache) discard(cache.keys().next().value!);
      return data;
    } catch {
      discard(key);
      return;
    } finally {
      await handle?.close();
    }
  };
  app.get('/api/assets/equipment', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const icons =
      (await withDirectory(mapsRoot, async (folder) => {
        const icons: Record<string, string> = {};
        for (const key of equipmentIconKeys)
          if (await load(folder, key)) icons[key] = `/api/assets/equipment/${key}.png`;
        return icons;
      })) || {};
    const complete = await presentationCatalogComplete(
      jobsRoot,
      'equipment',
      Object.keys(icons).length,
    );
    return { icons, ...(complete === undefined ? {} : { complete }) };
  });
  app.get<{ Params: { filename: string } }>(
    '/api/assets/equipment/:filename',
    async (request, reply) => {
      const match = /^([a-z0-9]+)\.png$/.exec(request.params.filename);
      if (!match || !known.has(match[1])) throw new HttpError(404, 'Equipment artwork not found.');
      const data = await withDirectory(mapsRoot, (folder) => load(folder, match[1]));
      if (!data) throw new HttpError(404, 'Equipment artwork not found.');
      return reply.type('image/png').send(data);
    },
  );
}
