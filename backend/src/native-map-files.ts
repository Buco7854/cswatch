import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';
import { bytesFrom, regularFile, withDirectory, fileVersion } from './map-asset-files.js';
import type { MapAssetLocation } from './map-asset-location.js';
const { validate } = await import(
  new URL(
    import.meta.url.endsWith('.ts')
      ? '../../shared/native-world-format.mjs'
      : './native-world-format.mjs',
    import.meta.url,
  ).href
);
type Digest = { size: number; sha256: string };
type Payload = Digest & { br?: Digest };
const manifestLimit = 16 * 1024 ** 2;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const nativePayloadName = /^(?:map\.json|[a-f0-9]{64}\.bin)$/;
type Index = {
  files: Record<string, Payload>;
  hash: string;
  manifest: Buffer;
  version: string;
  sourceManifest: string;
};
const cache = new Map<string, Index>();

async function index(dir: FileHandle, key: string, map: string) {
  const file = await regularFile(dir, 'map.json', 2, manifestLimit);
  if (!file) return;
  try {
    const version = await fileVersion(file);
    const prior = cache.get(key);
    if (prior?.version === version) return prior;
    const manifest = await bytesFrom(file, (await file.stat()).size, manifestLimit);
    const value = validate(JSON.parse(manifest.toString()));
    if (
      value.map !== map ||
      !/^[1-9]\d{0,19}$/.test(value.sourceManifest) ||
      version !== (await fileVersion(file))
    )
      return;
    const item: Index = {
      files: value.files,
      hash: digest(manifest),
      manifest,
      version,
      sourceManifest: value.sourceManifest,
    };
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(key, item);
    return item;
  } finally {
    await file.close();
  }
}

export async function nativeIndex(location: MapAssetLocation, map: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(map)) return;
  return withDirectory(location.root, [...location.parts, map], (dir) =>
    index(dir, [location.root, ...location.parts, map].join('/'), map),
  );
}

export async function nativePayload(
  location: MapAssetLocation,
  map: string,
  hash: string,
  name: string,
  brotli: boolean,
) {
  if (!nativePayloadName.test(name)) return;
  const item = await nativeIndex(location, map);
  if (!item || item.hash !== hash) return;
  if (name === 'map.json' && !brotli) return { bytes: item.manifest, compressed: false };
  return withDirectory(location.root, [...location.parts, map], async (dir) => {
    const record = item.files[name];
    const compressed = brotli && (name === 'map.json' || Boolean(record?.br));
    const expected = compressed ? record?.br : record;
    if (name !== 'map.json' && !expected) return;
    let file: FileHandle | undefined;
    try {
      file = await regularFile(
        dir,
        name + (compressed ? '.br' : ''),
        expected?.size ?? 1,
        expected?.size ?? manifestLimit,
      );
      if (!file) return;
      const bytes = await bytesFrom(
        file,
        (await file.stat()).size,
        expected?.size ?? manifestLimit,
      );
      if (expected && digest(bytes) !== expected.sha256) return;
      if (
        name === 'map.json' &&
        !brotliDecompressSync(bytes, { maxOutputLength: item.manifest.length }).equals(
          item.manifest,
        )
      )
        return;
      return { bytes, compressed };
    } catch (error) {
      if (name === 'map.json' && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return { bytes: item.manifest, compressed: false };
      throw error;
    } finally {
      await file?.close();
    }
  });
}
