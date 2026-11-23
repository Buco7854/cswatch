import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Group, Texture } from '../frontend/node_modules/three/build/three.module.js';
import { GLTFLoader } from '../frontend/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../frontend/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
import { followObstruction } from '../frontend/src/follow-obstruction.ts';

// Run on an operator's prepared GLB and recorded gzip chunk. Only static geometry
// and transforms affect these CPU queries, so the loader can omit texture decoding.
const [, , mapPath, chunkPath] = process.argv;
assert(
  mapPath && chunkPath,
  'Usage: node scripts/benchmark-map-traces.mjs scene.glb chunk.json.gz',
);
assert(statSync(mapPath).size <= 256 * 1024 ** 2 && statSync(chunkPath).size <= 32 * 1024 ** 2);
const bytes = readFileSync(mapPath);
const { frames } = JSON.parse(
  gunzipSync(readFileSync(chunkPath), { maxOutputLength: 64 * 1024 ** 2 }),
);
globalThis.self = globalThis;
const loader = new GLTFLoader()
  .setMeshoptDecoder(MeshoptDecoder)
  .register(() => ({
    name: 'EXT_texture_webp',
    loadTexture: () => Promise.resolve(new Texture()),
  }));
loader.manager.setURLModifier(() => {
  throw new Error('Expected embedded buffers');
});
const { scene } = await loader.parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  '',
);
const sky = [];
scene.traverse((node) => {
  if (node.userData.cswatch?.kind === 'skybox' && node.userData.cswatch.schemaVersion === 1)
    sky.push(node);
});
for (const node of sky) node.removeFromParent();
const world = new Group();
world.add(scene);
world.rotation.y = Math.PI / 2;

const queries = [];
for (const frame of frames) {
  for (const player of frame.players) {
    if (!player.alive) continue;
    const x = player.x * 0.0254,
      y = player.z * 0.0254,
      z = -player.y * 0.0254;
    queries.push({ id: player.id, target: [x, y + 0.14, z], position: [x, y - 0.22, z] });
  }
}
const trials = [];
for (let run = 0; run < 5; run++) {
  const start = performance.now();
  const trace = followObstruction(world);
  const byActor = new Map();
  for (const { id } of queries) {
    if (!byActor.has(id)) byActor.set(id, trace.fork(0));
  }
  const ready = performance.now();
  const results = queries.map((query) => byActor.get(query.id)(query));
  const end = performance.now();
  trials.push({
    setupMs: Math.round(ready - start),
    queriesMs: Math.round(end - ready),
    hits: results.filter((result, i) => result !== queries[i].position).length,
    resultSha256: createHash('sha256').update(JSON.stringify(results)).digest('hex'),
  });
}
console.log(JSON.stringify({ node: process.version, queries: queries.length, trials }, null, 2));
