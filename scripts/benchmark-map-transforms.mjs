import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Group, Mesh } from '../frontend/node_modules/three/build/three.module.js';
import { StaticMapGroup } from '../frontend/src/static-map-group.ts';

// Node 24. Read only the bounded JSON chunk: no textures/binary geometry, native
// conversion, browser, downloads or output pack are needed for this CPU benchmark.
// It measures unchanged transform traversal, not GPU rendering or overall FPS.
const path = process.argv[2];
assert(path, 'Usage: node scripts/benchmark-map-transforms.mjs /path/to/scene.glb');
const file = await open(path, 'r');
let json, jsonHash, bytes;
try {
  const header = Buffer.alloc(20);
  assert.equal((await file.read(header, 0, 20, 0)).bytesRead, 20);
  assert.equal(header.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(header.readUInt32LE(4), 2, 'GLB version');
  assert.equal(header.readUInt32LE(16), 0x4e4f534a, 'First GLB chunk is JSON');
  bytes = (await file.stat()).size;
  assert.equal(header.readUInt32LE(8), bytes, 'Complete GLB');
  const size = header.readUInt32LE(12);
  assert(size > 0 && size <= 32 * 1024 * 1024 && size <= bytes - 20, 'Bounded GLB JSON');
  const metadata = Buffer.alloc(size);
  assert.equal((await file.read(metadata, 0, size, 20)).bytesRead, size);
  jsonHash = createHash('sha256').update(metadata).digest('hex');
  json = JSON.parse(metadata.toString('utf8'));
} finally {
  await file.close();
}
assert(Array.isArray(json.nodes) && json.nodes.length <= 200_000, 'Bounded node count');
const nodes = json.nodes.map((node) => {
  const object = node.mesh === undefined ? new Group() : new Mesh();
  const values = (value, count) => {
    assert(Array.isArray(value) && value.length === count && value.every(Number.isFinite));
    return value;
  };
  if (node.matrix) {
    object.matrix.fromArray(values(node.matrix, 16));
    object.matrixAutoUpdate = false;
  } else {
    if (node.translation) object.position.fromArray(values(node.translation, 3));
    if (node.rotation) object.quaternion.fromArray(values(node.rotation, 4));
    if (node.scale) object.scale.fromArray(values(node.scale, 3));
  }
  assert(node.skin === undefined && !node.weights?.length, 'Static geometry only');
  if (node.mesh !== undefined)
    assert(
      !json.meshes[node.mesh]?.primitives.some((primitive) => primitive.targets?.length),
      'No morph targets',
    );
  return object;
});
assert(!json.animations?.length, 'No map animation clips');
const parent = new Map();
for (const [index, node] of json.nodes.entries()) {
  assert(!node.children || Array.isArray(node.children));
  for (const child of node.children || []) {
    assert(
      Number.isInteger(child) && child >= 0 && child < nodes.length && !parent.has(child),
      'Unique node parent',
    );
    parent.set(child, index);
  }
}
for (let index = 0; index < nodes.length; index++) {
  let cursor = index,
    depth = 0;
  while (parent.has(cursor)) {
    cursor = parent.get(cursor);
    assert(++depth < 512, 'Acyclic bounded scene depth');
  }
}
for (const [child, index] of parent) nodes[index].add(nodes[child]);
const source = new Group();
for (const index of json.scenes[json.scene ?? 0].nodes) {
  assert(Number.isInteger(index) && nodes[index] && !parent.has(index), 'Valid scene root');
  source.add(nodes[index]);
}
const baseline = new Group(),
  optimized = new StaticMapGroup();
baseline.rotation.y = optimized.rotation.y = Math.PI / 2;
baseline.add(source.clone(true));
optimized.add(source.clone(true));
optimized.seal([]);
baseline.updateMatrixWorld(true);
optimized.updateMatrixWorld(true);
const a = [],
  b = [];
baseline.traverse((node) => a.push(node));
optimized.traverse((node) => b.push(node));
assert.equal(a.length, b.length);
for (let i = 0; i < a.length; i++)
  assert.deepEqual(a[i].matrixWorld.elements, b[i].matrixWorld.elements, 'Exact source placement');
const measure = (root, count) => {
  const start = performance.now();
  for (let index = 0; index < count; index++) root.updateMatrixWorld(true);
  return (performance.now() - start) / count;
};
measure(baseline, 300);
measure(optimized, 300);
const old = [],
  next = [],
  iterations = 250,
  trials = 24;
for (let index = 0; index < trials; index++) {
  if (index % 2) {
    next.push(measure(optimized, iterations));
    old.push(measure(baseline, iterations));
  } else {
    old.push(measure(baseline, iterations));
    next.push(measure(optimized, iterations));
  }
}
const summarize = (values) => {
  values.sort((a, b) => a - b);
  return {
    medianMs: values[Math.floor(values.length / 2)],
    p95Ms: values[Math.floor(values.length * 0.95)],
  };
};
console.log(
  JSON.stringify(
    {
      evidence:
        'Actual local GLB transform hierarchy only; no geometry/texture load, overall frame-time, GPU or physical-device claim',
      node: process.version,
      glbBytes: bytes,
      jsonSha256: jsonHash,
      sceneNodes: a.length,
      exactWorldMatrices: true,
      trials,
      iterationsPerTrial: iterations,
      unchangedTransformTraversal: { baseline: summarize(old), optimized: summarize(next) },
    },
    null,
    2,
  ),
);
