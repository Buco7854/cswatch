import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { inspectEquipmentGltf } from './equipment-model-input.mjs';
import { prepareEquipmentModel } from './prepare-equipment-model.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
function fixture() {
  const bin = Buffer.alloc(28);
  bin.writeUInt16LE(1);
  bin.writeUInt16LE(2, 2);
  [1, 0, 0, 0, 1, 0].forEach((value, i) => bin.writeFloatLE(value, 4 + i * 4));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'weapon', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    buffers: [{ uri: 'sparse.bin', byteLength: 28 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 4 },
      { buffer: 0, byteOffset: 4, byteLength: 24 },
    ],
    accessors: [
      {
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        sparse: {
          count: 2,
          indices: { bufferView: 0, componentType: 5123 },
          values: { bufferView: 1 },
        },
      },
    ],
  };
  return { bin, json };
}
async function save(root, value) {
  const input = join(root, 'source.gltf');
  await writeFile(input, JSON.stringify(value.json));
  await writeFile(join(root, 'sparse.bin'), value.bin);
  return input;
}
test('bounded implicit-zero sparse native data expands exactly and publishes dense losslessly compressed accessors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-bounded-sparse-'));
  try {
    const input = await save(root, fixture());
    await inspectEquipmentGltf(input);
    const result = await prepareEquipmentModel({
      input,
      output: join(root, 'models'),
      id: 'knife',
      assetVersion: 'original-sparse-fixture',
    });
    const bytes = await readFile(result.path),
      json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
    assert.ok(json.accessors.every((accessor) => accessor.sparse === undefined));
    await MeshoptDecoder.ready;
    const document = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .read(result.path);
    const positions = document
      .getRoot()
      .listMeshes()[0]
      .listPrimitives()[0]
      .getAttribute('POSITION');
    assert.deepEqual(Array.from(positions.getArray()), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('sparse declarations reject oversized counts, invalid types, offsets and index/value view ranges before decode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-sparse-range-'));
  try {
    for (const mutate of [
      (value) => (value.json.accessors[0].count = 1000000000),
      (value) => (value.json.accessors[0].sparse.count = 4),
      (value) => (value.json.accessors[0].sparse.indices.componentType = 5126),
      (value) => (value.json.accessors[0].sparse.indices.byteOffset = 1),
      (value) => (value.json.accessors[0].sparse.values.byteOffset = 1),
      (value) => (value.json.bufferViews[0].byteLength = 2),
      (value) => (value.json.bufferViews[1].byteLength = 16),
      (value) => (value.json.bufferViews[0].byteOffset = 1),
      (value) => (value.bin = value.bin.subarray(0, 27)),
      (value) => {
        value.json.buffers.push({
          byteLength: 128 * 1024 ** 2,
          extensions: { EXT_meshopt_compression: { fallback: true } },
        });
        value.json.extensionsRequired = ['EXT_meshopt_compression'];
      },
    ]) {
      const value = fixture();
      mutate(value);
      await assert.rejects(
        () => save(root, value).then(inspectEquipmentGltf),
        /sparse|allocation|accessor|truncated|buffer/i,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('sparse payload rejects duplicate, decreasing and out-of-range indices before dense expansion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-sparse-indices-'));
  try {
    for (const indices of [
      [1, 1],
      [2, 1],
      [1, 3],
    ]) {
      const value = fixture();
      value.bin.writeUInt16LE(indices[0]);
      value.bin.writeUInt16LE(indices[1], 2);
      const input = await save(root, value);
      await assert.rejects(() => inspectEquipmentGltf(input), /strictly increasing/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
