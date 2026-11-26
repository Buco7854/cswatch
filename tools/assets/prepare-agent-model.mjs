#!/usr/bin/env node
/** Prepare bounded native agents with the complete directional animation set. */
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
import { directionalAgentRegistry, agentAnimationLimits } from './agent-animation-registry.mjs';
import contract from '../../shared/agent-animation.json' with { type: 'json' };
import { directionalRoles, validDirectionalRoles } from '../../shared/agent-animation-contract.mjs';
import { retargetAgentAnimations } from './retarget-agent-animations.mjs';
import { officialAgentModels } from '../../shared/agent-models.mjs';
export const agentSourceRegistry = Object.freeze({
  ct: 'agents/models/ctm_sas/ctm_sas.vmdl_c',
  t: 'agents/models/tm_phoenix/tm_phoenix.vmdl_c',
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function prepareAgentModel({
  input,
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
    !validDirectionalRoles(Object.keys(animations ?? {})) ||
    directionalRoles.some((role) => typeof animations[role] !== 'string' || !animations[role])
  )
    throw Error('Provide a local export path for every animation role.');
  output = resolve(output);
  await readableDirectory(output);
  await localDirectory(output);
  const names = [`${team}.glb`, `${team}.manifest.json`, `${team}.provenance.json`];
  for (const name of names)
    if (await exists(join(output, name)))
      throw Error('Refusing to overwrite an installed agent or its metadata.');
  const source = await inspectEquipmentGltf(input),
    clipInputs = Object.fromEntries(
      directionalRoles.map((role) => [role, resolve(animations[role])]),
    ),
    clipSources = {};
  let sourceBytes = source.bytes;
  for (const [role, path] of Object.entries(clipInputs)) {
    const inspected = await inspectEquipmentGltf(path);
    if (inspected.bytes > agentAnimationLimits.sourceBytes)
      throw Error('A native clip source exceeds 8 MiB.');
    clipSources[role] = inspected;
    sourceBytes += inspected.bytes;
  }
  if (sourceBytes > limits.sourceBytes)
    throw Error('Agent source and clip resources exceed 512 MiB.');
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .setAllowNetwork(false);
  const document = await io.read(input),
    clipDocuments = {};
  for (const [role, path] of Object.entries(clipInputs)) clipDocuments[role] = await io.read(path);
  const pose = retargetAgentAnimations(document, clipDocuments);
  for (const accessor of document.getRoot().listAccessors()) accessor.setSparse(false);
  await document.transform(dedup(), prune({ keepAttributes: true }));
  const bounds = pose.sampledBounds,
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
    schemaVersion: contract.schemaVersion,
    team,
    assetVersion,
    coordinateSystem: 's2v-meters-y-up-viewer-rotates-positive-90y',
    pose: pose.pose,
    animationRoles: directionalRoles,
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
    animationResources: directionalAgentRegistry,
    sourceFiles: source.resources,
    animationFiles: Object.fromEntries(
      Object.entries(clipSources).map(([role, record]) => [role, record.resources]),
    ),
    posePreparation: pose,
    textureBudget: budget.plan,
    geometryCompression: compressed.report,
    limitations: pose.limitations,
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
  await installAgentArtifacts(output, artifacts, manifest.sha256);
  return { path: join(output, names[0]), manifest, provenance };
}

/** `artifacts`: [model, manifest, provenance] as [filename, bytes]. */
async function installAgentArtifacts(output, artifacts, sha256) {
  const names = artifacts.map(([name]) => name);
  const stage = await mkdtemp(join(output, '.agent-')),
    claimed = [];
  try {
    for (const [name, bytes] of artifacts) {
      await checkFreeReserve(stage, output, bytes.length);
      await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o644 });
    }
    const verified = await verifyPreparedGlb(join(stage, names[0]));
    if (verified.sha256 !== sha256) throw Error('Prepared agent failed embedded-GLB verification.');
    // Claim every filename exclusively before installing anything. The valid model
    // appears last, after its bounded metadata, so discovery never sees half a pack.
    for (const name of names) {
      await writeFile(join(output, name), '', { flag: 'wx', mode: 0o644 });
      claimed.push(join(output, name));
    }
    for (const name of [names[1], names[2], names[0]])
      await rename(join(stage, name), join(output, name));
    claimed.length = 0;
  } catch (error) {
    for (const path of claimed) await rm(path, { force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Bones the shared directional clips, action bank and weapon anchor drive. A recorded agent
 * without every one of them cannot share the team animation and keeps the team model. */
export const sharedAgentBones = Object.freeze([
  'root_motion',
  'pelvis',
  ...['spine_0', 'spine_1', 'spine_2', 'spine_3', 'neck_0', 'head_0'],
  ...['L', 'R'].flatMap((side) =>
    ['clavicle', 'arm_upper', 'arm_lower', 'hand', 'leg_upper', 'leg_lower', 'ankle', 'ball'].map(
      (bone) => `${bone}_${side}`,
    ),
  ),
  'wpnPivot',
]);

/** One recorded official agent: skin, skeleton and textures only. The viewer animates it with
 * its team model's clips and the shared action bank, which bind by bone name. */
export async function prepareRecordedAgentModel({ input, output, handle, assetVersion }) {
  const agent = officialAgentModels.get(handle);
  if (
    !agent ||
    typeof assetVersion !== 'string' ||
    !assetVersion.trim() ||
    assetVersion.length > 100
  )
    throw Error('Provide a catalogued agent model handle and a bounded source version.');
  input = resolve(input);
  output = resolve(output);
  await readableDirectory(output);
  await localDirectory(output);
  const names = ['model.glb', 'manifest.json', 'provenance.json'];
  for (const name of names)
    if (await exists(join(output, name)))
      throw Error('Refusing to overwrite an installed agent model or its metadata.');
  const source = await inspectEquipmentGltf(input);
  if (source.bytes > limits.sourceBytes) throw Error('Agent model source exceeds 512 MiB.');
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .setAllowNetwork(false);
  const document = await io.read(input);
  const root = document.getRoot();
  for (const animation of root.listAnimations()) animation.dispose();
  const joints = new Set(
    root
      .listSkins()
      .flatMap((skin) => skin.listJoints())
      .map((node) => node.getName()),
  );
  const missing = sharedAgentBones.filter((bone) => !joints.has(bone));
  if (!root.listSkins().length || missing.length)
    throw Error(`Agent model lacks the shared skeleton: ${missing.slice(0, 4).join(', ')}.`);
  for (const accessor of root.listAccessors()) accessor.setSparse(false);
  await document.transform(dedup(), prune({ keepAttributes: true }));
  const geometryBytes = root
    .listAccessors()
    .reduce((sum, accessor) => sum + accessor.getArray().byteLength, 0);
  if (geometryBytes > limits.geometryBytes) throw Error('Agent decoded geometry exceeds 8 MiB.');
  const budget = await applyTextureBudget(document, {
    tier: 'mobile',
    budgetBytes: limits.decodedTextureBytes,
    maxEdge: limits.maxTextureEdge,
  });
  root
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
    ?.dispose();
  const compressed = await compressGlbGeometry(await io.writeBinary(document));
  if (compressed.bytes.length > limits.modelBytes) throw Error('Prepared agent exceeds 16 MiB.');
  const manifest = {
    schemaVersion: 2,
    id: handle,
    team: agent.team,
    entry: agent.entry,
    assetVersion,
    coordinateSystem: 's2v-meters-y-up-viewer-rotates-positive-90y',
    pose: 'shared-team-clips',
    sha256: hash(compressed.bytes),
    bytes: compressed.bytes.length,
    geometryBytes,
    decodedTextureBytes: budget.manifest.residentBaseRGBABytes,
  };
  const provenance = {
    ...manifest,
    sourceResource: agent.resource,
    handleSource: `characters/models/${agent.entry}.vmdl`,
    sourceFiles: source.resources,
    sharedBones: sharedAgentBones,
    textureBudget: budget.plan,
    geometryCompression: compressed.report,
    limitations: ['Animated by its team model clips and the shared action bank'],
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
  await installAgentArtifacts(output, artifacts, manifest.sha256);
  return { path: join(output, names[0]), manifest, provenance };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      ...Object.fromEntries(directionalRoles.map((role) => [role, { type: 'string' }])),
      output: { type: 'string' },
      team: { type: 'string' },
      'agent-model': { type: 'string' },
      'asset-version': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values['agent-model'] && !values.help) {
    const result = await prepareRecordedAgentModel({
      input: values.input,
      output: values.output,
      handle: values['agent-model'],
      assetVersion: values['asset-version'],
    });
    console.log(JSON.stringify({ path: result.path, manifest: result.manifest }));
    process.exit(0);
  }
  if (values.help || !values.input || !values.output || !values.team || !values['asset-version']) {
    console.log(
      'Usage: node prepare-agent-model.mjs --input NATIVE_AGENT.gltf --team ct|t --output DATA_DIR/maps/agents --asset-version BUILD [all role flags, e.g. --rifle-walk-w WALK_LEFT.gltf]\n       node prepare-agent-model.mjs --input NATIVE_AGENT.gltf --agent-model HANDLE --output DATA_DIR/maps/agent-models/HANDLE --asset-version BUILD',
    );
    process.exit(values.help ? 0 : 1);
  }
  const result = await prepareAgentModel({
    input: values.input,
    output: values.output,
    team: values.team,
    animations: Object.fromEntries(directionalRoles.map((role) => [role, values[role]])),
    assetVersion: values['asset-version'],
  });
  console.log(JSON.stringify({ path: result.path, manifest: result.manifest }));
}
