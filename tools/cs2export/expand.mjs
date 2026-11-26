// Verification: rewrite an instanced pack with every instance expanded into its own placed range,
// as packs were drawn before instancing. Vertex streams are reused; only the index buffer and the
// manifest change. node expand.mjs <pack> <out>
import { linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { MeshoptEncoder } from '../../frontend/node_modules/meshoptimizer/meshopt_encoder.js';
import { MeshoptDecoder } from '../../frontend/node_modules/meshoptimizer/meshopt_decoder.mjs';
import { validate } from '../../shared/native-world-format.mjs';

const [pack, out] = process.argv.slice(2);
if (!pack || !out) throw Error('Usage: expand.mjs <pack> <out>');
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const m = JSON.parse(readFileSync(join(pack, 'map.json'), 'utf8'));
const stored = (name) => {
  const bytes = readFileSync(join(pack, name)),
    record = m.files[name];
  return record.packing === 1 ? inflateSync(bytes) : bytes;
};
const indices = new Uint32Array(m.geometry.indices);
MeshoptDecoder.decodeIndexBuffer(
  new Uint8Array(indices.buffer),
  indices.length,
  4,
  stored(m.geometry.ib),
);
const table = m.geometry.instances ? stored(m.geometry.instances.file) : Buffer.alloc(0);
const bases = new Map();
let vertex = 0;
for (const chunk of m.chunks)
  for (const range of chunk.ranges)
    if (!bases.has(range.first)) {
      bases.set(range.first, vertex);
      vertex += range.vertices;
    }
const output = [];
let first = 0,
  base = 0;
function emit(range, extra) {
  const from = bases.get(range.first);
  for (let i = 0; i < range.count; i++) output.push(indices[range.first + i] - from + base);
  const placed = { ...range, ...extra, first };
  delete placed.instances;
  first += range.count;
  base += range.vertices;
  return placed;
}
for (const chunk of m.chunks) {
  const ranges = [];
  for (const range of chunk.ranges) {
    if (!range.instances) {
      ranges.push(emit(range, {}));
      continue;
    }
    for (let i = range.instances[0]; i < range.instances[0] + range.instances[1]; i++) {
      const o = i * 64,
        row = (r, c) => table.readFloatLE(o + (r * 4 + c) * 4);
      const placement = [];
      for (let c = 0; c < 4; c++) placement.push(row(0, c), row(1, c), row(2, c), c === 3 ? 1 : 0);
      const lighting = table.readUInt32LE(o + 48);
      ranges.push(
        emit(range, {
          placement,
          attributes: [
            lighting & 0xffff,
            range.attributes[1],
            lighting >>> 16,
            table.readUInt32LE(o + 52),
          ],
        }),
      );
    }
  }
  if (ranges.length > 8192) throw Error('Expanded chunk exceeds 8192 ranges');
  chunk.ranges = ranges;
}
mkdirSync(out, { recursive: true });
for (const name of readdirSync(pack))
  if (name !== 'map.json' && !name.startsWith('map.json'))
    linkSync(join(pack, name), join(out, name));
const ib = Buffer.from(
  MeshoptEncoder.encodeIndexBuffer(Uint32Array.from(output), output.length, 4),
);
const sha256 = createHash('sha256').update(ib).digest('hex');
writeFileSync(join(out, sha256 + '.bin'), ib, { flag: 'wx' });
m.files[sha256 + '.bin'] = { size: ib.length, sha256, category: 'geometry' };
m.geometry = {
  ...m.geometry,
  ib: sha256 + '.bin',
  vertices: base,
  indices: first,
  instances: null,
};
validate(m);
writeFileSync(join(out, 'map.json'), JSON.stringify(m));
console.log(JSON.stringify({ vertices: base, indices: first }));
