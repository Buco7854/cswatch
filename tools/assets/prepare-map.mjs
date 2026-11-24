#!/usr/bin/env node
/** Trusted operator-only S2V pipeline. Never runs on uploaded demos or public requests. */
import { parseArgs } from 'node:util';
import { resolve, join, dirname, basename } from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, resample, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { fileHash } from './toolchain-security.mjs';
import { writeMapTier } from './map-tier-output.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { MapBakedLightingExtension } from './map-baked-lighting-extension.mjs';
import {
  bindBakedLighting,
  bindVertexLighting,
  prepareBakedLightingAtlas,
} from './prepare-baked-lighting.mjs';
import { readMapLayerImages } from './prepare-map-layers.mjs';
import { readNativeLightingBindings } from './native-map-lighting-layout.mjs';
import { prepareCompactMap } from './prepare-compact-map.mjs';
import { readGlassBindings, bindPreparedGlass } from './prepare-map-glass.mjs';
import { filterMapWorldMaterials } from './map-world-materials.mjs';
const { values: v } = parseArgs({
  options: {
    s2v: { type: 'string' },
    game: { type: 'string' },
    map: { type: 'string' },
    input: { type: 'string' },
    output: { type: 'string' },
    'asset-version': { type: 'string' },
    'irradiance-exr': { type: 'string' },
    'sun-shadow-png': { type: 'string' },
    'sun-shadow-channel': { type: 'string' },
    'auto-lighting': { type: 'boolean' },
    'lighting-direction-png': { type: 'string' },
    'layer-images': { type: 'string' },
    'glass-bindings': { type: 'string' },
    'native-lighting-bindings': { type: 'string' },
    'only-tier': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (v.help || !v.output || !v.map || (!v.input && (!v.game || !v.s2v))) {
  console.log(
    'Usage: npm run prepare-map -- --map de_mirage --output ../../var/maps --s2v /path/Source2Viewer-CLI --game /path/CS2/game/csgo --asset-version BUILD\nOr: --input /path/export.gltf (existing S2V glTF export)',
  );
  process.exit(v.help ? 0 : 1);
}
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(v.map)) throw new Error('Invalid map name');
if (v['only-tier'] && !['desktop', 'mobile', 'compact'].includes(v['only-tier']))
  throw new Error('Invalid map preparation tier.');
if (
  Boolean(v['irradiance-exr']) !== Boolean(v['sun-shadow-png']) ||
  ((v['lighting-direction-png'] || v['layer-images']) && !v['irradiance-exr'])
)
  throw new Error('Supply both Source irradiance and sun-shadow inputs together.');
const root = resolve(v.output, v.map);
await mkdir(root, { recursive: true });
let input = v.input ? resolve(v.input) : join(root, 'source', 'scene.gltf');
let toolVersion = 'operator-export';
if (!v.input) {
  await access(resolve(v.s2v));
  const version = spawnSync(resolve(v.s2v), ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (version.status !== 0) throw new Error('S2V executable is unavailable');
  toolVersion = version.stdout.trim();
  await mkdir(dirname(input), { recursive: true });
  const result = spawnSync(
    resolve(v.s2v),
    [
      '--input',
      join(resolve(v.game), 'maps', v.map + '.vpk'),
      '--game',
      resolve(v.game),
      '--vpk_filepath',
      `maps/${v.map}.vmap_c`,
      '--output',
      input,
      '--gltf_export_format',
      'gltf',
      '--gltf_textures_adapt',
    ],
    { stdio: 'inherit', timeout: 30 * 60 * 1000 },
  );
  if (result.status !== 0)
    throw new Error(
      'S2V export failed. Check your S2V version, installed map, and game search paths.',
    );
}
const source = await fileHash(input, steamAssetLimits.modelBytes);
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions([...ALL_EXTENSIONS, MapBakedLightingExtension])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  .setAllowNetwork(false);
await MeshoptSimplifier.ready;
const layers = v['layer-images'] ? await readMapLayerImages(resolve(v['layer-images'])) : undefined;
const glassBindings = v['glass-bindings']
  ? await readGlassBindings(resolve(v['glass-bindings']))
  : [];
const nativeBindings = v['native-lighting-bindings']
  ? await readNativeLightingBindings(resolve(v['native-lighting-bindings']))
  : undefined;
// Each tier visits textures once. Avoid retaining libvips conversion state while
// the GLB writer needs room for a contiguous geometry buffer.
sharp.cache(false);
sharp.concurrency(1);
const tiers = v['only-tier'] ? [v['only-tier']] : ['desktop', 'mobile'];
for (const tier of tiers.filter((value) => value !== 'compact')) {
  globalThis.gc?.();
  const target = join(root, tier);
  const document = await io.read(input);
  bindPreparedGlass(document, glassBindings);
  const worldMaterials = filterMapWorldMaterials(document);
  let bakedLighting, lightingFallback;
  if (v['irradiance-exr'] && v['sun-shadow-png']) {
    let atlas;
    try {
      atlas = await prepareBakedLightingAtlas({
        irradiance: resolve(v['irradiance-exr']),
        shadow: resolve(v['sun-shadow-png']),
        direction: v['lighting-direction-png'] ? resolve(v['lighting-direction-png']) : undefined,
        sunChannel: v['sun-shadow-channel'] === undefined ? 0 : Number(v['sun-shadow-channel']),
        edge: tier === 'mobile' ? 1024 : 2048,
      });
    } catch (error) {
      if (!v['auto-lighting'] || error.code === 'ENOSPC') throw error;
      lightingFallback = 'unsupported_atlas_data';
      console.error(`${tier} native lightmap: ${error.message}`);
    }
    if (atlas) {
      bakedLighting = bindBakedLighting(document, atlas, layers, nativeBindings);
      if (!bakedLighting) lightingFallback = 'no_supported_lightmap_bindings';
    }
  }
  const vertexLighting = bindVertexLighting(document, nativeBindings);
  await document.transform(
    dedup(),
    prune({ keepSolidTextures: Boolean(bakedLighting) }),
    resample(),
    weld(),
  );
  if (tier === 'mobile')
    await document.transform(
      simplify({ simplifier: MeshoptSimplifier, ratio: 0.65, error: 0.005 }),
    );
  globalThis.gc?.();
  const packed = await writeMapTier({
    document,
    io,
    target,
    map: v.map,
    tier,
    assetVersion: v['asset-version'] || 'unspecified',
    source: { file: basename(input), sha256: source.sha256, bytes: source.bytes },
    s2v: toolVersion,
    // Keep mobile culling granularity. Narrow-view benchmarks found no batching benefit.
    batchStatic: tier === 'desktop',
    ...(bakedLighting ? { bakedLighting } : {}),
    vertexLighting,
    lightingFallback,
    worldMaterials,
    geometry:
      tier === 'mobile'
        ? 'Source geometry simplified once for mobile'
        : 'Source geometry optimized',
  });
  const { batching } = packed;
  console.log(
    `${tier}: ${(packed.manifest.bytes / 1024 ** 2).toFixed(1)} MB, ${(packed.manifest.textureBudget.decodedRGBABytes / 1024 ** 2).toFixed(1)} MiB decoded RGBA${batching ? `, static primitives ${batching.initialPrimitives} -> ${batching.finalPrimitives}` : ', mobile culling granularity preserved'}`,
  );
}
if (!v['only-tier'] || v['only-tier'] === 'compact') {
  globalThis.gc?.();
  const compact = await prepareCompactMap({
    input: join(root, 'mobile', 'scene.glb'),
    output: join(root, 'compact'),
    map: v.map,
  });
  if (compact)
    console.log(
      `compact: ${compact.bytes} bytes, ${compact.triangles} triangles in ${compact.primitives} batches`,
    );
}
console.log(
  'Prepared map. Install the resulting map directory into DATA_DIR/maps. Source exports may be removed after archiving.',
);
