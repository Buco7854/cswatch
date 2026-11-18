/** Bounded static native idle retargeting. Matches pinned S2V SkeletonRetargeter semantics.
 * A single genuine full-pose clip is sampled at frame zero. This is NOT recorded
 * locomotion/weapon animation. No animation graph or library is loaded here. */
import { createAgentRetarget } from './agent-retarget.mjs';
export function poseAgentIdle(target, clip, { minimumMappedBones = 20 } = {}) {
  const mapping = createAgentRetarget(target, clip, { minimumMappedBones }),
    sourceNodes = new Set(mapping.source.values()),
    animations = clip.getRoot().listAnimations();
  if (animations.length !== 1)
    throw Error('Static idle preparation requires exactly one authored clip.');
  let sampledChannels = 0;
  for (const channel of animations[0].listChannels()) {
    const node = channel.getTargetNode();
    if (!sourceNodes.has(node)) continue;
    const sampler = channel.getSampler(),
      input = sampler?.getInput(),
      output = sampler?.getOutput(),
      path = channel.getTargetPath();
    const width = { translation: 3, rotation: 4, scale: 3 }[path];
    if (
      !width ||
      !input ||
      !output ||
      !['LINEAR', 'STEP'].includes(sampler.getInterpolation()) ||
      input.getCount() < 1 ||
      Math.abs(input.getScalar(0)) > 1e-6 ||
      output.getElementSize() !== width
    )
      throw Error('Unsupported native idle channel or nonzero first frame.');
    const value = output.getElement(0, []);
    if (value.some((x) => !Number.isFinite(x)))
      throw Error('Native idle contains a non-finite first pose.');
    if (path === 'translation') node.setTranslation(value);
    else if (path === 'rotation') node.setRotation(value);
    else node.setScale(value);
    sampledChannels++;
  }
  if (!sampledChannels) throw Error('Native idle has no matching first-frame pose channels.');
  const mapped = mapping.apply();
  for (const animation of target.getRoot().listAnimations()) animation.dispose();
  return {
    schemaVersion: 1,
    clip: animations[0].getName(),
    sampledFrame: 0,
    sampledChannels,
    mappedBones: mapped,
    totalTargetBones: mapping.targetJoints.length,
    pose: 'approximate-static-native-idle',
    nativeRetargetSource:
      'ValveResourceFormat/Resource/ResourceTypes/ModelAnimation/SkeletonRetargeter.cs@942df5b37ebbde6153f6c488880b91d4bed003e6',
    limitations: [
      'Generic single rifle idle pose; not the recorded player bone pose',
      'No locomotion, crouching, recoil or held-weapon-specific animation',
    ],
  };
}
