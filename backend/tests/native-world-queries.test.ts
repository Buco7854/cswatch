import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4 } from '../../frontend/node_modules/three/build/three.module.js';
import { worldQueries } from '../../frontend/src/world/queries.ts';
import type { Manifest } from '../../frontend/src/world/format.ts';

test('native traces retain material and entity IDs and refit on a seek', () => {
  const floats = new Float32Array(6 * 15);
  for (let i = 0; i < 6; i++)
    floats.set(
      [
        [0, 0, 0],
        [0, 100, 0],
        [0, 0, 100],
      ][i % 3],
      i * 15,
    );
  const range = { first: 0, count: 3, vertices: 3, entity: 0, material: 12 };
  const manifest = {
    entities: [{ initialVisibility: true }],
    chunks: [
      { sky: false, family: 'opaque', ranges: [range] },
      { sky: true, family: 'opaque', ranges: [{ ...range, first: 3, entity: -1 }] },
    ],
  } as unknown as Manifest;
  const query = worldQueries(
    manifest,
    new Uint8Array(floats.buffer),
    Uint32Array.of(0, 1, 2, 3, 4, 5),
  );
  const ray = { target: [-2, 0.5, -0.5], position: [2, 0.5, -0.5] } as {
    target: [number, number, number];
    position: [number, number, number];
  };
  assert.deepEqual([query.hit(ray)?.material, query.hit(ray)?.entity], [12, 0]);
  const trace = query.trace.fork(0);
  assert.equal(trace(ray)[0], 0);
  query.updateEntity(0, new Matrix4().makeTranslation(1, 0, 0), true);
  assert.equal(trace(ray)[0], 1);
  query.updateEntity(0, new Matrix4(), false);
  assert.equal(trace(ray), ray.position);
  query.updateEntity(0, new Matrix4(), true);
  assert.equal(trace(ray)[0], 0);
});
