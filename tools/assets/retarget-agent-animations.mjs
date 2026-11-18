/** Native frame curves, retargeted by authored bone name. Recorded positions own travel. */
import { createAgentRetarget, inverseRigid, multiply } from './agent-retarget.mjs';
import {
  agentAnimationLimits as limits,
  agentAnimationRoles,
  agentAnimationNames,
} from './agent-animation-registry.mjs';
import { staticModelBounds } from './static-model-bounds.mjs';

const snapshot = (nodes) => nodes.map((node) => [node, node.getMatrix()]);
const restore = (state) => state.forEach(([node, matrix]) => node.setMatrix(matrix));
const width = { translation: 3, rotation: 4, scale: 3 };
const assign = (node, path, value) => {
  if (path === 'translation') node.setTranslation(value);
  else if (path === 'rotation') node.setRotation(value);
  else node.setScale(value);
};
function slerp(a, b, amount) {
  let cosine = a.reduce((sum, value, index) => sum + value * b[index], 0);
  if (cosine < 0) {
    b = b.map((value) => -value);
    cosine = -cosine;
  }
  let left = 1 - amount,
    right = amount;
  if (cosine < 0.9995) {
    const angle = Math.acos(Math.min(1, cosine)),
      sine = Math.sin(angle);
    left = Math.sin((1 - amount) * angle) / sine;
    right = Math.sin(amount * angle) / sine;
  }
  const value = a.map((component, index) => component * left + b[index] * right),
    norm = Math.hypot(...value);
  return value.map((component) => component / norm);
}
function sample(channel, time) {
  const { input, output, path } = channel;
  let lower = 0,
    upper = input.getCount() - 1;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (input.getScalar(middle) <= time) lower = middle;
    else upper = middle - 1;
  }
  const a = output.getElement(lower, []);
  if (lower === input.getCount() - 1 || input.getScalar(lower) === time) return a;
  const b = output.getElement(lower + 1, []),
    amount =
      (time - input.getScalar(lower)) / (input.getScalar(lower + 1) - input.getScalar(lower));
  return path === 'rotation'
    ? slerp(a, b, amount)
    : a.map((component, index) => component + (b[index] - component) * amount);
}
function nativeChannels(document, sourceNodes) {
  const animations = document.getRoot().listAnimations();
  if (animations.length !== 1) throw Error('Each native role requires exactly one authored clip.');
  const animation = animations[0],
    extras = animation.getExtras();
  if (extras.additive && !extras.additive_composed)
    throw Error('Native delta animations must be composed by S2V before retargeting.');
  const channels = [],
    keys = new Set(),
    times = new Set();
  for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode(),
      path = channel.getTargetPath(),
      sampler = channel.getSampler(),
      input = sampler?.getInput(),
      output = sampler?.getOutput(),
      key = `${node?.getName()}:${path}`;
    if (
      !sourceNodes.has(node) ||
      !width[path] ||
      !input ||
      !output ||
      sampler.getInterpolation() !== 'LINEAR' ||
      input.getType() !== 'SCALAR' ||
      input.getCount() < 1 ||
      input.getCount() > limits.samples ||
      output.getCount() !== input.getCount() ||
      output.getElementSize() !== width[path] ||
      keys.has(key)
    )
      throw Error('Unsupported or ambiguous native animation channel.');
    keys.add(key);
    for (let index = 0; index < input.getCount(); index++) {
      const time = input.getScalar(index),
        value = output.getElement(index, []);
      if (
        !Number.isFinite(time) ||
        time < 0 ||
        time > limits.seconds ||
        (index === 0 ? time !== 0 : time <= input.getScalar(index - 1)) ||
        value.some((component) => !Number.isFinite(component)) ||
        (path === 'translation' && value.some((component) => Math.abs(component) > 1024)) ||
        (path === 'rotation' && Math.abs(Math.hypot(...value) - 1) > 1e-4) ||
        (path === 'scale' && value.some((component) => Math.abs(component - 1) > 1e-4))
      )
        throw Error('Native animation has invalid time, pose or non-rigid scale.');
      times.add(time);
    }
    channels.push({ node, path, input, output });
  }
  const timeline = [...times].sort((a, b) => a - b);
  if (
    !channels.length ||
    channels.length > limits.channels ||
    timeline.length < 2 ||
    timeline.length > limits.samples ||
    timeline.at(-1) <= 0
  )
    throw Error('Native animation timeline exceeds its bounded positive duration.');
  return { animation, channels, timeline };
}

/** All five roles are explicit; missing roles never become a fabricated curve. */
export function retargetAgentAnimations(target, clips, { minimumMappedBones = 20 } = {}) {
  if (
    !clips ||
    Object.keys(clips).length !== agentAnimationRoles.length ||
    agentAnimationRoles.some((role) => !clips[role])
  )
    throw Error('Provide exactly the five supported native animation roles.');
  const root = target.getRoot(),
    targetJoints = [...new Set(root.listSkins().flatMap((skin) => skin.listJoints()))],
    targetBind = snapshot(targetJoints),
    buffer = root.listBuffers()[0] ?? target.createBuffer(),
    bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const vertexCount = root
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((sum, primitive) => sum + (primitive.getAttribute('POSITION')?.getCount() ?? 0), 0);
  let totalSamples = 0,
    decodedBytes = root
      .listAccessors()
      .reduce((sum, accessor) => sum + accessor.getArray().byteLength, 0),
    idlePose;
  const reports = [];
  for (const animation of root.listAnimations()) animation.dispose();
  try {
    for (const role of agentAnimationRoles) {
      restore(targetBind);
      const clip = clips[role],
        mapping = createAgentRetarget(target, clip, { minimumMappedBones }),
        sourceNodes = new Set(mapping.source.values()),
        sourceBind = snapshot([...sourceNodes]),
        { animation, channels, timeline } = nativeChannels(clip, sourceNodes),
        motionRoot = mapping.source.get('root_motion');
      if (!motionRoot || sourceNodes.has(motionRoot.getParentNode()))
        throw Error('Native animation requires its exact authored root_motion skeleton root.');
      totalSamples += timeline.length;
      decodedBytes += timeline.length * (4 + mapping.mappedJoints.length * 40);
      if (
        totalSamples > limits.totalSamples ||
        decodedBytes > limits.outputBytes ||
        totalSamples * vertexCount > 64000000
      )
        throw Error('Native animation allocation or posed-vertex work exceeds its bound.');
      const values = new Map(
        mapping.mappedJoints.map((node) => [
          node,
          Object.fromEntries(
            Object.entries(width).map(([path, size]) => [
              path,
              new Float32Array(timeline.length * size),
            ]),
          ),
        ]),
      );
      let anchor,
        previousRootPosition,
        nativeGroundDistance = 0;
      for (let index = 0; index < timeline.length; index++) {
        restore(sourceBind);
        restore(targetBind);
        for (const channel of channels)
          assign(channel.node, channel.path, sample(channel, timeline[index]));
        const currentRoot = motionRoot.getWorldMatrix();
        const rootPosition = [currentRoot[12], currentRoot[13], currentRoot[14]];
        if (previousRootPosition)
          nativeGroundDistance += Math.hypot(
            rootPosition[0] - previousRootPosition[0],
            rootPosition[2] - previousRootPosition[2],
          );
        previousRootPosition = rootPosition;
        anchor ??= currentRoot;
        // S2V bakes clip RootMotion into this bone. Undo that displacement so
        // recorded player coordinates remain authoritative (no double travel).
        mapping.apply(multiply(anchor, inverseRigid(currentRoot)));
        const posed = staticModelBounds(target);
        for (let axis = 0; axis < 3; axis++) {
          bounds.min[axis] = Math.min(bounds.min[axis], posed.min[axis]);
          bounds.max[axis] = Math.max(bounds.max[axis], posed.max[axis]);
        }
        if (role === 'idle' && index === 0) idlePose = snapshot(targetJoints);
        for (const [node, paths] of values) {
          paths.translation.set(node.getTranslation(), index * 3);
          paths.rotation.set(node.getRotation(), index * 4);
          paths.scale.set(node.getScale(), index * 3);
        }
      }
      restore(sourceBind);
      const input = target
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Float32Array(timeline))
          .setBuffer(buffer),
        outputAnimation = target.createAnimation(agentAnimationNames[role]).setExtras({
          cswatch: {
            kind: 'native-locomotion',
            schemaVersion: 1,
            role,
            rootMotion: 'recorded-position',
          },
        });
      for (const [node, paths] of values)
        for (const [path, array] of Object.entries(paths)) {
          const output = target
              .createAccessor()
              .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
              .setArray(array)
              .setBuffer(buffer),
            sampler = target
              .createAnimationSampler()
              .setInterpolation('LINEAR')
              .setInput(input)
              .setOutput(output),
            channel = target
              .createAnimationChannel()
              .setTargetNode(node)
              .setTargetPath(path)
              .setSampler(sampler);
          outputAnimation.addSampler(sampler).addChannel(channel);
        }
      reports.push({
        role,
        clip: animation.getName(),
        name: outputAnimation.getName(),
        duration: timeline.at(-1),
        samples: timeline.length,
        mappedBones: mapping.overlap,
        nativeGroundDistance,
        nativeGroundSpeed: nativeGroundDistance / timeline.at(-1),
      });
    }
  } finally {
    restore(idlePose ?? targetBind);
  }
  return {
    schemaVersion: 1,
    pose: 'approximate-native-locomotion',
    rootMotion: 'recorded-position',
    clips: reports,
    sampledBounds: bounds,
    totalSamples,
    decodedBytes,
    limitations: [
      'Generic native rifle cycles selected analytically from recorded movement and duck state',
      'Not the native animation graph or recorded bone, aim, shooting or reload animation',
      'Forward locomotion cycles do not reproduce all directional weapon-specific blends',
    ],
  };
}
