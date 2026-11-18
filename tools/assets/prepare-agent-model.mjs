#!/usr/bin/env node
/** Prepare bounded native agents with an explicit static or native locomotion approximation. */
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { checkFreeReserve, exists, readableDirectory } from './asset-storage.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { inspectEquipmentGltf } from './equipment-model-input.mjs';
import { equipmentModelLimits as limits } from './equipment-model-registry.mjs';
import { applyTextureBudget } from './texture-budget.mjs';
import { compressGlbGeometry, MeshoptDecoder } from './meshopt-glb.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { poseAgentIdle } from './pose-agent-idle.mjs';
import { staticModelBounds } from './static-model-bounds.mjs';
import {
  agentAnimationRegistry,
  agentAnimationRoles,
  agentAnimationLimits,
} from './agent-animation-registry.mjs';
import { retargetAgentAnimations } from './retarget-agent-animations.mjs';
export const agentSourceRegistry = Object.freeze({
  ct: 'agents/models/ctm_sas/ctm_sas.vmdl_c',
  t: 'agents/models/tm_phoenix/tm_phoenix.vmdl_c',
});
export { agentIdleResource } from './equipment-dependencies.mjs';
import { agentIdleResource } from './equipment-dependencies.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function prepareAgentModel({
  input,
  idle,
  animations,
  output,
  team,
  assetVersion,
  sourceAssetVersion = assetVersion,
  animationAssetVersion = assetVersion,
}) {
  if (
    !Object.hasOwn(agentSourceRegistry, team) ||
    [assetVersion, sourceAssetVersion, animationAssetVersion].some(
      (version) => typeof version !== 'string' || !version.trim() || version.length > 100,
    )
  )
    throw Error('Provide fixed agent team ct/t and a bounded source version.');
  input = resolve(input);
  if (
    animations &&
    (Object.keys(animations).length !== agentAnimationRoles.length ||
      agentAnimationRoles.some((role) => typeof animations[role] !== 'string' || !animations[role]))
  )
    throw Error('Provide every fixed native locomotion role explicitly.');
  if (!animations && !idle) throw Error('Provide a native idle or all native locomotion clips.');
  if (idle) idle = resolve(idle);
  output = resolve(output);
  await readableDirectory(output);
  await localDirectory(output);
  const names = [`${team}.glb`, `${team}.manifest.json`, `${team}.provenance.json`];
  for (const name of names)
    if (await exists(join(output, name)))
      throw Error('Refusing to overwrite an installed agent or its metadata.');
  const source = await inspectEquipmentGltf(input),
    clipInputs = animations
      ? Object.fromEntries(agentAnimationRoles.map((role) => [role, resolve(animations[role])]))
      : { idle },
    clipSources = {};
  let sourceBytes = source.bytes;
  for (const [role, path] of Object.entries(clipInputs)) {
    const inspected = await inspectEquipmentGltf(path);
    if (animations && inspected.bytes > agentAnimationLimits.sourceBytes)
      throw Error('A native locomotion source exceeds8MiB.');
    clipSources[role] = inspected;
    sourceBytes += inspected.bytes;
  }
  if (sourceBytes > limits.sourceBytes)
    throw Error('Agent and native idle resources exceed512MiB.');
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .setAllowNetwork(false);
  const document = await io.read(input),
    clipDocuments = {};
  for (const [role, path] of Object.entries(clipInputs)) clipDocuments[role] = await io.read(path);
  const pose = animations
    ? retargetAgentAnimations(document, clipDocuments)
    : poseAgentIdle(document, clipDocuments.idle);
  for (const accessor of document.getRoot().listAccessors()) accessor.setSparse(false);
  await document.transform(dedup(), prune({ keepAttributes: true }));
  const bounds = pose.sampledBounds ?? staticModelBounds(document),
    geometryBytes = document
      .getRoot()
      .listAccessors()
      .reduce((sum, accessor) => sum + accessor.getArray().byteLength, 0);
  if (geometryBytes > limits.geometryBytes) throw Error('Agent decoded geometry exceeds 8 MiB.');
  const budget = await applyTextureBudget(document, {
    tier: 'mobile',
    budgetBytes: limits.decodedTextureBytes,
    maxEdge: limits.maxTextureEdge,
  });
  document
    .getRoot()
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
    ?.dispose();
  const compressed = await compressGlbGeometry(await io.writeBinary(document));
  if (compressed.bytes.length > limits.modelBytes) throw Error('Prepared agent exceeds 16 MiB.');
  const manifest = {
    schemaVersion: 1,
    team,
    assetVersion,
    coordinateSystem: 's2v-meters-y-up-viewer-rotates-positive-90y',
    pose: pose.pose,
    ...(animations ? { animations: pose.clips } : {}),
    sha256: hash(compressed.bytes),
    bytes: compressed.bytes.length,
    geometryBytes,
    decodedTextureBytes: budget.manifest.residentBaseRGBABytes,
    bounds,
  };
  const provenance = {
    ...manifest,
    sourceResource: agentSourceRegistry[team],
    sourceAssetVersion,
    animationAssetVersion,
    ...(animations
      ? { animationResources: agentAnimationRegistry }
      : { idleResource: agentIdleResource }),
    sourceFiles: source.resources,
    ...(animations
      ? {
          animationFiles: Object.fromEntries(
            Object.entries(clipSources).map(([role, record]) => [role, record.resources]),
          ),
        }
      : { idleFiles: clipSources.idle.resources }),
    posePreparation: pose,
    textureBudget: budget.plan,
    geometryCompression: compressed.report,
    limitations: animations
      ? pose.limitations
      : [
          'One generic rifle idle pose sampled at native frame zero, not recorded player bones',
          'No native locomotion, crouch, weapon-specific pose or animation playback',
        ],
    preparedAt: new Date().toISOString(),
  };
  const artifacts = [
    [names[0], compressed.bytes],
    [names[1], Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
    [names[2], Buffer.from(JSON.stringify(provenance, null, 2) + '\n')],
  ];
  if (
    artifacts[1][1].length > limits.metadataBytes ||
    artifacts[2][1].length > limits.provenanceBytes
  )
    throw Error('Agent provenance exceeds its bound.');
  const stage = await mkdtemp(join(output, '.agent-')),
    claimed = [];
  try {
    for (const [name, bytes] of artifacts) {
      await checkFreeReserve(stage, output, bytes.length);
      await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o644 });
    }
    const verified = await verifyPreparedGlb(join(stage, names[0]));
    if (verified.sha256 !== manifest.sha256)
      throw Error('Prepared agent failed embedded-GLB verification.');
    // Claim every filename exclusively before installing anything. The valid model
    // appears last, after its bounded metadata, so discovery never sees half a pack.
    for (const name of names) {
      await writeFile(join(output, name), '', { flag: 'wx', mode: 0o644 });
      claimed.push(join(output, name));
    }
    for (const name of [names[1], names[2], names[0]])
      await rename(join(stage, name), join(output, name));
    claimed.length = 0;
    return { path: join(output, names[0]), manifest, provenance };
  } catch (error) {
    for (const path of claimed) await rm(path, { force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      idle: { type: 'string' },
      walk: { type: 'string' },
      run: { type: 'string' },
      'crouch-idle': { type: 'string' },
      'crouch-walk': { type: 'string' },
      output: { type: 'string' },
      team: { type: 'string' },
      'asset-version': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (
    values.help ||
    !values.input ||
    !values.idle ||
    !values.output ||
    !values.team ||
    !values['asset-version']
  ) {
    console.log(
      'Usage: node prepare-agent-model.mjs --input NATIVE_AGENT.gltf --idle IDLE.gltf [--walk WALK.gltf --run RUN.gltf --crouch-idle CROUCH_IDLE.gltf --crouch-walk CROUCH_WALK.gltf] --team ct|t --output DATA_DIR/maps/agents --asset-version BUILD',
    );
    process.exit(values.help ? 0 : 1);
  }
  const animated = agentAnimationRoles.some((role) => role !== 'idle' && values[role]);
  const result = await prepareAgentModel({
    ...values,
    ...(animated
      ? { animations: Object.fromEntries(agentAnimationRoles.map((role) => [role, values[role]])) }
      : {}),
    assetVersion: values['asset-version'],
  });
  console.log(JSON.stringify({ path: result.path, manifest: result.manifest }));
}
