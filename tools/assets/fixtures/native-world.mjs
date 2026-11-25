// Original unit triangle. These streams use the same encoder as the offline packer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import { MeshoptEncoder } from '../../../frontend/node_modules/meshoptimizer/meshopt_encoder.js';
import { vertexArchive } from '../../cs2export/quantize.mjs';
await MeshoptEncoder.ready;
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const indices = Buffer.from(new Uint32Array([0, 1, 2]).buffer),
  v = Buffer.alloc(180),
  bounds = [0, 0, 0, 1, 1, 0];
v.writeFloatLE(1, 60);
v.writeFloatLE(1, 124);
for (let i = 0; i < 3; i++) {
  v[i * 60 + 14] = 127;
  v[i * 60 + 16] = 127;
}
const material = {
  name: 'original',
  shader: 'csgo_environment.vfx',
  ints: {},
  scalars: {},
  vectors: {},
  slots: {},
  bindings: {},
};
const archive = vertexArchive(),
  range = archive.encode({ v, indices, localBounds: bounds }, material);
const vertex = archive.finish(),
  index = Buffer.from(MeshoptEncoder.encodeIndexBuffer(indices, 3, 4));
export const vertexFile = sha(vertex) + '.bin';
export function writeNativeWorld(root, map, sourceManifest = '42') {
  const dir = join(root, map);
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const bytes of [vertex, index]) {
    const hash = sha(bytes),
      name = hash + '.bin';
    files[name] = { size: bytes.length, sha256: hash, category: 'geometry' };
    writeFileSync(join(dir, name), bytes);
  }
  const value = {
    format: 'cswatch-native-world',
    version: 3,
    map,
    sourceManifest,
    units: 'inches',
    up: 'Z',
    bounds,
    roles: [],
    geometry: { stride: 60, vertices: 3, indices: 3, vb: vertexFile, ib: sha(index) + '.bin' },
    files,
    chunks: [
      {
        family: 'opaque',
        side: false,
        sky: false,
        banks: [],
        bounds,
        ranges: [{ ...range, first: 0, count: 3, bounds, material: 0, entity: -1 }],
      },
    ],
    materials: [material],
    arrays: [],
    specials: {},
    post: {},
    entities: [],
    environments: [],
    phone: { arrays: [], specials: {}, rgbm: {}, lightmaps: {}, volumes: {} },
    visibility: null,
  };
  const model = Buffer.from(JSON.stringify(value));
  writeFileSync(join(dir, 'map.json'), model);
  writeFileSync(join(dir, 'map.json.br'), brotliCompressSync(model));
  return model;
}
