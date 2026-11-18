/** Actual static skin-pose bounds, using the same joint * inverse-bind equation as glTF. */
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const transform = (matrix, point) =>
  [0, 1, 2].map(
    (row) =>
      matrix[row] * point[0] +
      matrix[4 + row] * point[1] +
      matrix[8 + row] * point[2] +
      matrix[12 + row],
  );
export function staticModelBounds(document) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0;
  const add = (point) => {
    if (point.some((v) => !Number.isFinite(v)))
      throw Error('Static native model has non-finite posed vertices.');
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], point[i]);
      max[i] = Math.max(max[i], point[i]);
    }
  };
  for (const scene of document.getRoot().listScenes())
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const world = node.getWorldMatrix(),
        skin = node.getSkin(),
        joints = skin?.listJoints(),
        inverse = skin?.getInverseBindMatrices();
      if (
        joints &&
        (!joints.length ||
          joints.length > 1024 ||
          (inverse && inverse.getCount() !== joints.length))
      )
        throw Error('Static native skin has invalid inverse-bind metadata.');
      const jointWorld = joints?.map((joint) => joint.getWorldMatrix()),
        inverseBind = joints?.map((_, i) => (inverse ? inverse.getElement(i, []) : identity));
      for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute('POSITION'),
          indices = primitive.getAttribute('JOINTS_0'),
          weights = primitive.getAttribute('WEIGHTS_0');
        if (!position || position.getType() !== 'VEC3')
          throw Error('Static native model lacks position geometry.');
        if (primitive.getAttribute('JOINTS_1') || primitive.getAttribute('WEIGHTS_1'))
          throw Error('Static native models currently support up to four skin weights per vertex.');
        if (
          skin &&
          (!indices ||
            !weights ||
            indices.getType() !== 'VEC4' ||
            weights.getType() !== 'VEC4' ||
            indices.getCount() !== position.getCount() ||
            weights.getCount() !== position.getCount())
        )
          throw Error('Static native skin weight metadata is inconsistent.');
        vertices += position.getCount();
        if (vertices > 1000000) throw Error('Static native vertex bound exceeded.');
        for (let i = 0; i < position.getCount(); i++) {
          const point = position.getElement(i, []);
          if (!skin) {
            add(transform(world, point));
            continue;
          }
          const jointIndices = indices.getElement(i, []),
            jointWeights = weights.getElement(i, []),
            sum = jointWeights.reduce((s, v) => s + v, 0);
          if (
            !Number.isFinite(sum) ||
            Math.abs(sum - 1) > 0.01 ||
            jointWeights.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
          )
            throw Error('Static native skin has invalid normalized weights.');
          const posed = [0, 0, 0];
          for (let j = 0; j < 4; j++) {
            if (
              !Number.isInteger(jointIndices[j]) ||
              jointIndices[j] < 0 ||
              jointIndices[j] >= joints.length
            )
              throw Error('Static native skin joint index is invalid.');
            if (jointWeights[j] === 0) continue;
            const transformed = transform(
              jointWorld[jointIndices[j]],
              transform(inverseBind[jointIndices[j]], point),
            );
            for (let axis = 0; axis < 3; axis++)
              posed[axis] += (transformed[axis] * jointWeights[j]) / sum;
          }
          add(posed);
        }
      }
    });
  if (
    !vertices ||
    min.some(
      (value, i) =>
        !Number.isFinite(value) ||
        !Number.isFinite(max[i]) ||
        Math.abs(value) > 8 ||
        Math.abs(max[i]) > 8 ||
        max[i] - value > 8,
    ) ||
    max.every((value, i) => value === min[i])
  )
    throw Error('Static native model bounds do not fit the supported meter frame.');
  return { min, max };
}
