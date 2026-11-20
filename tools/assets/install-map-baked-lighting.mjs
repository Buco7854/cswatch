/** Conversion inputs are admitted only for the official source whose lightmap and sun
 * channel binding have been checked. No converter accepts a URL or caller-selected resource. */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileHash, regular } from './asset-storage.mjs';
import layerSources from './mirage-layer-textures.json' with { type: 'json' };

const MiB = 1024 ** 2;
const mirage = Object.freeze({
  map: 'de_mirage',
  manifest: '8225060435969537482',
  bytes: 176187297,
  sha256: 'e66cdf1ae6a976f6f6ba510a2addd04b25a4c1cfd811f51f1ef13f0954e6e350',
  lightmapVersion: 8,
  gameVersion: 2,
  sunShadowChannel: 0,
});

export async function prepareInstalledBakedLighting({
  map,
  manifest,
  game,
  stage,
  index,
  execute,
  s2v,
  hasHeadroom,
}) {
  if (map !== mirage.map || manifest !== mirage.manifest) return;
  if (!(await hasHeadroom(448 * MiB))) return;
  const packageFile = join(game, 'game/csgo/maps/de_mirage.vpk');
  if (
    (await regular(packageFile, mirage.bytes)).size !== mirage.bytes ||
    (await fileHash(packageFile, 'sha256', mirage.bytes)) !== mirage.sha256
  )
    return; // A different source keeps the ordinary material path.
  const folder = join(stage, 'baked-light-source');
  await mkdir(folder, { mode: 0o700 });
  const source = await index(packageFile);
  const selected = [
    { name: 'irradiance', extension: 'exr', bytes: 76070675, crc: 3330126278, limit: 320 * MiB },
    {
      name: 'direct_light_shadows',
      extension: 'png',
      bytes: 3863286,
      crc: 638885205,
      limit: 32 * MiB,
    },
    {
      name: 'directional_irradiance',
      extension: 'png',
      bytes: 7380587,
      crc: 2333701480,
      limit: 32 * MiB,
    },
  ];
  const files = [];
  for (const asset of selected) {
    const key = `maps/${mirage.map}/lightmaps/${asset.name}.vtex_c`;
    const entry = source.entries.get(key);
    if (!entry || entry.crc32 !== asset.crc || entry.length + entry.preloadBytes !== asset.bytes)
      throw Error('The pinned native lightmap resource is unavailable.');
    const bytes = await source.readEntry(key);
    if (!bytes || bytes.length !== asset.bytes)
      throw Error('The pinned native lightmap resource failed its CRC proof.');
    const compiled = join(folder, asset.name + '.vtex_c');
    await writeFile(compiled, bytes, { flag: 'wx', mode: 0o600 });
    await execute(
      s2v,
      ['-i', compiled, '--decompile', '--output', folder, '--quiet'],
      `${map}-${asset.name}-lightmap`,
    );
    const image = join(folder, asset.name + '.' + asset.extension);
    await regular(image, asset.limit);
    files.push(image);
  }
  const args = [
    '--irradiance-exr',
    files[0],
    '--sun-shadow-png',
    files[1],
    '--lighting-direction-png',
    files[2],
  ];
  const layers = await prepareLayers({ map, game, folder, index, execute, s2v, hasHeadroom });
  if (layers) args.push('--layer-images', layers);
  return {
    args,
    proof: { ...mirage, ...(layers ? { layerTextures: Object.keys(layerSources).length } : {}) },
  };
}

async function prepareLayers({ map, game, folder, index, execute, s2v, hasHeadroom }) {
  if (!(await hasHeadroom(32 * MiB))) return;
  const bank = await index(join(game, 'game/csgo/pak01_dir.vpk'));
  const rows = Object.entries(layerSources);
  if (
    !rows.every(([key, proof]) => {
      const entry = bank.entries.get(key);
      return entry?.crc32 === proof.crc32 && entry.length + entry.preloadBytes === proof.bytes;
    })
  )
    return;
  // The previously verified map dependency closure supplies these CRC-checked ranges.
  // Partial caches keep the already prepared lightmaps.
  const payloads = await Promise.all(
    rows.map(async ([key, proof]) => {
      const payload = await bank.readEntry(key);
      return payload?.length === proof.bytes ? payload : undefined;
    }),
  );
  if (payloads.some((payload) => !payload)) return;
  const exportFolder = join(folder, 'layer-images');
  await mkdir(exportFolder, { mode: 0o700 });
  for (const [i, [key]] of rows.entries()) {
    const name = basename(key, '.vtex_c');
    const compiled = join(folder, name + '.vtex_c');
    await writeFile(compiled, payloads[i], { flag: 'wx', mode: 0o600 });
    await execute(
      s2v,
      ['-i', compiled, '--decompile', '--output', exportFolder, '--quiet'],
      `${map}-layer-${i}`,
    );
    await regular(join(exportFolder, name + '.png'), 12 * MiB);
  }
  return exportFolder;
}
