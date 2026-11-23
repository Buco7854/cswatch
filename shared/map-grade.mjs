export const mapGradeFile = 'grade.rgba';

export function mapGradeBytes(size) {
  return 4 * size ** 3;
}

function exact(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

// Algebraically cancel the constant term of the VRF Uncharted curve before
// dividing by its value at white. Mirage's near-linear curve would otherwise
// subtract two nearly equal floats for every dark pixel.
export function mapGradeCurve(curve) {
  const { shoulder, linear, angle, toe, numerator, denominator, whiteStops } = curve;
  const white = 2 ** whiteStops;
  const a = shoulder * (1 - numerator / denominator);
  const b = linear * (angle - numerator / denominator);
  const c = toe * denominator;
  return {
    a,
    b,
    c,
    white,
    whiteScale: (white * (shoulder * white + linear) + c) / (white * (a * white + b)),
  };
}

export function validMapGrade(value) {
  if (
    !exact(value, [
      'exposure',
      'curve',
      'lut',
      ...(value?.lighting !== undefined ? ['lighting'] : []),
    ]) ||
    !exact(value.exposure, ['min', 'max', 'bias']) ||
    !exact(value.curve, [
      'shoulder',
      'linear',
      'angle',
      'toe',
      'numerator',
      'denominator',
      'whiteStops',
    ]) ||
    !exact(value.lut, ['size', 'sha256'])
  )
    return false;
  const { exposure, curve, lut } = value;
  if (
    !bounded(exposure.min, 0.01, 16) ||
    !bounded(exposure.max, 0.01, 16) ||
    !bounded(exposure.bias, -8, 8) ||
    !bounded(curve.whiteStops, -6, 6) ||
    !bounded(curve.denominator, 0.0001, 16) ||
    !bounded(curve.toe, 0.0001, 16) ||
    ![curve.shoulder, curve.linear, curve.angle, curve.numerator].every((v) => bounded(v, 0, 16)) ||
    !Number.isInteger(lut.size) ||
    !bounded(lut.size, 2, 32) ||
    typeof lut.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(lut.sha256)
  )
    return false;
  if (
    value.lighting !== undefined &&
    (!exact(value.lighting, ['sun', 'sky']) ||
      ![value.lighting.sun, value.lighting.sky].every(
        (rgb) =>
          Array.isArray(rgb) &&
          rgb.length === 3 &&
          [0, 1, 2].every((channel) => bounded(rgb[channel], 0, 16)),
      ))
  )
    return false;
  const { a, b, white, whiteScale } = mapGradeCurve(curve);
  // A negative unnormalized curve is valid (e.g. Mirage), provided its
  // derivative keeps the same sign throughout the supported range.
  const slopeAtWhite =
    (a * curve.linear - b * curve.shoulder) * white ** 2 +
    curve.toe * curve.denominator * (2 * a * white + b);
  return (
    bounded(Math.abs(whiteScale), 1e-6, 1e6) &&
    a * whiteScale >= 0 &&
    b * whiteScale >= 0 &&
    slopeAtWhite * whiteScale >= 0
  );
}
