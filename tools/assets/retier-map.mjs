#!/usr/bin/env node
/** Offline texture retiering of a verified prepared GLB, without geometry transforms. */
import { parseArgs } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { MapBakedLightingExtension } from './map-baked-lighting-extension.mjs';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';
import { writeMapTier } from './map-tier-output.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';

export async function retierPreparedMap({
  input,
  output,
  map,
  tier,
  assetVersion,
  sourceManifestPath,
  budgetBytes,
}) {
  input = resolve(input);
  output = resolve(output);
  if (input === join(output, 'scene.glb') || dirname(input) === output)
    throw new Error('Retiering requires a new output tier directory.');
  await localDirectory(dirname(input));
  const manifestPath = sourceManifestPath
    ? resolve(sourceManifestPath)
    : join(dirname(input), 'manifest.json');
  await localDirectory(dirname(manifestPath));
  const { handle } = await regularFile(manifestPath, 32768);
  let previous;
  try {
    previous = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (
    previous.schemaVersion !== 1 ||
    previous.map !== map ||
    previous.tier !== tier ||
    typeof previous.assetVersion !== 'string'
  )
    throw new Error('Prepared input manifest does not match the requested map and tier.');
  const { document: metadata } = await readAtmosphereGlb(input);
  if (
    (metadata.buffers ?? []).some((buffer) => buffer.uri !== undefined) ||
    (metadata.images ?? []).some((image) => image.uri !== undefined)
  )
    throw new Error('Retiering requires a self-contained prepared GLB.');
  const source = await verifyPreparedGlb(input);
  if (
    previous.bytes !== source.bytes ||
    (previous.outputSha256 !== undefined && previous.outputSha256 !== source.sha256)
  )
    throw new Error('Prepared input GLB does not match its source manifest.');
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, MapBakedLightingExtension])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .setAllowNetwork(false);
  const document = await io.read(input);
  return writeMapTier({
    document,
    io,
    target: output,
    map,
    tier,
    assetVersion: assetVersion ?? previous.assetVersion,
    source: { file: basename(input), sha256: source.sha256, bytes: source.bytes },
    s2v: previous.s2v || 'prepared-glb-retier',
    geometry: 'preserved from verified prepared tier',
    budgetBytes,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      map: { type: 'string' },
      tier: { type: 'string' },
      'asset-version': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.input || !values.output || !values.map || !values.tier) {
    console.log(
      'Usage: node retier-map.mjs --input /prepared/map/tier/scene.glb --output /NEW/map/tier --map de_mirage --tier desktop|mobile [--asset-version VERSION]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const result = await retierPreparedMap({ ...values, assetVersion: values['asset-version'] });
  console.log(
    JSON.stringify({
      path: result.path,
      bytes: result.manifest.bytes,
      textureBudget: result.manifest.textureBudget,
    }),
  );
}
