/** Source conventions pinned to S2V SkyTransform, EntityTransformHelper and TextureExtract. */
export const sourceFaces = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'];
export const viewerFaces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const radians = (degrees) => (degrees * Math.PI) / 180;
const finiteVector = (value) =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/** Source QAngle applies roll about X, pitch about Y, then yaw about Z. */
export function sourceRotate(vector, angles, inverse = false) {
  if (!finiteVector(vector) || !finiteVector(angles))
    throw new Error('Invalid Source rotation vector.');
  let [x, y, z] = vector;
  const rotate = (axis, degrees) => {
    const a = radians(degrees),
      s = Math.sin(a),
      c = Math.cos(a);
    if (axis === 'x') [y, z] = [y * c - z * s, y * s + z * c];
    if (axis === 'y') [x, z] = [x * c + z * s, -x * s + z * c];
    if (axis === 'z') [x, y] = [x * c - y * s, x * s + y * c];
  };
  if (inverse) {
    rotate('z', -angles[1]);
    rotate('y', -angles[0]);
    rotate('x', -angles[2]);
  } else {
    rotate('x', angles[2]);
    rotate('y', angles[0]);
    rotate('z', angles[1]);
  }
  return [x, y, z];
}

/** Column-major placement in raw S2V glTF meters/Y-up, before the viewer's +90Y.
 * SpawnGroupLoader first places both prefab and sky camera with the reference's
 * rigid transform; SkyTransform then magnifies their relative displacement. */
export function skyWorldMatrix(reference, camera) {
  if (
    !reference ||
    !camera ||
    !finiteVector(reference.origin) ||
    !finiteVector(reference.angles) ||
    !finiteVector(reference.scales) ||
    !finiteVector(camera.origin) ||
    !Number.isFinite(camera.scale) ||
    camera.scale <= 0 ||
    camera.scale > 1024 ||
    reference.scales.some((scale) => scale !== 1)
  )
    throw new Error('Unsupported authored 3D sky placement.');
  const toGltf = ([x, y, z]) => [y, z, x];
  const columns = [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ].map((axis) =>
    toGltf(sourceRotate(axis, reference.angles)).map((value) => value * camera.scale),
  );
  const rotatedOrigin = sourceRotate(camera.origin, reference.angles);
  const translation = toGltf(
    reference.origin.map((value, axis) => value - camera.scale * rotatedOrigin[axis]),
  ).map((value) => value * 0.0254);
  return [...columns[0], 0, ...columns[1], 0, ...columns[2], 0, ...translation, 1];
}

/** Actual viewer ray sampled by a loaded Three CubeTexture slot (flipEnvMap=-1). */
export function viewerCubeDirection(face, u, v) {
  const s = u * 2 - 1,
    t = v * 2 - 1;
  switch (face) {
    case 'px':
      return [-1, -t, -s];
    case 'nx':
      return [1, -t, s];
    case 'py':
      return [-s, 1, t];
    case 'ny':
      return [-s, -1, -t];
    case 'pz':
      return [-s, -t, 1];
    case 'nz':
      return [s, -t, -1];
    default:
      throw new Error('Unknown Three cubemap slot.');
  }
}

/** The exact pre-rotated PNG convention used by S2V TextureExtract.SampleCubemapDirection. */
export function sourceCubemapSample(
  viewerDirection,
  angles = [0, 0, 0],
  referenceAngles = [0, 0, 0],
) {
  return createSourceCubemapSampler(angles, referenceAngles)(viewerDirection);
}

/** Precompute the inverse authored rotation once for a complete six-face conversion. */
export function createSourceCubemapSampler(angles = [0, 0, 0], referenceAngles = [0, 0, 0]) {
  const basis = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].map((axis) => sourceRotate(sourceRotate(axis, referenceAngles, true), angles, true));
  return (viewerDirection) => sample(viewerDirection, basis);
}
function sample(viewerDirection, basis) {
  if (!finiteVector(viewerDirection) || viewerDirection.every((value) => value === 0))
    throw new Error('Invalid sky sample direction.');
  const worldSource = [viewerDirection[0], -viewerDirection[2], viewerDirection[1]];
  const localSource = [0, 1, 2].map(
    (axis) =>
      worldSource[0] * basis[0][axis] +
      worldSource[1] * basis[1][axis] +
      worldSource[2] * basis[2][axis],
  );
  const [x, y, z] = [localSource[0], localSource[2], -localSource[1]];
  const ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z),
    maximum = Math.max(ax, ay, az);
  let face, u, v;
  if (maximum === ax) {
    if (x > 0) {
      face = 'rt';
      u = -z / ax;
      v = -y / ax;
    } else {
      face = 'lf';
      u = z / ax;
      v = -y / ax;
    }
  } else if (maximum === ay) {
    if (y > 0) {
      face = 'up';
      u = x / ay;
      v = z / ay;
    } else {
      face = 'dn';
      u = x / ay;
      v = -z / ay;
    }
  } else if (z > 0) {
    face = 'ft';
    u = x / az;
    v = -y / az;
  } else {
    face = 'bk';
    u = -x / az;
    v = -y / az;
  }
  u = (u + 1) / 2;
  v = (v + 1) / 2;
  if (face === 'rt') [u, v] = [v, 1 - u];
  else if (face === 'lf') [u, v] = [1 - v, u];
  else if (face === 'bk' || face === 'dn') [u, v] = [1 - u, 1 - v];
  return { face, u, v };
}

export function linearToSrgb(value) {
  const linear = Math.max(0, Math.min(1, value));
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
}
export function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
