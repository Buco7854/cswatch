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
import { viewmodelSources } from './viewmodel-sources.mjs';

import { addNativeMuzzle } from './native-weapon-muzzle.mjs';
import { preparerRevision, viewmodelActionSeconds } from '../../backend/dist/asset-preparer.js';

const limits = { idleSeconds: 12, samples: 361, channels: 384 };
const packedSamples = 181;
const actionsToPack = Object.keys(viewmodelActionSeconds);
const roles = ['arms', 'weapon', 'idle', ...actionsToPack];

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
// Source clips scale components such as the Molotov flame and detachable parts.
// Retarget the rigid pose first, then apply scale to the components the model exports.
function componentScaleTracks(document, poseJoints, seconds) {
  const tracks = new Map();
  const seen = new Set();
  const channels = document.getRoot().listAnimations()[0]?.listChannels() || [];
  if (channels.length > limits.channels)
    throw Error('Native animation channel count exceeds its bound.');
  for (const channel of channels) {
    const name = channel.getTargetNode()?.getName();
    if (channel.getTargetPath() !== 'scale') continue;
    const sampler = channel.getSampler(),
      input = sampler.getInput(),
      output = sampler.getOutput();
    if (output.getArray().every((value) => Math.abs(value - 1) <= 1e-4)) continue;
    if (
      !name ||
      seen.has(name) ||
      ['weapon', 'wpn', 'root_motion'].includes(name) ||
      !['LINEAR', 'STEP'].includes(sampler.getInterpolation()) ||
      input.getType() !== 'SCALAR' ||
      output.getType() !== 'VEC3' ||
      input.getCount() !== output.getCount() ||
      input.getCount() < 1 ||
      input.getCount() > limits.samples ||
      [...input.getArray()].some(
        (v, i, values) =>
          !Number.isFinite(v) || v < 0 || v > seconds || (i > 0 && v <= values[i - 1]),
      ) ||
      [...output.getArray()].some((v) => !Number.isFinite(v) || Math.abs(v) > 8)
    )
      throw Error(`Unsupported native weapon scale channel for ${name}.`);
    seen.add(name);
    if (poseJoints.has(name))
      tracks.set(name, { input, output, path: 'scale', interpolation: sampler.getInterpolation() });
    channel.dispose();
  }
  return tracks;
}

function sampleScale(track, time) {
  if (time <= track.input.getScalar(0)) return track.output.getElement(0, []);
  if (track.interpolation !== 'STEP') return sample(track, time);
  const next = track.input.getArray().findIndex((frame) => frame > time);
  return track.output.getElement(next < 0 ? track.input.getCount() - 1 : Math.max(0, next - 1), []);
}

function packedTimeline(timeline, scales) {
  if (timeline.length <= packedSamples) return timeline;
  const kept = new Set([timeline[0], timeline.at(-1)]);
  for (const track of scales.values())
    if (track.interpolation === 'STEP') for (const time of track.input.getArray()) kept.add(time);
  if (kept.size > packedSamples) throw Error('Native step tracks exceed the packed sample bound.');
  const intermediate = packedSamples - kept.size;
  for (let index = 1; index <= intermediate; index++)
    kept.add(timeline[Math.round((index * (timeline.length - 1)) / (intermediate + 1))]);
  return [...kept].sort((a, b) => a - b);
}

function addAction({
  clip,
  arms,
  armRig,
  weaponRig,
  rest,
  mount,
  weaponBasis,
  weapon,
  role,
  minimumWeaponBones,
  poseJoints,
  restScales,
}) {
  const seconds = viewmodelActionSeconds[role];
  const scales = componentScaleTracks(clip, poseJoints, seconds);
  const armsMapping = createAgentRetarget(armRig, clip, { minimumMappedBones: 40 });
  const weaponMapping = createAgentRetarget(weaponRig, clip, {
    minimumMappedBones: minimumWeaponBones,
  });
  const source = new Set([...armsMapping.source.values(), ...weaponMapping.source.values()]);
  const unused = new Set(
    clip
      .getRoot()
      .listNodes()
      .filter((node) => !source.has(node)),
  );
  const { channels, timeline: rigidTimeline } = nativeChannels(
    clip,
    source,
    { ...limits, seconds },
    unused,
  );
  const sourceTimeline = [
    ...new Set([
      ...rigidTimeline,
      ...[...scales.values()].flatMap(({ input }) => [...input.getArray()]),
    ]),
  ].sort((a, b) => a - b);
  if (sourceTimeline.length > limits.samples)
    throw Error('Combined weapon clip exceeds its sample bound.');
  const timeline = packedTimeline(sourceTimeline, scales);
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
  const scaled = [...new Set([...restScales.keys(), ...scales.keys()])]
    .map((name) => ({
      target: output.get(joint(arms, name)),
      track: scales.get(name),
      rest: restScales.get(name),
    }))
    .filter(({ target, track }) => target || track);
  if (scaled.some(({ target }) => !target)) throw Error('Native weapon scale target is absent.');
  const append = (input, paths, frame) => {
    paths.translation.set(input.getTranslation(), frame * 3);
    paths.rotation.set(input.getRotation(), frame * 4);
    paths.scale.set(input.getScale(), frame * 3);
  };
  try {
    for (const [frame, time] of timeline.entries()) {
      restore(sourceBind);
      restore(armBind);
      restore(weaponBind);
      for (const channel of channels) assign(channel.node, channel.path, sample(channel, time));
      armsMapping.apply();
      weaponMapping.apply();
      for (const [input, node] of targets) append(input, output.get(node), frame);
      for (const { target, track, rest } of scaled)
        target.scale.set(track ? sampleScale(track, time) : rest, frame * 3);
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
        .setInterpolation(
          (path === 'scale' && scales.get(node.getName())?.interpolation) || 'LINEAR',
        )
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

/** Pack bounded exports in the conversion child, retaining the native camera frame. */
async function prepareViewmodel({ equipment, input, output, manifest, muzzle }) {
  if (!Object.hasOwn(viewmodelSources, equipment))
    throw Error('Unsupported first-person equipment.');
  output = resolve(output);
  const paths = Object.fromEntries(
    roles.filter((role) => input[role]).map((role) => [role, resolve(input[role])]),
  );
  let inputBytes = 0;
  for (const path of Object.values(paths)) inputBytes += (await inspectEquipmentGltf(path)).bytes;
  if (inputBytes > 512 * 1024 ** 2) throw Error('Viewmodel input exceeds 512 MiB.');
  await checkFreeReserve(dirname(output), dirname(output), 32 * 1024 ** 2);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).setAllowNetwork(false);
  const arms = await io.read(paths.arms);
  const gun = await io.read(paths.weapon);
  const minimumWeaponBones = 1;
  const armRig = await io.read(paths.arms);
  const weaponRig = await io.read(paths.weapon);
  const poseJoints = new Set(
    [arms, gun].flatMap((document) =>
      document
        .getRoot()
        .listSkins()
        .flatMap((skin) => skin.listJoints().map((node) => node.getName())),
    ),
  );
  const restScales = new Map();
  for (const [document, minimum] of [
    [arms, 40],
    [gun, minimumWeaponBones],
    [armRig, 40],
    [weaponRig, minimumWeaponBones],
  ]) {
    const idle = await io.read(paths.idle);
    for (const [name, track] of componentScaleTracks(idle, poseJoints, limits.idleSeconds))
      restScales.set(name, sampleScale(track, 0));
    poseAgentIdle(document, idle, { minimumMappedBones: minimum });
  }
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
  for (const role of actionsToPack) {
    if (!paths[role]) continue;
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
      minimumWeaponBones,
      poseJoints,
      restScales,
    });
  }
  for (const [name, scale] of restScales) joint(arms, name).setScale(scale);
  for (const accessor of arms.getRoot().listAccessors()) accessor.setSparse(false);
  await arms.transform(dedup(), prune(), unpartition());
  addNativeMuzzle(arms, muzzle);
  const decodedGeometryBytes = arms
    .getRoot()
    .listAccessors()
    .reduce((size, accessor) => size + accessor.getArray().byteLength, 0);
  if (decodedGeometryBytes > 8 * 1024 ** 2) throw Error('Viewmodel geometry exceeds 8 MiB.');
  const textures = await applyTextureBudget(arms, {
    tier: 'mobile',
    budgetBytes: 16 * 1024 ** 2,
    maxEdge: 1024,
  });
  const packed = await compressGlbGeometry(await io.writeBinary(arms));
  if (packed.bytes.byteLength > 8 * 1024 ** 2) throw Error('Viewmodel transfer exceeds 8 MiB.');
  await writeFile(output, packed.bytes, { flag: 'wx', mode: 0o644 });
  return {
    schemaVersion: preparerRevision,
    id: equipment,
    manifest,
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
      ['equipment', 'output', 'manifest', 'muzzle', ...roles].map((name) => [
        name,
        { type: 'string' },
      ]),
    ),
  });
  const { equipment, output, manifest, muzzle } = values;
  const source = Object.hasOwn(viewmodelSources, equipment)
    ? viewmodelSources[equipment]
    : undefined;
  if (
    !source ||
    !output ||
    !/^[1-9]\d{0,19}$/.test(manifest ?? '') ||
    roles.some((role) => Boolean(source[role]) !== Boolean(values[role]))
  )
    throw Error('Provide the exact fixed viewmodel inputs and an official manifest.');
  const metadata = await prepareViewmodel({
    equipment,
    input: values,
    output,
    manifest,
    muzzle: muzzle ? JSON.parse(muzzle) : undefined,
  });
  await writeFile(resolve(dirname(output), 'manifest.json'), JSON.stringify(metadata) + '\n', {
    flag: 'wx',
    mode: 0o644,
  });
}
