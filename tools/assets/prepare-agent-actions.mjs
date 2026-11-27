#!/usr/bin/env node
/** Prepare the shared native action bank: per-weapon carry and actions, airborne, ladder,
 * flinch and death clips retargeted by exact bone name onto the agent skeleton. The bank
 * carries no mesh, skin or texture, so one download drives every agent model. */
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { checkFreeReserve, exists, readableDirectory } from './asset-storage.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { inspectEquipmentGltf } from './equipment-model-input.mjs';
import { compressGlbGeometry, MeshoptDecoder } from './meshopt-glb.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { createAgentRetarget, inverseRigid, multiply } from './agent-retarget.mjs';
import {
  snapshot,
  restore,
  width,
  assign,
  sample,
  nativeChannels,
} from './native-animation-samples.mjs';
import { agentActionRegistry } from './agent-action-registry.mjs';
import { parseKv3Text, convertRagdoll } from './agent-ragdoll.mjs';
import { readFile } from 'node:fs/promises';
import {
  agentActionRoles,
  agentActionKind,
  agentActionContract as contract,
} from '../../shared/agent-actions.mjs';

export const agentActionLimits = Object.freeze({
  seconds: contract.limits.seconds,
  samples: 2048,
  totalSamples: 32768,
  jointSamples: 3_000_000,
  channels: contract.limits.maxChannels,
  // One sampler per animated bone of every role: 13,800 for the 222 roles prepared from
  // the 2026-11 official build, so the bank keeps its own bound above the per-model one.
  accessors: contract.limits.maxAccessors,
  sourceBytes: 8 * 1024 ** 2,
  totalSourceBytes: 256 * 1024 ** 2,
  outputBytes: 12 * 1024 ** 2,
  modelBytes: 16 * 1024 ** 2,
  metadataBytes: 64 * 1024,
  provenanceBytes: 512 * 1024,
});
const limits = agentActionLimits;
/** Joints whose authored translation is motion rather than bone length. */
export const travellingJoints = new Set(['root_motion', 'pelvis', 'wpnPivot', 'wpn']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Inverse of a column-major affine bind matrix. */
function invertBind(m) {
  const [a, b, c, d, e, f, g, h, k] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw Error('Singular skeleton bind pose.');
  const r = [
    (e * k - f * h) / det,
    (c * h - b * k) / det,
    (b * f - c * e) / det,
    (f * g - d * k) / det,
    (a * k - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const out = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
  for (let row = 0; row < 3; row++)
    out[12 + row] = -(out[row] * m[12] + out[4 + row] * m[13] + out[8 + row] * m[14]);
  return out;
}

/** Joints that an `upper` role owns: the torso chain from spine_0 and the weapon pivot. */
function upperJoints(joints) {
  const owned = new Set();
  const visit = (node) => {
    owned.add(node);
    for (const child of node.listChildren()) visit(child);
  };
  for (const joint of joints) if (['spine_0', 'wpnPivot'].includes(joint.getName())) visit(joint);
  // The pelvis is the reference that relates the hands to the weapon pivot; the
  // runtime reads it for grip offsets and never layers it over locomotion.
  for (const joint of joints) if (joint.getName() === 'pelvis') owned.add(joint);
  return owned;
}

export function retargetAgentActions(target, clips, { minimumMappedBones = 20 } = {}) {
  if (
    Object.keys(clips ?? {}).length !== agentActionRoles.length ||
    agentActionRoles.some((role) => !clips[role])
  )
    throw Error('Provide the complete native action set.');
  const root = target.getRoot(),
    targetJoints = [...new Set(root.listSkins().flatMap((skin) => skin.listJoints()))],
    targetBind = snapshot(targetJoints),
    upper = upperJoints(targetJoints),
    buffer = root.listBuffers()[0] ?? target.createBuffer();
  if (![...upper].some((joint) => joint.getName() === 'wpnPivot'))
    throw Error('The agent skeleton has no authored weapon pivot.');
  let totalSamples = 0,
    jointSamples = 0,
    decodedBytes = 0;
  const reports = [];
  for (const animation of root.listAnimations()) animation.dispose();
  try {
    for (const role of agentActionRoles) {
      restore(targetBind);
      const blend = agentActionKind(role),
        clip = clips[role],
        mapping = createAgentRetarget(target, clip, { minimumMappedBones }),
        sourceNodes = new Set(mapping.source.values()),
        sourceBind = snapshot([...sourceNodes]),
        // Weapon actions also export the weapon's own skin. Only the agent side is kept.
        ignored = clip
          .getRoot()
          .listSkins()
          .flatMap((skin) => skin.listJoints())
          .filter((node) => !sourceNodes.has(node)),
        { animation, channels, timeline } = nativeChannels(
          clip,
          sourceNodes,
          limits,
          new Set(ignored),
        ),
        motionRoot = mapping.source.get('root_motion');
      if (!motionRoot || sourceNodes.has(motionRoot.getParentNode()))
        throw Error('Native animation requires its exact authored root_motion skeleton root.');
      totalSamples += timeline.length;
      jointSamples += timeline.length * sourceNodes.size;
      if (totalSamples > limits.totalSamples || jointSamples > limits.jointSamples)
        throw Error('Native action allocation exceeds its bound.');
      const kept = mapping.mappedJoints.filter((node) => blend !== 'upper' || upper.has(node));
      const values = new Map(
        kept.map((node) => [
          node,
          {
            // Bone lengths stay the agent's own: only motion-carrying joints keep translation.
            ...(travellingJoints.has(node.getName())
              ? { translation: new Float32Array(timeline.length * 3) }
              : {}),
            rotation: new Float32Array(timeline.length * 4),
          },
        ]),
      );
      // Deaths keep their authored travel; recorded positions own every other root.
      const keepTravel = role.startsWith('death:');
      let anchor, firstRoot, lastRoot;
      // Ladder clips climb in place: each cycle's climb is the feet's authored vertical sweep.
      const feet = role.startsWith('ladder')
        ? ['ball_L', 'ball_R'].map((name) => ({
            node: mapping.mappedJoints.find((joint) => joint.getName() === name),
            low: Infinity,
            high: -Infinity,
          }))
        : [];
      for (let index = 0; index < timeline.length; index++) {
        restore(sourceBind);
        restore(targetBind);
        for (const channel of channels)
          assign(channel.node, channel.path, sample(channel, timeline[index]));
        const currentRoot = motionRoot.getWorldMatrix();
        anchor ??= currentRoot;
        mapping.apply(keepTravel ? null : multiply(anchor, inverseRigid(currentRoot)));
        for (const foot of feet) {
          const height = foot.node?.getWorldMatrix()[13] ?? NaN;
          foot.low = Math.min(foot.low, height);
          foot.high = Math.max(foot.high, height);
        }
        if (index === 0) firstRoot = currentRoot.slice(12, 15);
        lastRoot = currentRoot.slice(12, 15);
        for (const [node, paths] of values) {
          paths.translation?.set(node.getTranslation(), index * 3);
          paths.rotation.set(node.getRotation(), index * 4);
        }
      }
      restore(sourceBind);
      const input = target
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Float32Array(timeline))
        .setBuffer(buffer);
      const staticInput = target
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Float32Array([0]))
        .setBuffer(buffer);
      const output = target.createAnimation(`cswatch:${role}`).setExtras({
        cswatch: {
          kind: 'native-agent-action',
          schemaVersion: contract.schemaVersion,
          role,
          blend,
          rootMotion: keepTravel ? 'clip' : 'recorded-position',
          // Authored root displacement over the clip (metres, S2V axes), e.g. a ladder cycle's climb.
          travel: lastRoot.map((value, axis) => Math.round((value - firstRoot[axis]) * 1e4) / 1e4),
          ...(feet.length
            ? {
                climbMeters:
                  Math.round(feet.reduce((sum, foot) => sum + foot.high - foot.low, 0) * 1e4) / 1e4,
              }
            : {}),
        },
      });
      decodedBytes += 8 + timeline.length * 4;
      let hasTimeline = false;
      for (const [node, paths] of values)
        for (const [path, array] of Object.entries(paths)) {
          const size = width[path];
          const precision = path === 'rotation' ? 16384 : 8192;
          for (let i = 0; i < array.length; i++)
            array[i] = Math.round(array[i] * precision) / precision;
          const constant = hasTimeline && array.every((value, i) => value === array[i % size]);
          hasTimeline ||= !constant;
          const keys = constant ? array.slice(0, size) : array;
          if ((decodedBytes += keys.byteLength) > limits.outputBytes)
            throw Error('Native action allocation exceeds its bound.');
          const sampler = target
            .createAnimationSampler()
            .setInterpolation('LINEAR')
            .setInput(constant ? staticInput : input)
            .setOutput(
              target
                .createAccessor()
                .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
                .setArray(keys)
                .setBuffer(buffer),
            );
          output
            .addSampler(sampler)
            .addChannel(
              target
                .createAnimationChannel()
                .setTargetNode(node)
                .setTargetPath(path)
                .setSampler(sampler),
            );
        }
      reports.push({
        role,
        blend,
        clip: animation.getName(),
        duration: timeline.at(-1),
        samples: timeline.length,
        channels: [...values.values()].reduce((sum, paths) => sum + Object.keys(paths).length, 0),
        travel: lastRoot.map((value, axis) => value - firstRoot[axis]),
        mappedBones: mapping.overlap,
      });
    }
  } finally {
    restore(targetBind);
  }
  return { schemaVersion: contract.schemaVersion, clips: reports, totalSamples, decodedBytes };
}

/** Keep only the skeleton hierarchy and the action curves. */
function skeletonOnly(document) {
  const root = document.getRoot();
  for (const node of root.listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }
  for (const list of [
    root.listSkins(),
    root.listMeshes(),
    root.listMaterials(),
    root.listTextures(),
  ])
    for (const item of list) item.dispose();
}

export async function prepareAgentActions({ skeleton, clips, output, assetVersion, ragdoll }) {
  if (typeof assetVersion !== 'string' || !assetVersion.trim() || assetVersion.length > 100)
    throw Error('Provide a bounded source version.');
  output = resolve(output);
  await readableDirectory(output);
  await localDirectory(output);
  const names = ['actions.glb', 'actions.manifest.json', 'actions.provenance.json'];
  for (const name of names)
    if (await exists(join(output, name)))
      throw Error('Refusing to overwrite an installed action bank or its metadata.');
  if (
    Object.keys(clips ?? {}).length !== agentActionRoles.length ||
    agentActionRoles.some((role) => typeof clips[role] !== 'string')
  )
    throw Error('Provide a local export path for every action role.');
  const sources = {};
  let sourceBytes = 0;
  for (const role of agentActionRoles) {
    const inspected = await inspectEquipmentGltf(resolve(clips[role]));
    if (inspected.bytes > limits.sourceBytes) throw Error('A native clip source exceeds 8 MiB.');
    sources[role] = inspected;
    sourceBytes += inspected.bytes;
  }
  if (sourceBytes > limits.totalSourceBytes) throw Error('Native action sources exceed 256 MiB.');
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .setAllowNetwork(false);
  const document = await io.read(resolve(skeleton));
  const documents = {};
  for (const role of agentActionRoles) documents[role] = await io.read(resolve(clips[role]));
  // The agent's own ragdoll, in the skeleton's bone space, read before the skin is dropped.
  let ragdollData;
  if (ragdoll) {
    const text = await readFile(resolve(ragdoll), 'utf8');
    const skin = document.getRoot().listSkins()[0];
    const inverse = skin?.getInverseBindMatrices();
    if (!skin || !inverse) throw Error('The agent skeleton has no bind pose.');
    const bind = new Map(
      skin.listJoints().map((joint, i) => [joint.getName(), invertBind(inverse.getElement(i, []))]),
    );
    ragdollData = convertRagdoll(parseKv3Text(text), bind);
  }
  const report = retargetAgentActions(document, documents);
  skeletonOnly(document);
  if (ragdollData)
    document
      .getRoot()
      .setExtras({ cswatch: { kind: 'native-agent-ragdoll', ragdoll: ragdollData } });
  await document.transform(prune());
  for (const accessor of document.getRoot().listAccessors()) accessor.setSparse(false);
  document
    .getRoot()
    .listExtensionsUsed()
    .filter((extension) => extension.extensionName !== 'EXT_meshopt_compression')
    .forEach((extension) => extension.dispose());
  document
    .getRoot()
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
    ?.dispose();
  const compressed = await compressGlbGeometry(await io.writeBinary(document));
  if (compressed.bytes.length > limits.modelBytes)
    throw Error('Prepared action bank exceeds 16 MiB.');
  const manifest = {
    schemaVersion: contract.schemaVersion,
    assetVersion,
    coordinateSystem: 's2v-meters-y-up-viewer-rotates-positive-90y',
    roles: agentActionRoles,
    sha256: hash(compressed.bytes),
    bytes: compressed.bytes.length,
    decodedBytes: report.decodedBytes,
  };
  const provenance = {
    ...manifest,
    actionResources: agentActionRegistry,
    sourceFiles: Object.fromEntries(
      Object.entries(sources).map(([role, record]) => [role, record.resources]),
    ),
    preparation: report,
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
    throw Error('Action bank metadata exceeds its bound.');
  const stage = await mkdtemp(join(output, '.actions-')),
    claimed = [];
  try {
    for (const [name, bytes] of artifacts) {
      await checkFreeReserve(stage, output, bytes.length);
      await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o644 });
    }
    const verified = await verifyPreparedGlb(join(stage, names[0]), { animationOnly: true });
    // The same structural check the worker applies before publishing the bank.
    await inspectEquipmentGltf(join(stage, names[0]), { maxAccessors: limits.accessors });
    if (verified.sha256 !== manifest.sha256)
      throw Error('Prepared action bank failed embedded-GLB verification.');
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
      skeleton: { type: 'string' },
      clips: { type: 'string' },
      output: { type: 'string' },
      'asset-version': { type: 'string' },
      ragdoll: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (
    values.help ||
    !values.skeleton ||
    !values.clips ||
    !values.output ||
    !values['asset-version']
  ) {
    console.log(
      'Usage: node prepare-agent-actions.mjs --skeleton NATIVE_AGENT.gltf --clips DIR --output DATA_DIR/maps/agents --asset-version BUILD [--ragdoll PHYS.kv3]\n' +
        'DIR holds one S2V export per role, named after the role with ":" replaced by "_" (e.g. weapon_ak47_idle.gltf).',
    );
    process.exit(values.help ? 0 : 1);
  }
  const clips = Object.fromEntries(
    agentActionRoles.map((role) => [role, join(values.clips, role.replaceAll(':', '_') + '.gltf')]),
  );
  const result = await prepareAgentActions({
    skeleton: values.skeleton,
    clips,
    output: values.output,
    assetVersion: values['asset-version'],
    ragdoll: values.ragdoll,
  });
  console.log(JSON.stringify({ path: result.path, manifest: result.manifest }));
}
