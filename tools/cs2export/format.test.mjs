import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadManifest, readAsset, validate } from '../../frontend/src/world/format.ts';

const payload = new Uint8Array(8),
  hash = createHash('sha256').update(payload).digest('hex'),
  file = hash + '.bin';
function manifest() {
  const bounds = [0, 0, 0, 1, 1, 1];
  return {
    format: 'cswatch-native-world',
    version: 1,
    units: 'inches',
    up: 'Z',
    bounds,
    roles: ['color'],
    geometry: { stride: 60, vertices: 3, indices: 3, vb: file, ib: file },
    files: { [file]: { size: 8, sha256: hash, category: 'textures' } },
    chunks: [
      { bounds, banks: [0], ranges: [{ first: 0, count: 3, bounds, material: 0, entity: -1 }] },
    ],
    materials: [{ bindings: { color: [0, 0] } }],
    arrays: [
      {
        file,
        format: 'DXT1',
        textures: ['grass'],
        mips: [{ w: 4, h: 4, level: 0, offset: 0, size: 8 }],
      },
    ],
    specials: {},
    entities: [],
    environments: [],
    post: {},
    visibility: null,
  };
}
test('valid format, optional visibility and single BC1 block', () =>
  assert.equal(validate(manifest()).geometry.indices, 3));
for (const [name, mutate, error] of [
  ['version', (m) => m.version++, /format/],
  ['path traversal', (m) => (m.files['../texture.bin'] = m.files[file]), /file/],
  ['decoded budget', (m) => (m.geometry.vertices = 2 ** 30), /budget/],
  ['overlapping ranges', (m) => m.chunks[0].ranges.push(m.chunks[0].ranges[0]), /draw range/],
  ['index gap', (m) => (m.chunks[0].ranges = []), /coverage/],
  ['bounds order', (m) => (m.bounds[0] = 2), /bounds/],
  ['missing entity', (m) => (m.chunks[0].ranges[0].entity = 0), /range/],
  ['invalid BC layout', (m) => (m.arrays[0].mips[0].w = 8), /byte count/],
  ['out of order mips', (m) => (m.arrays[0].mips[0].level = 1), /layout/],
  ['oversize layer', (m) => (m.materials[0].bindings.color[1] = 1), /reference/],
  ['LUT extent', (m) => (m.post.grade = { dimension: 32, lut: file }), /LUT/],
  ['unbound visibility', (m) => (m.visibility = { file: 'missing', clusters: 2 }), /visibility/],
])
  test('rejects ' + name, () => {
    const m = manifest();
    mutate(m);
    assert.throws(() => validate(m), error);
  });
test('response integrity and bounded streaming', async (t) => {
  const dir = new URL('https://example.invalid/'),
    m = manifest();
  const fake = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(m)));
  assert.equal((await loadManifest(dir)).version, 1);
  fake.mock.mockImplementation(async () => new Response(payload));
  assert.deepEqual(await readAsset(dir, m, file), payload);
  fake.mock.mockImplementation(async () => new Response(new Uint8Array(8).fill(255)));
  await assert.rejects(readAsset(dir, m, file), /integrity/);
  fake.mock.mockImplementation(async () => new Response(new Uint8Array(7)));
  await assert.rejects(readAsset(dir, m, file), /Truncated/);
  fake.mock.mockImplementation(async () => new Response(new Uint8Array(9)));
  await assert.rejects(readAsset(dir, m, file), /byte limit/);
  fake.mock.mockImplementation(async () => new Response(null, { status: 404 }));
  await assert.rejects(loadManifest(dir), /404/);
});

import { transparentGroups, projectedBounds } from '../../frontend/src/world/transparency.ts';
test('translucent batches preserve order on shared pixels', () => {
  const near = { key: 'a', rect: [0, 0, 1, 1] },
    far = { key: 'a', rect: [0, 0, 0.1, 0.1] },
    overlap = { key: 'b', rect: [0.5, 0.5, 0.9, 0.9] },
    offscreen = { key: 'b', rect: [-1, -1, -0.5, -0.5] };
  assert.deepEqual(transparentGroups([far, offscreen, near]), [[far, near], [offscreen]]);
  assert.deepEqual(transparentGroups([far, overlap, near]), [[far], [overlap], [near]]);
  const eyePlane = new Array(16).fill(0);
  assert.deepEqual(projectedBounds([0, 0, 0, 1, 1, 1], eyePlane, 32, 32), [-1, -1, 1, 1]);
});
