#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { inspectEquipmentGltf } from './equipment-model-input.mjs';
import { checkFreeReserve } from './asset-storage.mjs';
import { createAgentRetarget, inverseRigid, multiply } from './agent-retarget.mjs';
import {
  assign,
  nativeChannels,
  restore,
  sample,
  snapshot,
  width,
} from './native-animation-samples.mjs';
import { poseAgentIdle } from './pose-agent-idle.mjs';
import { applyTextureBudget } from './texture-budget.mjs';
import { compressGlbGeometry } from './meshopt-glb.mjs';
import { viewmodelSources } from './inspect-viewmodel-source.mjs';

const limits = { seconds: 4, samples: 180, channels: 384 };
const roles = ['arms', 'weapon', 'idle', 'fire', 'reload'];

function only(items, name) {
  if (items.length !== 1) throw Error('Expected exactly one ' + name);
  return items[0];
}
function joint(document, name) {
  return only(
    [
      ...new Set(
        document
          .getRoot()
          .listSkins()
          .flatMap((skin) => skin.listJoints()),
      ),
    ].filter((node) => node.getName() === name),
    name,
  );
}
function addAction({ clip, arms, armRig, weaponRig, rest, mount, weaponBasis, weapon, role }) {
  const armsMapping = createAgentRetarget(armRig, clip, { minimumMappedBones: 40 });
  const weaponMapping = createAgentRetarget(weaponRig, clip, { minimumMappedBones: 5 });
  const source = new Set([...armsMapping.source.values(), ...weaponMapping.source.values()]);
  const { channels, timeline } = nativeChannels(clip, source, limits);
  if (role === 'fire' && timeline.at(-1) >= 2) throw Error('Firing clip exceeds two seconds.');
  const sourceBind = snapshot([...source]);
  const armBind = snapshot(armsMapping.targetJoints);
  const weaponBind = snapshot(weaponMapping.targetJoints);
  const targets = [...armsMapping.mappedJoints, ...weaponMapping.mappedJoints].map((node) => [
    node,
    joint(arms, node.getName()),
  ]);
  if (targets.length >= 96 || new Set(targets.map(([, node]) => node)).size !== targets.length)
    throw Error('Ambiguous action joints.');
  const output = new Map(
    [...targets.map(([, node]) => node), mount].map((node) => [
      node,
      Object.fromEntries(
        Object.entries(width).map(([property, size]) => [
          property,
          new Float32Array(timeline.length * size),
        ]),
      ),
    ]),
  );
  const append = (input, paths, frame) => {
    paths.translation.set(input.getTranslation(), frame * 3);
    paths.rotation.set(input.getRotation(), frame * 4);
    paths.scale.set(input.getScale(), frame * 3);
  };
  try {
    for (const [frame, seconds] of timeline.entries()) {
      restore(sourceBind);
      restore(armBind);
      restore(weaponBind);
      for (const channel of channels) assign(channel.node, channel.path, sample(channel, seconds));
      armsMapping.apply();
      weaponMapping.apply();
      for (const [input, node] of targets) append(input, output.get(node), frame);
      mount.setMatrix(multiply(joint(armRig, 'wpn').getWorldMatrix(), weaponBasis));
      append(mount, output.get(mount), frame);
    }
  } finally {
    restore(sourceBind);
    restore(armBind);
    restore(weaponBind);
    mount.setMatrix(rest);
  }
  const buffer = arms.getRoot().listBuffers()[0];
  const animation = arms.createAnimation(weapon + '-' + role);
  const time = arms
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Float32Array(timeline))
    .setBuffer(buffer);
  for (const [node, paths] of output)
    for (const [path, array] of Object.entries(paths)) {
      const accessor = arms
        .createAccessor()
        .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
        .setArray(array)
        .setBuffer(buffer);
      const sampler = arms
        .createAnimationSampler()
        .setInterpolation('LINEAR')
        .setInput(time)
        .setOutput(accessor);
      animation
        .addSampler(sampler)
        .addChannel(
          arms.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler),
        );
    }
  return { seconds: timeline.at(-1), frames: timeline.length, targets: output.size };
}

/** Operator-only packing of bounded named S2V exports. Keeps the official bone frame and existing POV basis. */
async function prepareViewmodel({ equipment, input, output }) {
  if (!Object.hasOwn(viewmodelSources, equipment))
    throw Error('Unsupported first-person equipment.');
  output = resolve(output);
  const paths = Object.fromEntries(roles.map((role) => [role, resolve(input[role])]));
  let inputBytes = 0;
  for (const path of Object.values(paths)) inputBytes += (await inspectEquipmentGltf(path)).bytes;
  if (inputBytes > 512 * 1024 ** 2) throw Error('Viewmodel input exceeds 512 MiB.');
  await checkFreeReserve(dirname(output), dirname(output), 32 * 1024 ** 2);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).setAllowNetwork(false);
  const arms = await io.read(paths.arms);
  const gun = await io.read(paths.weapon);
  for (const [document, minimum] of [
    [arms, 40],
    [gun, 5],
  ])
    poseAgentIdle(document, await io.read(paths.idle), { minimumMappedBones: minimum });
  const armRig = await io.read(paths.arms);
  const weaponRig = await io.read(paths.weapon);
  for (const [document, minimum] of [
    [armRig, 40],
    [weaponRig, 5],
  ])
    poseAgentIdle(document, await io.read(paths.idle), { minimumMappedBones: minimum });
  const armAnchor = joint(arms, 'wpn');
  const weaponBasis = inverseRigid(joint(gun, 'weapon').getWorldMatrix());
  const rest = multiply(armAnchor.getWorldMatrix(), weaponBasis);
  const destination = only(arms.getRoot().listScenes(), 'hands scene');
  const source = only(gun.getRoot().listScenes(), 'held model scene');
  const merged = mergeDocuments(arms, gun).get(source);
  const mount = arms.createNode(equipment + '-authored-mount').setMatrix(rest);
  for (const child of merged.listChildren()) mount.addChild(child);
  destination.addChild(mount);
  merged.dispose();
  const attached = joint(arms, 'weapon').getWorldMatrix();
  const anchor = armAnchor.getWorldMatrix();
  if (Math.hypot(...[12, 13, 14].map((index) => attached[index] - anchor[index])) > 1e-5)
    throw Error('The native weapon attachment moved during packing.');

  const actions = {};
  for (const role of ['fire', 'reload'])
    actions[role] = addAction({
      clip: await io.read(paths[role]),
      arms,
      armRig,
      weaponRig,
      rest,
      mount,
      weaponBasis,
      weapon: equipment,
      role,
    });
  for (const accessor of arms.getRoot().listAccessors()) accessor.setSparse(false);
  await arms.transform(dedup(), prune(), unpartition());
  const decodedGeometryBytes = arms
    .getRoot()
    .listAccessors()
    .reduce((size, accessor) => size + accessor.getArray().byteLength, 0);
  if (decodedGeometryBytes > 8 * 1024 ** 2) throw Error('Viewmodel geometry exceeds 8 MiB.');
  const textures = await applyTextureBudget(arms, {
    tier: 'mobile',
    budgetBytes: 24 * 1024 ** 2,
    maxEdge: 1024,
  });
  const packed = await compressGlbGeometry(await io.writeBinary(arms));
  if (packed.bytes.byteLength > 8 * 1024 ** 2) throw Error('Viewmodel transfer exceeds 8 MiB.');
  await writeFile(output, packed.bytes, { flag: 'wx', mode: 0o644 });
  return {
    bytes: packed.bytes.byteLength,
    sha256: createHash('sha256').update(packed.bytes).digest('hex'),
    decodedGeometryBytes,
    decodedTextureBytes: textures.manifest.residentBaseRGBABytes,
    actions,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['equipment', 'output', ...roles].map((name) => [name, { type: 'string' }]),
    ),
  });
  if (!values.equipment || !values.output || roles.some((role) => !values[role]))
    throw Error('Provide --equipment, --output, --arms, --weapon, --idle, --fire and --reload.');
  console.log(
    JSON.stringify(
      await prepareViewmodel({ equipment: values.equipment, input: values, output: values.output }),
    ),
  );
}
