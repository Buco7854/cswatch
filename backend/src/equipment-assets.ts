import type { FastifyInstance } from 'fastify';
import { constants, readFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { HttpError } from './security.js';
import { z } from 'zod';

/** Fixed, version-controlled registry shared with the operator CLI and frontend.
 * Builds copy it next to this module; development reads the same source registry. */
const registry = z
  .object({
    schema: z.literal(1),
    items: z
      .record(z.string().regex(/^[a-z0-9]{1,40}$/), z.string().regex(/^[a-z0-9_]{1,80}\.svg$/))
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
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Bounded raster structure, not an SVG/content-type assertion or a full image decoder. */
export function validEquipmentPng(data: Buffer): boolean {
  if (
    data.length < 57 ||
    data.length > equipmentIconLimits.bytes ||
    !data.subarray(0, 8).equals(signature)
  )
    return false;
  let offset = 8,
    chunks = 0,
    idat = false;
  while (offset + 12 <= data.length && ++chunks <= 1024) {
    const size = data.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > data.length) return false;
    const kind = data.toString('latin1', offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(kind) ||
      crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)
    )
      return false;
    if (chunks === 1) {
      if (kind !== 'IHDR' || size !== 13) return false;
      const width = data.readUInt32BE(offset + 8),
        height = data.readUInt32BE(offset + 12);
      if (
        !width ||
        !height ||
        width > equipmentIconLimits.dimension ||
        height > equipmentIconLimits.dimension ||
        width * height > equipmentIconLimits.pixels
      )
        return false;
      const depth = data[offset + 16],
        color = data[offset + 17];
      if (
        !(
          { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<
            number,
            number[]
          >
        )[color]?.includes(depth) ||
        data[offset + 18] !== 0 ||
        data[offset + 19] !== 0 ||
        data[offset + 20] > 1
      )
        return false;
    } else if (kind === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(kind)) return false;
    else if (!['PLTE', 'IDAT', 'IEND'].includes(kind) && kind[0] === kind[0].toUpperCase())
      return false;
    if (kind === 'IDAT' && size) idat = true;
    if (kind === 'IEND') return size === 0 && idat && end === data.length;
    offset = end;
  }
  return false;
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
    handles.push(await open(root, constants.O_RDONLY | constants.O_DIRECTORY));
    for (const name of ['maps', 'equipment'])
      handles.push(await open(`/proc/self/fd/${handles.at(-1)!.fd}/${name}`, flags));
    return await read(handles.at(-1)!);
  } catch {
    return;
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function equipmentAssetRoutes(app: FastifyInstance, dataRoot: string) {
  const cache = new Map<string, { version: string; data: Buffer }>();
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
      const version = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
      const previous = cache.get(key);
      if (previous?.version === version) return previous.data;
      discard(key);
      const data = Buffer.alloc(stat.size);
      let bytes = 0;
      while (bytes < data.length) {
        const part = await handle.read(data, bytes, data.length - bytes, bytes);
        if (!part.bytesRead) return;
        bytes += part.bytesRead;
      }
      // A growing/in-place replaced file cannot change the bytes already bounded and validated.
      if (!validEquipmentPng(data)) return;
      // Another request may have populated this key while the descriptor read was awaited.
      discard(key);
      cache.set(key, { version, data });
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
  app.get('/api/assets/equipment', async () => ({
    icons:
      (await withDirectory(dataRoot, async (folder) => {
        const icons: Record<string, string> = {};
        for (const key of equipmentIconKeys)
          if (await load(folder, key)) icons[key] = `/api/assets/equipment/${key}.png`;
        return icons;
      })) || {},
  }));
  app.get<{ Params: { filename: string } }>(
    '/api/assets/equipment/:filename',
    async (request, reply) => {
      const match = /^([a-z0-9]+)\.png$/.exec(request.params.filename);
      if (!match || !known.has(match[1])) throw new HttpError(404, 'Equipment artwork not found.');
      const data = await withDirectory(dataRoot, (folder) => load(folder, match[1]));
      if (!data) throw new HttpError(404, 'Equipment artwork not found.');
      return reply.type('image/png').send(data);
    },
  );
}
