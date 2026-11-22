export const snapshot = (nodes) => nodes.map((node) => [node, node.getMatrix()]);
export const restore = (state) => state.forEach(([node, matrix]) => node.setMatrix(matrix));
export const width = { translation: 3, rotation: 4, scale: 3 };
export const assign = (node, path, value) => {
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
export function sample(channel, time) {
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
export function nativeChannels(document, sourceNodes, limits, ignoredNodes = new Set()) {
  const animations = document.getRoot().listAnimations();
  if (animations.length !== 1) throw Error('Each native role requires exactly one authored clip.');
  const animation = animations[0],
    extras = animation.getExtras();
  if (extras.additive && !extras.additive_composed)
    throw Error('Native delta animations must be composed by S2V before retargeting.');
  const channels = [],
    keys = new Set(),
    times = new Set();
  const authoredChannels = animation.listChannels();
  if (authoredChannels.length > limits.channels)
    throw Error('Native animation channel count exceeds its bound.');
  for (const channel of authoredChannels) {
    if (ignoredNodes.has(channel.getTargetNode())) continue;
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
