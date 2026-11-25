// Budget simplification of one packed range. Meshoptimizer's quadric error measures distance to
// the source planes, so on its own it may fold a closed shell thinner than the error bound (a roof
// slab, a trim, a chair leg) onto itself and drop the whole surface. Vertex normals are therefore
// simplification attributes, and a result that loses surface area is retried at half the error.
import { MeshoptSimplifier } from '../../frontend/node_modules/meshoptimizer/meshopt_simplifier.js';

export const simplifyRules = Object.freeze({
  // Normal deviation (unit vectors) weighed against inches of positional error.
  normalWeight: 4,
  // Largest share of the range's surface area a simplification may remove.
  areaLoss: 0.005,
  // Error steps tried from the requested bound before the range keeps its source triangles.
  steps: 3,
});

export const simplifierReady = MeshoptSimplifier.ready;

function surfaceArea(indices, positions) {
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3,
      b = indices[t + 1] * 3,
      c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

/**
 * Simplifies one range's local positions toward `ratio` of its indices within `error` inches.
 * Returns the kept indices, or undefined when no step both reduces and preserves the surface.
 * `stride` is the byte stride of `vertices`: float32 XYZ at 0 and snorm8 normal at 12.
 */
export function simplifyRange(vertices, stride, indices, ratio, error) {
  const count = vertices.length / stride;
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let c = 0; c < 3; c++) {
      positions[i * 3 + c] = vertices.readFloatLE(i * stride + c * 4);
      normals[i * 3 + c] = vertices.readInt8(i * stride + 12 + c) / 127;
    }
  const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  const source = surfaceArea(indices, positions);
  const weight = simplifyRules.normalWeight;
  for (let step = 0, bound = error; step < simplifyRules.steps; step++, bound /= 2) {
    const [kept] = MeshoptSimplifier.simplifyWithAttributes(
      indices,
      positions,
      3,
      normals,
      3,
      [weight, weight, weight],
      null,
      target,
      bound,
      ['LockBorder', 'ErrorAbsolute'],
    );
    if (kept.length >= indices.length) return undefined;
    if (source - surfaceArea(kept, positions) <= simplifyRules.areaLoss * source) return kept;
  }
  return undefined;
}
