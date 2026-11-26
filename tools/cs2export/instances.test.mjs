import assert from 'node:assert/strict';
import test from 'node:test';
import { instanceKey, placementAttributes, writeInstance } from './instances.mjs';
import { stride } from './geometry.mjs';

function range(overrides = {}) {
  const v = Buffer.alloc(3 * stride);
  for (let i = 0; i < 3; i++) v.writeFloatLE(i, i * stride);
  return {
    v,
    indices: Buffer.from(new Uint32Array([0, 1, 2]).buffer),
    mat: 1,
    family: 'opaque',
    side: false,
    sky: false,
    entityIndex: -1,
    ...overrides,
  };
}
test('copies differing only in lighting and tint share a key', () => {
  const a = range(),
    b = range();
  b.v.writeUInt16LE(7, 50);
  b.v.writeUInt16LE(9, 54);
  b.v.writeUInt32LE(0xff00ff00, 56);
  assert.equal(instanceKey(a), instanceKey(b));
  assert.deepEqual(placementAttributes(b.v), [7, 0, 9, 0xff00ff00]);
  const moved = range();
  moved.v.writeFloatLE(5, 0);
  assert.notEqual(instanceKey(a), instanceKey(moved));
  assert.notEqual(instanceKey(a), instanceKey(range({ mat: 2 })));
  const baked = range();
  baked.v[52] = 1;
  assert.notEqual(instanceKey(a), instanceKey(baked));
});
test('entities and translucent families are not instanced', () => {
  assert.equal(instanceKey(range({ entityIndex: 0 })), null);
  assert.equal(instanceKey(range({ family: 'glass' })), null);
  assert.ok(instanceKey(range({ family: 'cutout' })));
});
test('instance records hold transform rows, lighting indices and tint', () => {
  const table = Buffer.alloc(64);
  // Column-major translation (1, 2, 3) with a doubled X axis.
  writeInstance(
    table,
    0,
    [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
    [5, 1, 40000, 0x80402010],
  );
  const words = new Float32Array(table.buffer, 0, 12);
  assert.deepEqual([...words], [2, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3]);
  assert.equal(table.readUInt32LE(48), 5 + 40000 * 65536);
  assert.equal(table.readUInt32LE(52), 0x80402010);
});
