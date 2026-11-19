#!/usr/bin/env node
/** Trusted offline S2V static equipment packing, with no network or native export. */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { localDirectory } from './toolchain-security.mjs';
import { checkFreeReserve, readableDirectory } from './asset-storage.mjs';
import { applyTextureBudget } from './texture-budget.mjs';
import { compressGlbGeometry, MeshoptDecoder } from './meshopt-glb.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import {
  equipmentModelRegistry,
  equipmentModelLimits as limits,
  equipmentAttachmentPreset,
} from './equipment-model-registry.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
import { inspectEquipmentGltf } from './equipment-model-input.mjs';
export {
  inspectEquipmentGltf,
  validateEquipmentGeometryMetadata,
} from './equipment-model-input.mjs';
import { staticModelBounds } from './static-model-bounds.mjs';
const sourceCommit = '942df5b37ebbde6153f6c488880b91d4bed003e6';

function geometryBytes(document) {
  const arrays = new Set();
  let bytes = 0;
  for (const accessor of document.getRoot().listAccessors()) {
    const array = accessor.getArray();
    if (!array) throw Error('Equipment accessor has no decoded data.');
    if (!arrays.has(array)) {
      arrays.add(array);
      bytes += array.byteLength;
    }
  }
  if (bytes > limits.geometryBytes) throw Error('Decoded equipment geometry exceeds 8 MiB.');
  return bytes;
}
export async function prepareEquipmentModel({
  input,
  output,
  id,
  assetVersion,
  source = {},
  confined = false,
}) {
  if (
    !Object.hasOwn(equipmentModelRegistry, id) ||
    typeof assetVersion !== 'string' ||
    !assetVersion.trim() ||
    assetVersion.length > 100
  )
    throw Error('Invalid fixed equipment identity/version.');
  input = resolve(input);
  output = resolve(output);
  await readableDirectory(output);
  await localDirectory(output);
  const inspection = await inspectEquipmentGltf(input);
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .setAllowNetwork(false);
  const document = await io.read(input);
  for (const accessor of document.getRoot().listAccessors()) accessor.setSparse(false);
  for (const animation of document.getRoot().listAnimations()) animation.dispose();
  for (const scene of document.getRoot().listScenes()) {
    const root = document
      .createNode('cswatch_equipment_source_axes')
      .setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    for (const child of scene.listChildren()) root.addChild(child);
    scene.addChild(root);
  }
  await document.transform(dedup(), prune());
  const decodedGeometry = geometryBytes(document),
    bounds = staticModelBounds(document);
  const textureBudget = await applyTextureBudget(document, {
    tier: 'mobile',
    budgetBytes: limits.decodedTextureBytes,
    maxEdge: limits.maxTextureEdge,
  });
  document
    .getRoot()
    .listExtensionsUsed()
    .find((e) => e.extensionName === 'EXT_meshopt_compression')
    ?.dispose();
  const compressed = await compressGlbGeometry(await io.writeBinary(document));
  if (compressed.bytes.length > limits.modelBytes)
    throw Error('Encoded equipment model exceeds 16 MiB.');
  const manifest = {
    schemaVersion: 1,
    id,
    coordinateSystem: 'viewer-meters-y-up-x-forward',
    assetVersion,
    sha256: hash(compressed.bytes),
    bytes: compressed.bytes.length,
    decodedTextureBytes: textureBudget.manifest.residentBaseRGBABytes,
    geometryBytes: decodedGeometry,
    bounds,
    attachments: equipmentAttachmentPreset(id, bounds),
  };
  const provenance = {
    schemaVersion: 1,
    id,
    assetVersion,
    sourceResource: equipmentModelRegistry[id].resource,
    source,
    sourceFiles: inspection.resources,
    sourceSha256: inspection.sourceSha256,
    sourceBytes: inspection.bytes,
    s2vSourceCommit: sourceCommit,
    conversion:
      'S2V has baked Source inches into glTF meters/Y-up; one +90 degree Y root correction produces viewer (X,Z,-Y). No additional scale.',
    geometryCompression: compressed.report,
    textureBudget: textureBudget.plan,
    limitations: [
      'Static native bind-pose model only',
      'Approximate equipment attachment presets; no native hand/arm, recoil or fire pose',
      'No native weapon animation graph, skins or body-group switching',
    ],
    preparedAt: new Date().toISOString(),
  };
  const metadata = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    proof = Buffer.from(JSON.stringify(provenance, null, 2) + '\n');
  if (metadata.length > limits.metadataBytes || proof.length > limits.provenanceBytes)
    throw Error('Equipment preparation metadata exceeds its bound.');
  const stage = await mkdtemp(join(output, '.equipment-')),
    target = join(output, id);
  let claimed = false;
  try {
    for (const [name, bytes] of [
      ['model.glb', compressed.bytes],
      ['manifest.json', metadata],
      ['provenance.json', proof],
    ]) {
      await checkFreeReserve(stage, output, bytes.length);
      await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o644 });
    }
    const verified = await verifyPreparedGlb(join(stage, 'model.glb'));
    if (verified.sha256 !== manifest.sha256 || verified.bytes !== manifest.bytes)
      throw Error('Prepared equipment verification failed.');
    if (!confined) await chmod(stage, 0o755);
    await mkdir(target, { mode: 0o700 });
    claimed = true;
    await rename(stage, target);
    claimed = false;
    return { path: join(target, 'model.glb'), directory: target, manifest, provenance };
  } catch (error) {
    if (claimed) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      id: { type: 'string' },
      'asset-version': { type: 'string' },
      'native-sha256': { type: 'string' },
      'native-bytes': { type: 'string' },
      'native-meshes': { type: 'string' },
      manifest: { type: 'string' },
      confined: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.input || !values.output || !values.id || !values['asset-version']) {
    console.log(
      'Usage: node prepare-equipment-model.mjs --input S2V_MODEL.gltf --output DATA_DIR/maps/equipment-models --id ak47 --asset-version BUILD',
    );
    process.exit(values.help ? 0 : 1);
  }
  const nativeFields = ['native-sha256', 'native-bytes', 'native-meshes', 'manifest'];
  const hasNative = nativeFields.some((key) => values[key] !== undefined);
  if (
    hasNative &&
    (!/^[0-9a-f]{64}$/.test(values['native-sha256'] ?? '') ||
      !Number.isSafeInteger(Number(values['native-bytes'])) ||
      Number(values['native-bytes']) < 1 ||
      Number(values['native-bytes']) > limits.sourceFileBytes ||
      !/^[a-zA-Z0-9_-]{1,100}(?:,[a-zA-Z0-9_-]{1,100}){0,127}$/.test(
        values['native-meshes'] ?? '',
      ) ||
      !/^[1-9]\d{0,19}$/.test(values.manifest ?? ''))
  )
    throw Error('Native source provenance is incomplete or invalid.');
  const result = await prepareEquipmentModel({
    ...values,
    assetVersion: values['asset-version'],
    source: hasNative
      ? {
          depot: '2347770',
          manifest: values.manifest,
          sha256: values['native-sha256'],
          bytes: Number(values['native-bytes']),
          meshes: values['native-meshes'].split(','),
        }
      : {},
  });
  console.log(JSON.stringify({ path: result.path, manifest: result.manifest }));
}
