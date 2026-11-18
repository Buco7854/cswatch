#!/usr/bin/env node
/** Geometry transport only. Existing compressed texture bytes and budget plan stay unchanged. */
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { compressGlbGeometry } from './meshopt-glb.mjs';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import { validateTexturePlan } from './texture-plan-validation.mjs';
import { writePreparedModel } from './prepared-model-output.mjs';
import { writeTierMetadata } from './map-tier-output.mjs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { batchMapMeshes } from './batch-map-meshes.mjs';

async function bounded(path, limit) {
  await localDirectory(dirname(path));
  const { handle } = await regularFile(path, limit);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function compressPreparedGeometry({ input, output, map, tier, batchStatic = false }) {
  input = resolve(input);
  output = resolve(output);
  if (
    output === dirname(input) ||
    !['desktop', 'mobile'].includes(tier) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(map)
  )
    throw new Error('Geometry compression requires a valid identity and new tier directory.');
  const previous = JSON.parse(await bounded(join(dirname(input), 'manifest.json'), 16384));
  if (previous.schemaVersion !== 1 || previous.map !== map || previous.tier !== tier)
    throw new Error('Source tier manifest identity mismatch.');
  const source = await verifyPreparedGlb(input);
  if (
    previous.bytes !== source.bytes ||
    (previous.outputSha256 !== undefined && previous.outputSha256 !== source.sha256)
  )
    throw new Error('Source prepared model differs from its manifest.');
  const plan =
    previous.textureBudget === undefined
      ? null
      : await bounded(join(dirname(input), 'texture-plan.json'), 4 * 1024 ** 2);
  if (plan) validateTexturePlan(previous, plan, tier);
  await localDirectory(dirname(output), true);
  await mkdir(output, { mode: 0o755 });
  try {
    const bytes = await bounded(input, 2 * 1024 ** 3),
      metadata = await readAtmosphereGlb(input);
    let batching,
      preparedBytes = bytes;
    if (batchStatic) {
      await MeshoptDecoder.ready;
      const io = new NodeIO()
          .registerExtensions(ALL_EXTENSIONS)
          .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
          .setAllowNetwork(false),
        document = await io.readBinary(bytes);
      batching = await batchMapMeshes(document, { cellSize: tier === 'mobile' ? 16 : 64 });
      document
        .getRoot()
        .listExtensionsUsed()
        .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
        ?.dispose();
      preparedBytes = await io.writeBinary(document);
    }
    const compressed =
      !batchStatic && metadata.document.extensionsRequired?.includes('EXT_meshopt_compression')
        ? { bytes, report: { ...previous.geometryCompression, reusedExisting: true } }
        : await compressGlbGeometry(preparedBytes);
    const size = await writePreparedModel(join(output, 'scene.glb'), compressed.bytes);
    const manifest = {
      ...previous,
      bytes: size,
      outputSha256: createHash('sha256').update(compressed.bytes).digest('hex'),
      sourceFile: basename(input),
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
      geometryCompression: compressed.report,
      ...(batching
        ? {
            staticBatching: batching,
            geometry: `Opaque static sibling geometry batched in ${batching.cellSize}m cells; source hierarchy and materials retained`,
          }
        : {}),
      preparedAt: new Date().toISOString(),
    };
    const serialized = Buffer.from(JSON.stringify(manifest, null, 2));
    if (serialized.length > 16384) throw new Error('Compressed tier manifest exceeds 16 KiB.');
    if (plan) await writeTierMetadata(join(output, 'texture-plan.json'), plan);
    await writeTierMetadata(join(output, 'manifest.json'), serialized);
    await verifyPreparedGlb(join(output, 'scene.glb'));
    return { path: join(output, 'scene.glb'), manifest };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      map: { type: 'string' },
      tier: { type: 'string' },
      help: { type: 'boolean' },
      'batch-static': { type: 'boolean' },
    },
  });
  if (values.help || !values.input || !values.output || !values.map || !values.tier) {
    console.log(
      'Usage: node compress-prepared-map.mjs --input /OLD/map/tier/scene.glb --output /NEW/map/tier --map de_dust2 --tier desktop|mobile [--batch-static]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const result = await compressPreparedGeometry({ ...values, batchStatic: values['batch-static'] });
  console.log(
    JSON.stringify({
      path: result.path,
      bytes: result.manifest.bytes,
      geometryCompression: result.manifest.geometryCompression,
      ...(result.manifest.staticBatching ? { staticBatching: result.manifest.staticBatching } : {}),
      textureBudget: result.manifest.textureBudget,
    }),
  );
}
