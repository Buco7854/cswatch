/** Native frame curves, retargeted by authored bone name. Recorded positions own travel. */
import { createAgentRetarget, inverseRigid, multiply } from './agent-retarget.mjs';
import {
  agentAnimationLimits as limits,
  agentAnimationRoles,
  agentAnimationNames,
} from './agent-animation-registry.mjs';
import { staticModelBounds } from './static-model-bounds.mjs';
import {
  snapshot,
  restore,
  width,
  assign,
  sample,
  nativeChannels,
} from './native-animation-samples.mjs';

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
        { animation, channels, timeline } = nativeChannels(clip, sourceNodes, limits),
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
