/** Bounded static native idle retargeting. Matches pinned S2V SkeletonRetargeter semantics.
 * A single genuine full-pose clip is sampled at frame zero. This is NOT recorded
 * locomotion/weapon animation. No animation graph or library is loaded here. */
const maximumBones = 1024;
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a, b) =>
  Array.from({ length: 16 }, (_, i) => {
    const row = i % 4,
      column = Math.floor(i / 4);
    let result = 0;
    for (let k = 0; k < 4; k++) result += a[k * 4 + row] * b[column * 4 + k];
    return result;
  });
function inverseRigid(matrix) {
  if (
    matrix.length !== 16 ||
    matrix.some((x) => !Number.isFinite(x)) ||
    Math.abs(matrix[3]) > 1e-6 ||
    Math.abs(matrix[7]) > 1e-6 ||
    Math.abs(matrix[11]) > 1e-6 ||
    Math.abs(matrix[15] - 1) > 1e-6
  )
    throw Error('Native idle retarget requires finite rigid transforms.');
  for (let a = 0; a < 3; a++)
    for (let b = a; b < 3; b++) {
      let dot = 0;
      for (let k = 0; k < 3; k++) dot += matrix[a * 4 + k] * matrix[b * 4 + k];
      if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-4)
        throw Error('Native idle retarget does not approximate non-rigid bone scale.');
    }
  // Authored float32 quaternions are almost rigid. Transposing their 3x3
  // basis compounds that tiny error down a long finger/cloth hierarchy. Use
  // the actual inverse after the same strict rigidity check, not a normalized
  // or rescaled approximation of the native pose.
  const [a, d, g] = [matrix[0], matrix[1], matrix[2]],
    [b, e, h] = [matrix[4], matrix[5], matrix[6]],
    [c, f, i] = [matrix[8], matrix[9], matrix[10]];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10)
    throw Error('Native idle parent transform is not invertible.');
  const result = identity();
  result[0] = (e * i - f * h) / determinant;
  result[4] = (c * h - b * i) / determinant;
  result[8] = (b * f - c * e) / determinant;
  result[1] = (f * g - d * i) / determinant;
  result[5] = (a * i - c * g) / determinant;
  result[9] = (c * d - a * f) / determinant;
  result[2] = (d * h - e * g) / determinant;
  result[6] = (b * g - a * h) / determinant;
  result[10] = (a * e - b * d) / determinant;
  for (let row = 0; row < 3; row++)
    result[12 + row] = -(
      result[row] * matrix[12] +
      result[4 + row] * matrix[13] +
      result[8 + row] * matrix[14]
    );
  return result;
}
function named(joints) {
  if (!joints.length || joints.length > maximumBones)
    throw Error('Native idle bone count exceeds its bound.');
  const map = new Map();
  for (const joint of joints) {
    const name = joint.getName();
    if (!name || name.length > 120 || map.has(name))
      throw Error('Native idle requires unique exact authored joint names.');
    map.set(name, joint);
  }
  return map;
}
export function poseAgentIdle(target, clip, { minimumMappedBones = 20 } = {}) {
  if (
    !Number.isInteger(minimumMappedBones) ||
    minimumMappedBones < 1 ||
    minimumMappedBones > maximumBones
  )
    throw Error('Invalid native idle mapping bound.');
  const targetJoints = [
      ...new Set(
        target
          .getRoot()
          .listSkins()
          .flatMap((skin) => skin.listJoints()),
      ),
    ],
    targetNames = named(targetJoints);
  const candidates = clip
    .getRoot()
    .listSkins()
    .map((skin) => {
      const map = named(skin.listJoints());
      return { map, overlap: [...map.keys()].filter((name) => targetNames.has(name)).length };
    })
    .sort((a, b) => b.overlap - a.overlap);
  if (
    !candidates.length ||
    candidates[0].overlap < minimumMappedBones ||
    candidates[1]?.overlap === candidates[0].overlap
  )
    throw Error('The selected native idle has no unambiguous matching skeleton.');
  const source = candidates[0].map,
    sourceNodes = new Set(source.values()),
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
  const sourceWorld = new Map([...source].map(([name, node]) => [name, node.getWorldMatrix()]));
  for (const matrix of sourceWorld.values()) inverseRigid(matrix);
  let mapped = 0;
  const roots = targetJoints.filter((joint) => !targetNames.has(joint.getParentNode()?.getName()));
  const walk = (node, depth) => {
    if (depth > maximumBones) throw Error('Native agent joint hierarchy exceeds its bound.');
    const world = sourceWorld.get(node.getName());
    if (world) {
      const parent = node.getParentNode(),
        parentWorld = parent ? parent.getWorldMatrix() : identity();
      node.setMatrix(multiply(inverseRigid(parentWorld), world));
      mapped++;
    }
    for (const child of node.listChildren())
      if (targetNames.get(child.getName()) === child) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  if (mapped !== candidates[0].overlap)
    throw Error('Native idle joint hierarchy did not cover every matched bone.');
  for (const animation of target.getRoot().listAnimations()) animation.dispose();
  return {
    schemaVersion: 1,
    clip: animations[0].getName(),
    sampledFrame: 0,
    sampledChannels,
    mappedBones: mapped,
    totalTargetBones: targetJoints.length,
    pose: 'approximate-static-native-idle',
    nativeRetargetSource:
      'ValveResourceFormat/Resource/ResourceTypes/ModelAnimation/SkeletonRetargeter.cs@942df5b37ebbde6153f6c488880b91d4bed003e6',
    limitations: [
      'Generic single rifle idle pose; not the recorded player bone pose',
      'No locomotion, crouching, recoil or held-weapon-specific animation',
    ],
  };
}
