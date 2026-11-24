/** Read only the lighting described by a manifest-verified map's own world. */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { textureReflectivity } from './material-color-adjust.mjs';
import { regular } from './asset-storage.mjs';
import { source2References } from './source2-dependencies.mjs';
import { discoverMapLayerImages } from './prepare-map-layers.mjs';
import { discoverNativeMapLighting } from './native-map-lighting-layout.mjs';

const MiB = 1024 ** 2;
const atlasInputs = [
  ['irradiance', 'exr', 512 * MiB, '--irradiance-exr'],
  ['direct_light_shadows', 'png', 32 * MiB, '--sun-shadow-png'],
  ['directional_irradiance', 'png', 32 * MiB, '--lighting-direction-png'],
];
const plain = (reason) => ({ args: [], proof: { path: 'pbr', reason } });

/** S2V emits nested builder defaults as well as the actual compiled world block. */
export function inspectWorldLightmaps(data, prefix, sunChannel) {
  if (Buffer.byteLength(data) > 256 * 1024 || data.includes('\0'))
    return plain('unsupported_world');
  const worlds = [...data.matchAll(/^\tm_worldLightingInfo\s*=\s*\r?\n\t\{\r?\n([\s\S]*?)^\t\}/gm)];
  if (worlds.length !== 1) return plain('no_world_lightmaps');
  const [, lighting] = worlds[0];
  const field = (name) =>
    new RegExp(`^\\t\\t${name}\\s*=\\s*([^\\r\\n]+)$`, 'm').exec(lighting)?.[1].trim();
  if (field('m_bHasLightmaps') !== 'true') return plain('no_world_lightmaps');
  if (
    field('m_nLightmapVersionNumber') !== '8' ||
    field('m_nLightmapGameVersionNumber') !== '2' ||
    ![undefined, 'false'].includes(field('m_bBakedShadowsGamma20')) ||
    ![undefined, 'false'].includes(field('m_bSHLightmaps')) ||
    ![undefined, '0'].includes(field('m_nLightmapEncoding'))
  )
    return plain('unsupported_lightmap_format');
  const uvScale = /^\[\s*([\d.]+),\s*([\d.]+)\s*\]$/
    .exec(field('m_vLightmapUvScale') ?? '')
    ?.slice(1)
    .map(Number);
  const atlas = /^\t\tm_lightMaps\s*=\s*\r?\n\t\t\[\r?\n([\s\S]*?)^\t\t\]/m.exec(lighting)?.[1];
  const maps = [...(atlas ?? '').matchAll(/^\s*resource:"([a-z0-9_/.]+)\.vtex",?\s*$/gm)].map(
    (row) => row[1] + '.vtex_c',
  );
  if (
    !uvScale?.every((value) => value >= 1 / 16 && value <= 16) ||
    new Set(maps).size !== maps.length
  )
    return plain('unsupported_atlas_layout');
  const resources = atlasInputs.map(([name]) => `${prefix}/lightmaps/${name}.vtex_c`);
  if (resources.some((resource) => !maps.includes(resource)))
    return plain('missing_lightmap_resource');
  const bakedShadows = /^\t\tm_bakedShadows\s*=\s*\r?\n\t\t\[\r?\n([\s\S]*?)^\t\t\]/m.exec(
    lighting,
  )?.[1];
  const channels = [
    ...(bakedShadows ?? '').matchAll(/^\t\t\t\tm_nShadowChannel\s*=\s*([0-3])\s*$/gm),
  ].map((row) => Number(row[1]));
  if (
    sunChannel === undefined ||
    (sunChannel !== null && channels.filter((value) => value === sunChannel).length !== 1)
  )
    return plain('unsupported_sun_shadow_binding');
  return { resources, uvScale, sunChannel };
}

export async function prepareInstalledBakedLighting({
  map,
  packageFile,
  game,
  stage,
  index,
  execute,
  s2v,
  hasHeadroom,
  sunChannel,
  input,
}) {
  const canPrepareAtlas = await hasHeadroom(672 * MiB);
  if (!canPrepareAtlas && (!input || !(await hasHeadroom(128 * MiB))))
    return plain('lightmap_storage_budget');
  const folder = join(stage, 'baked-light-source');
  await mkdir(folder, { mode: 0o700 });
  const source = await index(join(game, packageFile));
  const readAtlas = async () => {
    const prefix = `maps/${map}`;

    const worldKey = `${prefix}/world.vwrld_c`;
    const world = source.entries.get(worldKey);
    if (!world || world.length + world.preloadBytes > 256 * 1024) return plain('unsupported_world');
    const worldBytes = await source.readEntry(worldKey);
    if (!worldBytes) return plain('lightmap_crc_failed');

    const compiledWorld = join(folder, 'world.vwrld_c');
    await writeFile(compiledWorld, worldBytes, { flag: 'wx', mode: 0o600 });
    const dump = await execute(
      s2v,
      ['-i', compiledWorld, '--block', 'DATA'],
      `${map}-lightmap-world`,
      { allowFailure: true },
    );
    if (dump.code !== 0) return plain('unsupported_world');
    const spec = inspectWorldLightmaps(dump.stdout, prefix, sunChannel);
    return spec.resources
      ? await prepareAtlas({ map, folder, source, worldBytes, world, worldKey, spec, execute, s2v })
      : spec;
  };
  const { args, proof } = canPrepareAtlas ? await readAtlas() : plain('lightmap_storage_budget');
  if (input && (await hasHeadroom(128 * MiB))) {
    const banks = [source];
    for (const name of ['csgo', 'core'])
      banks.push(await index(join(game, 'game', name, 'pak01_dir.vpk')));
    const native = await discoverNativeMapLighting({
      input,
      source,
      map,
      banks,
      folder,
      execute,
      s2v,
      includeAtlas: proof.path === 'lightmap_v8_2',
    });
    if (Object.keys(native.secondaryUv ?? {}).length) {
      const path = join(folder, 'native-secondary-uv.json'),
        bytes = JSON.stringify(native.secondaryUv);
      if (Buffer.byteLength(bytes) > 4 * MiB)
        throw Error('Native layer UV bindings exceed their limit.');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      args.push('--native-layer-uv', path);
    }
    const count = Object.keys(native.bindings).length;
    proof.layouts = { models: native.models, materials: native.materials, bindings: count };
    if (count) {
      const path = join(folder, 'native-bindings.json');
      const bytes = JSON.stringify(native.bindings);
      if (Buffer.byteLength(bytes) > 4 * MiB)
        throw Error('Native lighting bindings exceed their limit.');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      args.push('--native-lighting-bindings', path);
    }
    const layers = await prepareLayerImages({ input, banks, folder, execute, s2v });
    if (layers) {
      args.push('--layer-images', layers.folder);
      proof.layers = layers.resources;
    }
  }
  return { args, proof };
}

async function prepareAtlas({
  map,
  folder,
  source,
  worldBytes,
  world,
  worldKey,
  spec,
  execute,
  s2v,
}) {
  const references = new Set(source2References(worldBytes));
  if (spec.resources.some((resource) => !references.has(resource) || !source.entries.has(resource)))
    return plain('missing_lightmap_resource');
  const args = [`--sun-shadow-channel=${spec.sunChannel ?? -1}`];
  const resources = [];
  for (const [i, [name, extension, limit, option]] of atlasInputs.entries()) {
    const key = spec.resources[i];
    const entry = source.entries.get(key);
    const size = entry.length + entry.preloadBytes;
    if (size < 1 || size > 128 * MiB) return plain('lightmap_input_budget');
    const bytes = await source.readEntry(key);
    if (!bytes || bytes.length !== size) return plain('lightmap_crc_failed');
    const compiled = join(folder, name + '.vtex_c');
    await writeFile(compiled, bytes, { flag: 'wx', mode: 0o600 });
    const result = await execute(
      s2v,
      ['-i', compiled, '--decompile', '--output', folder, '--quiet'],
      `${map}-${name}-lightmap`,
      { allowFailure: true },
    );
    const image = join(folder, name + '.' + extension);
    if (result.code !== 0 || !(await regular(image, limit).catch(() => undefined)))
      return plain('unsupported_lightmap_decode');
    args.push(option, image);
    resources.push({ resource: key, crc32: entry.crc32, bytes: size });
  }
  return {
    args,
    proof: {
      path: 'lightmap_v8_2',
      world: worldKey,
      worldCrc: world.crc32,
      ...spec,
      resources,
    },
  };
}

async function prepareLayerImages({ input, banks, folder, execute, s2v }) {
  const keys = await discoverMapLayerImages(input);
  if (!keys.length) return;
  const destination = join(folder, 'layers');
  await mkdir(destination, { mode: 0o700 });
  const resources = [];
  let total = 0,
    sourceBytes = 0;
  for (const [i, { key, edge, headerOnly }] of keys.entries()) {
    const bank = banks.find((candidate) => candidate.entries.has(key));
    if (!bank) continue;
    const entry = bank.entries.get(key),
      size = entry.length + entry.preloadBytes;
    if (size < 1 || size > 48 * MiB || sourceBytes + size > 768 * MiB) continue;
    const data = await bank.readEntry(key);
    if (data?.length !== size) continue;
    sourceBytes += size;
    const reflectivity = textureReflectivity(data);
    const row = {
      resource: key,
      crc32: entry.crc32,
      bytes: size,
      ...(reflectivity ? { reflectivity } : {}),
      ...(headerOnly ? { headerOnly: true } : {}),
    };
    if (headerOnly) {
      if (reflectivity) resources.push(row);
      continue;
    }
    const compiled = join(folder, `layer-${i}.vtex_c`);
    await writeFile(compiled, data, { flag: 'wx', mode: 0o600 });
    const result = await execute(
      s2v,
      ['-i', compiled, '--decompile', '--output', folder, '--quiet'],
      `lightmap-layer-${i}`,
      { allowFailure: true },
    );
    await unlink(compiled);
    const path = join(folder, `layer-${i}.png`);
    const image = result.code === 0 && (await regular(path, 96 * MiB).catch(() => undefined));
    if (!image) {
      await unlink(path).catch(() => {});
      continue;
    }
    const target = join(destination, `${resources.length}.png`);
    let output;
    try {
      output = await resizeLayerImage(path, edge);
    } catch (error) {
      if (error?.code === 'ENOSPC') throw error;
      await unlink(path);
      continue;
    }
    const length = output?.length ?? image.size;
    if (total + length > 64 * MiB) {
      await unlink(path);
      continue;
    }
    if (output) {
      await writeFile(target, output, { flag: 'wx', mode: 0o600 });
      await unlink(path);
    } else await rename(path, target);
    total += length;
    resources.push(row);
  }
  if (!resources.length) return;
  await writeFile(
    join(destination, 'inputs.json'),
    JSON.stringify(
      resources.map(({ resource: key, reflectivity, headerOnly }) => ({
        key,
        reflectivity,
        headerOnly,
      })),
    ),
    { flag: 'wx', mode: 0o600 },
  );
  return { folder: destination, resources };
}

// Resize material channels independently. Transparent RGB can hold height, wetness or tint.
export async function resizeLayerImage(path, edge) {
  const decode = () => sharp(path, { limitInputPixels: 32 * 1024 ** 2 });
  const { width, height, hasAlpha, format } = await decode().metadata();
  if (format !== 'png' || !width || !height) throw Error('Invalid material input.');
  if (Math.max(width, height) <= edge) return;
  const ratio = edge / Math.max(width, height);
  const size = {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
  if (!hasAlpha) return decode().resize(size).png().toBuffer();
  const rgb = await decode().removeAlpha().toColourspace('srgb').raw().toBuffer();
  const color = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(size)
    .raw()
    .toBuffer();
  const alpha = await decode().extractChannel('alpha').raw().toBuffer();
  const mask = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .resize(size)
    .greyscale()
    .raw()
    .toBuffer();
  return sharp(color, { raw: { ...size, channels: 3 } })
    .joinChannel(mask, { raw: { ...size, channels: 1 } })
    .png()
    .toBuffer();
}
