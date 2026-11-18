/** The bounded authored cube-fog contract shared by operator preparation checks. */
const keys = (object, names) =>
  object &&
  typeof object === 'object' &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...names].sort().join(',');
const scalar = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const exponent = (value) => scalar(value, 0, 16) && value > 0;
export function validPreparedFog(fog) {
  if (
    !keys(fog, [
      'blend',
      'start',
      'end',
      'exponent',
      'height',
      'maxOpacity',
      'lodBias',
      'brightness',
      'rotation',
    ]) ||
    fog.blend !== 'multiply' ||
    !scalar(fog.start, 0, 254000) ||
    !scalar(fog.end, 0, 254000) ||
    fog.end <= fog.start ||
    !exponent(fog.exponent) ||
    !scalar(fog.maxOpacity, 0, 1) ||
    !scalar(fog.lodBias, 0, 16) ||
    !scalar(fog.brightness, 0, 16) ||
    (fog.height !== null &&
      (!keys(fog.height, ['start', 'end', 'exponent']) ||
        !scalar(fog.height.start, -254000, 254000) ||
        !scalar(fog.height.end, -254000, 254000) ||
        fog.height.start === fog.height.end ||
        !exponent(fog.height.exponent))) ||
    !Array.isArray(fog.rotation) ||
    fog.rotation.length !== 9 ||
    !fog.rotation.every((value) => scalar(value, -1, 1))
  )
    return false;
  const matrix = fog.rotation,
    tolerance = 1e-4;
  for (let axis = 0; axis < 3; axis++)
    for (let other = axis; other < 3; other++) {
      let column = 0,
        row = 0;
      for (let part = 0; part < 3; part++) {
        column += matrix[axis * 3 + part] * matrix[other * 3 + part];
        row += matrix[part * 3 + axis] * matrix[part * 3 + other];
      }
      const expected = axis === other ? 1 : 0;
      if (Math.abs(column - expected) > tolerance || Math.abs(row - expected) > tolerance)
        return false;
    }
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) -
    matrix[3] * (matrix[1] * matrix[8] - matrix[2] * matrix[7]) +
    matrix[6] * (matrix[1] * matrix[5] - matrix[2] * matrix[4]);
  return Math.abs(determinant - 1) <= tolerance;
}
