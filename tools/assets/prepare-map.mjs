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
import { fileHash } from './toolchain-security.mjs';
import { writeMapTier } from './map-tier-output.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { batchMapMeshes } from './batch-map-meshes.mjs';
import { MapBakedLightingExtension } from './map-baked-lighting-extension.mjs';
import { bindBakedLighting, prepareBakedLightingAtlas } from './prepare-baked-lighting.mjs';
import { readMapLayerImages } from './prepare-map-layers.mjs';
import { prepareCompactMap } from './prepare-compact-map.mjs';
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
    'lighting-direction-png': { type: 'string' },
    'layer-images': { type: 'string' },
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
for (const tier of ['desktop', 'mobile']) {
  const target = join(root, tier);
  const document = await io.read(input);
  let bakedLighting;
  if (v['irradiance-exr'] && v['sun-shadow-png']) {
    const atlas = await prepareBakedLightingAtlas({
      irradiance: resolve(v['irradiance-exr']),
      shadow: resolve(v['sun-shadow-png']),
      direction: v['lighting-direction-png'] ? resolve(v['lighting-direction-png']) : undefined,
      edge: tier === 'mobile' ? 1024 : 2048,
    });
    bakedLighting = bindBakedLighting(document, atlas, layers);
  }
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
  // Narrow-view software measurements did not establish a mobile frame-time benefit.
  // Keep its existing culling granularity; explicit offline experiments remain separate.
  const batching = tier === 'desktop' ? await batchMapMeshes(document, { cellSize: 64 }) : null;
  const packed = await writeMapTier({
    document,
    io,
    target,
    map: v.map,
    tier,
    assetVersion: v['asset-version'] || 'unspecified',
    source: { file: basename(input), sha256: source.sha256, bytes: source.bytes },
    s2v: toolVersion,
    ...(bakedLighting ? { bakedLighting } : {}),
    geometry:
      tier === 'mobile'
        ? 'Source geometry simplified once for mobile'
        : 'Source geometry optimized',
  });
  console.log(
    `${tier}: ${(packed.manifest.bytes / 1024 ** 2).toFixed(1)} MB, ${(packed.manifest.textureBudget.decodedRGBABytes / 1024 ** 2).toFixed(1)} MiB decoded RGBA${batching ? `, static primitives ${batching.initialPrimitives} -> ${batching.finalPrimitives}` : ', mobile culling granularity preserved'}`,
  );
}
const compact = await prepareCompactMap({
  input: join(root, 'mobile', 'scene.glb'),
  output: join(root, 'compact'),
  map: v.map,
});
if (compact)
  console.log(
    `compact: ${compact.bytes} bytes, ${compact.triangles} triangles in ${compact.primitives} batches`,
  );
console.log(
  'Prepared map. Install the resulting map directory into DATA_DIR/maps. Source exports may be removed after archiving.',
);
