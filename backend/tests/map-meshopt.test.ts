import assert from 'node:assert/strict';
import test from 'node:test';
import { meshoptMapFixture } from '../../tools/assets/fixtures/meshopt-map.mjs';
import { compressGlbGeometry } from '../../tools/assets/meshopt-glb.mjs';
import { MeshoptDecoder } from '../../frontend/node_modules/three-stdlib/libs/MeshoptDecoder.js';

test('bundled frontend Meshopt decoder reproduces every original mixed-attribute and index buffer exactly', async () => {
  const original = Buffer.from(await meshoptMapFixture()),
    compressed = (await compressGlbGeometry(original)).bytes,
    decoder = MeshoptDecoder();
  await decoder.ready;
  const read = (bytes: Buffer) => {
      const length = bytes.readUInt32LE(12);
      return { json: JSON.parse(bytes.subarray(20, 20 + length).toString()), start: 28 + length };
    },
    source = read(original),
    packed = read(compressed);
  let count = 0;
  for (let index = 0; index < packed.json.bufferViews.length; index++) {
    const view = packed.json.bufferViews[index],
      extension = view.extensions?.EXT_meshopt_compression;
    if (!extension) continue;
    const decoded = new Uint8Array(extension.count * extension.byteStride);
    decoder.decodeGltfBuffer(
      decoded,
      extension.count,
      extension.byteStride,
      new Uint8Array(
        compressed.buffer,
        compressed.byteOffset + packed.start + extension.byteOffset,
        extension.byteLength,
      ),
      extension.mode,
      extension.filter,
    );
    const previous = source.json.bufferViews[index],
      expected = original.subarray(
        source.start + (previous.byteOffset || 0),
        source.start + (previous.byteOffset || 0) + previous.byteLength,
      );
    assert.deepEqual(
      Buffer.from(decoded),
      expected,
      `Frontend decoder differs in original buffer view ${index}`,
    );
    count++;
  }
  assert.ok(count >= 2, 'Original fixture covers both mixed vertex attributes and32bit indices');
});
