import type { MapCubeFog, MapEnvironment, MapGradientFog } from '../../shared/map-assets';

const number = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const power = (value: unknown) => number(value, 0, 16) && value !== 0;
const keys = (value: object, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

const validHeight = (height: MapCubeFog['height']) =>
  height === null ||
  (height &&
    typeof height === 'object' &&
    !Array.isArray(height) &&
    keys(height, ['start', 'end', 'exponent']) &&
    number(height.start, -254000, 254000) &&
    number(height.end, -254000, 254000) &&
    height.start !== height.end &&
    power(height.exponent));

export function validateMapGradientFog(value: unknown): NonNullable<MapEnvironment['gradientFog']> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !keys(value, ['world', 'landscape'])
  )
    throw new Error('Invalid map gradient fog');
  const { world, landscape } = value as NonNullable<MapEnvironment['gradientFog']>;
  const validate = (fog: MapGradientFog | null) => {
    if (fog === null) return null;
    if (
      !fog ||
      typeof fog !== 'object' ||
      Array.isArray(fog) ||
      !keys(fog, ['start', 'end', 'exponent', 'height', 'color', 'maxOpacity']) ||
      !number(fog.start, 0, 254000) ||
      !number(fog.end, 0, 254000) ||
      fog.end <= fog.start ||
      !power(fog.exponent) ||
      !number(fog.maxOpacity, 0, 1) ||
      !validHeight(fog.height) ||
      !Array.isArray(fog.color) ||
      fog.color.length !== 3 ||
      fog.color.some((component) => !number(component, 0, 16))
    )
      throw new Error('Invalid map gradient fog');
    return {
      ...fog,
      height: fog.height && { ...fog.height },
      color: [...fog.color] as MapGradientFog['color'],
    };
  };
  if (!world && !landscape) throw new Error('Invalid map gradient fog');
  return { world: validate(world), landscape: validate(landscape) };
}

export function validateMapCubeFog(value: unknown): MapCubeFog {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid map cube fog');
  const fog = value as MapCubeFog;
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
    !number(fog.start, 0, 254000) ||
    !number(fog.end, 0, 254000) ||
    !(fog.end > fog.start) ||
    !power(fog.exponent) ||
    !number(fog.maxOpacity, 0, 1) ||
    !number(fog.lodBias, 0, 16) ||
    !number(fog.brightness, 0, 16) ||
    !Array.isArray(fog.rotation) ||
    fog.rotation.length !== 9 ||
    fog.rotation.some((value) => !number(value, -1, 1))
  )
    throw new Error('Invalid map cube fog');
  if (!validHeight(fog.height)) throw new Error('Invalid cube fog height');
  const matrix = fog.rotation,
    tolerance = 1e-4;
  for (let col = 0; col < 3; col++)
    for (let other = col; other < 3; other++) {
      const dot =
        matrix[col * 3] * matrix[other * 3] +
        matrix[col * 3 + 1] * matrix[other * 3 + 1] +
        matrix[col * 3 + 2] * matrix[other * 3 + 2];
      if (Math.abs(dot - (col === other ? 1 : 0)) > tolerance)
        throw new Error('Invalid cube fog rotation');
      const rowDot =
        matrix[col] * matrix[other] +
        matrix[col + 3] * matrix[other + 3] +
        matrix[col + 6] * matrix[other + 6];
      if (Math.abs(rowDot - (col === other ? 1 : 0)) > tolerance)
        throw new Error('Invalid cube fog rotation');
    }
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[7] * matrix[5]) -
    matrix[3] * (matrix[1] * matrix[8] - matrix[7] * matrix[2]) +
    matrix[6] * (matrix[1] * matrix[5] - matrix[4] * matrix[2]);
  if (Math.abs(determinant - 1) > tolerance) throw new Error('Invalid cube fog rotation');
  return { ...fog, height: fog.height ? { ...fog.height } : null, rotation: [...matrix] };
}
