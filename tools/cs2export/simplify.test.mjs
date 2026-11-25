import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshoptSimplifier } from '../../frontend/node_modules/meshoptimizer/meshopt_simplifier.js';
import { simplifierReady, simplifyRange, simplifyRules } from './simplify.mjs';

const stride = 60;
// Thin welded slats, like chair rails and roof trims: closed boxes with shared corner vertices
// and averaged normals, thinner than the 2-inch error bound.
function slats(count = 8, size = [20, 2, 0.7], steps = [10, 2, 2]) {
  const points = [],
    normals = [],
    indices = [],
    known = new Map();
  const vertex = (p, n) => {
    const key = p.map((x) => x.toFixed(4)).join();
    if (known.has(key)) {
      const i = known.get(key);
      n.forEach((x, c) => (normals[i][c] += x));
      return i;
    }
    known.set(key, points.length);
    points.push(p);
    normals.push([...n]);
    return points.length - 1;
  };
  for (let s = 0; s < count; s++) {
    const [w, d, h] = size,
      y0 = s * 4;
    const face = (origin, u, v, nu, nv, n) => {
      const ids = [];
      for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++)
          ids.push(
            vertex(
              [0, 1, 2].map((k) => origin[k] + (u[k] * i) / nu + (v[k] * j) / nv),
              n,
            ),
          );
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const q = j * (nu + 1) + i;
          indices.push(
            ids[q],
            ids[q + 1],
            ids[q + nu + 2],
            ids[q],
            ids[q + nu + 2],
            ids[q + nu + 1],
          );
        }
    };
    const [nx, ny, nz] = steps;
    face([0, y0, h], [w, 0, 0], [0, d, 0], nx, ny, [0, 0, 1]);
    face([0, y0 + d, 0], [w, 0, 0], [0, -d, 0], nx, ny, [0, 0, -1]);
    face([0, y0, 0], [w, 0, 0], [0, 0, h], nx, nz, [0, -1, 0]);
    face([w, y0 + d, 0], [-w, 0, 0], [0, 0, h], nx, nz, [0, 1, 0]);
    face([0, y0 + d, 0], [0, -d, 0], [0, 0, h], ny, nz, [-1, 0, 0]);
    face([w, y0, 0], [0, d, 0], [0, 0, h], ny, nz, [1, 0, 0]);
  }
  const v = Buffer.alloc(points.length * stride);
  points.forEach((p, i) => {
    const length = Math.hypot(...normals[i]);
    p.forEach((x, c) => v.writeFloatLE(x, i * stride + c * 4));
    normals[i].forEach((x, c) => v.writeInt8(Math.round((x / length) * 127), i * stride + 12 + c));
  });
  return { v, indices: Uint32Array.from(indices) };
}

function area(v, indices) {
  const p = (i, c) => v.readFloatLE(i * stride + c * 4);
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const u = [0, 1, 2].map((k) => p(b, k) - p(a, k)),
      w = [0, 1, 2].map((k) => p(c, k) - p(a, k));
    total +=
      Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) /
      2;
  }
  return total;
}

test('simplification keeps thin welded shells that a positional bound alone folds away', async () => {
  await simplifierReady;
  const { v, indices } = slats();
  const positions = new Float32Array((v.length / stride) * 3);
  for (let i = 0; i < positions.length; i++)
    positions[i] = v.readFloatLE(Math.floor(i / 3) * stride + (i % 3) * 4);
  const target = Math.floor((indices.length * 0.05) / 3) * 3;
  // The fixture reproduces the failure: positions alone lose a tenth of the surface.
  const [plain] = MeshoptSimplifier.simplify(indices, positions, 3, target, 2, [
    'LockBorder',
    'ErrorAbsolute',
  ]);
  assert.ok(area(v, plain) < area(v, indices) * 0.95);
  const kept = simplifyRange(v, stride, indices, 0.05, 2);
  assert.ok(kept, 'the slats still simplify');
  assert.ok(kept.length < indices.length, 'some triangles are removed');
  assert.ok(area(v, kept) >= area(v, indices) * (1 - simplifyRules.areaLoss));
});
