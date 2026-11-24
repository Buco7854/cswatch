import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
} from '../../frontend/node_modules/three/build/three.module.js';
import { packEquipmentJoints } from '../../frontend/src/equipment-geometry.js';

test('mixed float and joint streams submit tightly packed exact byte and short indices shared across primitives', () => {
  for (const Component of [Uint8Array, Uint16Array]) {
    const storage = new ArrayBuffer(2 * 32);
    const indices = new Component(storage),
      stride = 32 / Component.BYTES_PER_ELEMENT;
    const maximum = Component === Uint8Array ? 255 : 65535;
    indices.set([0, 1, maximum - 1, maximum], 4);
    indices.set([maximum, maximum - 1, 1, 0], stride + 4);
    const joints = new InterleavedBufferAttribute(new InterleavedBuffer(indices, stride), 4, 4);
    const position = new InterleavedBufferAttribute(
      new InterleavedBuffer(new Float32Array(storage), 8),
      3,
      0,
    );
    const first = new BufferGeometry()
      .setAttribute('position', position)
      .setAttribute('skinIndex', joints);
    const second = new BufferGeometry().setAttribute('skinIndex', joints);
    const scene = new Group().add(new Mesh(first), new Mesh(second));
    packEquipmentJoints([scene]);
    const result = first.getAttribute('skinIndex');
    assert.ok(result instanceof BufferAttribute);
    assert.equal(result, second.getAttribute('skinIndex'));
    assert.equal(first.getAttribute('position'), position);
    assert.equal(result.array.constructor, Component);
    assert.deepEqual([...result.array], [0, 1, maximum - 1, maximum, maximum, maximum - 1, 1, 0]);
    packEquipmentJoints([scene]);
    assert.equal(first.getAttribute('skinIndex'), result);
  }
});
test('existing shared integer inputs, packed layouts and over-budget output stay as authored', () => {
  const data = new InterleavedBuffer(new Uint8Array(32), 16);
  const joints = new InterleavedBufferAttribute(data, 4, 0);
  const color = new InterleavedBufferAttribute(data, 4, 4, true);
  const shared = new BufferGeometry().setAttribute('skinIndex', joints);
  const other = new BufferGeometry().setAttribute('color', color);
  const tight = new BufferAttribute(new Uint16Array(8), 4);
  const tightGeometry = new BufferGeometry().setAttribute('skinIndex', tight);
  const large = new InterleavedBufferAttribute(
    new InterleavedBuffer(new Uint8Array((1 + 262144) * 8), 8),
    4,
    2,
  );
  const largeGeometry = new BufferGeometry().setAttribute('skinIndex', large);
  packEquipmentJoints([
    new Group().add(
      ...[shared, other, tightGeometry, largeGeometry].map((geometry) => new Mesh(geometry)),
    ),
  ]);
  assert.equal(shared.getAttribute('skinIndex'), joints);
  assert.equal(tightGeometry.getAttribute('skinIndex'), tight);
  assert.equal(largeGeometry.getAttribute('skinIndex'), large);
});
