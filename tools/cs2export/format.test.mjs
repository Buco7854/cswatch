import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadManifest, readAsset, validate } from '../../frontend/src/world/format.ts';

const payload = new Uint8Array(8),
  hash = createHash('sha256').update(payload).digest('hex'),
  file = hash + '.bin',
  phonePayload = new Uint8Array(16),
  phoneHash = createHash('sha256').update(phonePayload).digest('hex'),
  phoneFile = phoneHash + '.bin';
function manifest() {
  const bounds = [0, 0, 0, 1, 1, 1];
  return {
    format: 'cswatch-native-world',
    version: 3,
    units: 'inches',
    up: 'Z',
    bounds,
    roles: ['color'],
    geometry: { stride: 60, vertices: 3, indices: 3, vb: file, ib: file },
    files: {
      [file]: { size: 8, sha256: hash, category: 'textures' },
      [phoneFile]: { size: 16, sha256: phoneHash, category: 'textures' },
    },
    chunks: [
      {
        bounds,
        banks: [0],
        ranges: [
          {
            first: 0,
            count: 3,
            bounds,
            material: 0,
            entity: -1,
            vertices: 3,
            uvBounds: [0, 0, 1, 1],
            positionGrid: [0, 0, 0, 1, 1, 1],
            attributes: [0, 0, 0, 0],
            streams: [[0, 8, 0], [0, 8, 0], [0, 8, 0], null, null, null, null],
          },
        ],
      },
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
    phone: {
      arrays: [
        {
          file: phoneFile,
          format: 'ASTC6x6',
          textures: ['grass'],
          mips: [{ w: 4, h: 4, level: 0, offset: 0, size: 16 }],
        },
      ],
      specials: {},
      hdr: {},
      lightmaps: {},
      volumes: {},
    },
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
  assert.equal((await loadManifest(dir)).version, 3);
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

import { transposeBlocks } from '../../frontend/src/world/block-layout.mjs';
import { trianglePredictors, predictWords } from '../../frontend/src/world/mesh-prediction.mjs';
test('BC lane transpose retains partial pages of original blocks', () => {
  const input = Uint8Array.from({ length: 16 * 4099 }, (_, i) => (i * 13 + (i % 17)) & 255);
  for (const stride of [8, 16])
    assert.deepEqual(transposeBlocks(transposeBlocks(input, stride, false), stride, true), input);
});
test('topology prediction survives triangle rotation and unsigned arithmetic wrap', () => {
  const encoded = trianglePredictors([0, 1, 2, 2, 1, 3], 4),
    decoded = trianglePredictors([1, 2, 0, 1, 3, 2], 4);
  for (const Type of [Uint8Array, Uint16Array]) {
    const values = Type.of(1, 255, 7, 19, 250, 31, 5, 0),
      words = values.slice();
    predictWords(words, 2, encoded, true);
    predictWords(words, 2, decoded, false);
    assert.deepEqual(words, values);
  }
});
test('mip pages require complete block rows inside verified payloads', () => {
  const m = manifest(),
    mip = m.arrays[0].mips[0];
  mip.file = file;
  assert.equal(validate(m), m);
  mip.offset = 1;
  assert.throws(() => validate(m), /page layout/);
  mip.offset = 0;
  mip.file = 'missing';
  assert.throws(() => validate(m), /page layout/);
});
