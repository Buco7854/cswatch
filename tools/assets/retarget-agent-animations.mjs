/** Native frame curves, retargeted by authored bone name. Recorded positions own travel. */
import { createAgentRetarget, inverseRigid, multiply } from './agent-retarget.mjs';
import {
  agentAnimationLimits as limits,
  agentAnimationRoles,
  agentAnimationNames,
} from './agent-animation-registry.mjs';
import {
  directionalMovementRoles,
  validDirectionalRoles,
} from '../../shared/agent-animation-contract.mjs';
import { agentStride } from './agent-stride.mjs';
import { staticModelBounds } from './static-model-bounds.mjs';
import {
  snapshot,
  restore,
  width,
  assign,
  sample,
  nativeChannels,
} from './native-animation-samples.mjs';

export function retargetAgentAnimations(target, clips, { minimumMappedBones = 20 } = {}) {
  const roles = Object.keys(clips ?? {});
  const directional = validDirectionalRoles(roles);
  if (
    !directional &&
    (roles.length !== agentAnimationRoles.length ||
      agentAnimationRoles.some((role) => !clips?.[role]))
  )
    throw Error(
      'Provide exactly the five supported native animation roles or complete directional sets.',
    );
  const orderedRoles = directional ? roles : agentAnimationRoles;
  const idleRole = directional ? 'rifle-idle' : 'idle';
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
    boundsSamples = 0,
    jointSamples = 0,
    decodedBytes = root
      .listAccessors()
      .reduce((sum, accessor) => sum + accessor.getArray().byteLength, 0),
    idlePose;
  const reports = [];
  for (const animation of root.listAnimations()) animation.dispose();
  try {
    for (const role of orderedRoles) {
      restore(targetBind);
      const clip = clips[role],
        mapping = createAgentRetarget(target, clip, { minimumMappedBones }),
        sourceNodes = new Set(mapping.source.values()),
        sourceBind = snapshot([...sourceNodes]),
        // Some authored actions export a second, separate weapon skin. Only
        // its agent-side wpnPivot is carried by this model.
        ignored =
          directional && /-(fire|reload|draw)$/.test(role)
            ? clip
                .getRoot()
                .listSkins()
                .flatMap((skin) => skin.listJoints())
                .filter((node) => !sourceNodes.has(node))
            : [],
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
      const moving = directional && directionalMovementRoles.has(role);
      const strideFeet = ['ball_L', 'ball_R'].map((name) => mapping.source.get(name));
      const feet = [];
      if (!directional) decodedBytes += timeline.length * (4 + mapping.mappedJoints.length * 40);
      if (
        totalSamples > (directional ? limits.directionalSamples : limits.totalSamples) ||
        decodedBytes > limits.outputBytes ||
        jointSamples > limits.jointSamples ||
        (!directional && totalSamples * vertexCount > limits.posedVertices)
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
        if (moving) feet.push(strideFeet.map((foot) => foot?.getWorldMatrix().slice(12, 15)));
        previousRootPosition = rootPosition;
        anchor ??= currentRoot;
        // S2V bakes clip RootMotion into this bone. Undo that displacement so
        // recorded player coordinates remain authoritative (no double travel).
        mapping.apply(multiply(anchor, inverseRigid(currentRoot)));
        // Validate all legacy keys and up to nine evenly spaced poses per v2 clip.
        const frequency = Math.max(1, Math.ceil((timeline.length - 1) / 8));
        if (!directional || index % frequency === 0 || index === timeline.length - 1) {
          if (++boundsSamples * vertexCount > limits.posedVertices)
            throw Error('Native posed-vertex work exceeds its bound.');
          const posed = staticModelBounds(target);
          for (let axis = 0; axis < 3; axis++) {
            bounds.min[axis] = Math.min(bounds.min[axis], posed.min[axis]);
            bounds.max[axis] = Math.max(bounds.max[axis], posed.max[axis]);
          }
        }
        if (role === idleRole && index === 0) idlePose = snapshot(targetJoints);
        for (const [node, paths] of values) {
          paths.translation.set(node.getTranslation(), index * 3);
          paths.rotation.set(node.getRotation(), index * 4);
          paths.scale.set(node.getScale(), index * 3);
        }
      }
      restore(sourceBind);
      const stride = moving
        ? agentStride(
            role,
            feet,
            timeline,
            timeline.at(-1),
            previousRootPosition.map((value, axis) => value - anchor[12 + axis]),
          )
        : undefined;
      const input = target
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Float32Array(timeline))
          .setBuffer(buffer),
        outputAnimation = target
          .createAnimation(directional ? `cswatch:${role}` : agentAnimationNames[role])
          .setExtras({
            cswatch: {
              kind: directional ? 'native-agent' : 'native-locomotion',
              schemaVersion: directional ? 2 : 1,
              role,
              rootMotion: 'recorded-position',
              ...(stride
                ? { strideMeters: stride.strideMeters, phaseOffset: stride.phaseOffset }
                : {}),
            },
          });
      const staticInput = directional
        ? target
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Float32Array([0]))
            .setBuffer(buffer)
        : input;
      if (directional) decodedBytes += 4 + timeline.length * 4;
      let hasAuthoredTimeline = false;
      for (const [node, paths] of values)
        for (const [path, array] of Object.entries(paths)) {
          // v2 uses rigid tracks. Quantize variation before Meshopt compression.
          // Float32 animation accessor component types are required by core glTF.
          if (directional && path === 'scale') continue;
          const size = width[path];
          const precision = path === 'rotation' ? 16384 : 8192;
          if (directional)
            for (let i = 0; i < array.length; i++)
              array[i] = Math.round(array[i] * precision) / precision;
          // A constant pose still needs one full timeline for GLTFLoader's clip duration.
          const constant =
            directional &&
            hasAuthoredTimeline &&
            array.every((value, i) => value === array[i % size]);
          hasAuthoredTimeline ||= !constant;
          const keys = constant ? array.slice(0, size) : array;
          if (directional && (decodedBytes += keys.byteLength) > limits.outputBytes)
            throw Error('Native animation allocation exceeds its bound.');
          const output = target
              .createAccessor()
              .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
              .setArray(keys)
              .setBuffer(buffer),
            sampler = target
              .createAnimationSampler()
              .setInterpolation('LINEAR')
              .setInput(constant ? staticInput : input)
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
        ...stride,
        nativeGroundDistance,
        nativeGroundSpeed: nativeGroundDistance / timeline.at(-1),
      });
    }
  } finally {
    restore(idlePose ?? targetBind);
  }
  return {
    schemaVersion: directional ? 2 : 1,
    pose: directional ? 'directional-native-agent' : 'approximate-native-locomotion',
    rootMotion: 'recorded-position',
    clips: reports,
    sampledBounds: bounds,
    totalSamples,
    decodedBytes,
    limitations: directional
      ? [
          'Class-based animation chosen from recorded movement and actions',
          'In-place strides measured from planted feet where the clip has no root motion',
        ]
      : [
          'Generic native rifle cycles selected analytically from recorded movement and duck state',
          'Not the native animation graph or recorded bone, aim, shooting or reload animation',
          'Forward locomotion cycles do not reproduce all directional weapon-specific blends',
        ],
  };
}
