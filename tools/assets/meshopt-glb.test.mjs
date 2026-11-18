import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compressGlbGeometry, MeshoptDecoder } from './meshopt-glb.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { meshoptMapFixture } from './fixtures/meshopt-map.mjs';
import { compressPreparedGeometry } from './compress-prepared-map.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const raw = (accessor) => {
  const a = accessor.getArray();
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
};
function metadata(bytes) {
  const n = bytes.readUInt32LE(12);
  return {
    data: JSON.parse(bytes.subarray(20, 20 + n).toString('utf8')),
    bin: bytes.subarray(28 + n),
  };
}
function mutate(bytes, change) {
  const { data, bin } = metadata(Buffer.from(bytes));
  change(data);
  const json = Buffer.from(JSON.stringify(data)),
    padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)]),
    header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(bin.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, bin]);
}
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-meshopt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('lossless Meshopt meaningfully shrinks original multi-vertex geometry and preserves exact attributes/indices/tags/images', async (t) => {
  const root = await scratch(t),
    original = await meshoptMapFixture(),
    result = await compressGlbGeometry(original);
  assert.ok(result.bytes.length < original.length * 0.75);
  assert.ok(result.report.compressedViews > 0);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  await MeshoptDecoder.ready;
  const before = await io.readBinary(original),
    after = await io.readBinary(result.bytes);
  const expected = new Map(
    before
      .getRoot()
      .listAccessors()
      .map((a) => [a.getName(), a]),
  );
  for (const accessor of after.getRoot().listAccessors()) {
    const prior = expected.get(accessor.getName());
    assert.equal(accessor.getType(), prior.getType());
    assert.equal(accessor.getComponentType(), prior.getComponentType());
    assert.equal(accessor.getNormalized(), prior.getNormalized());
    assert.deepEqual(raw(accessor), raw(prior));
  }
  for (const node of before.getRoot().listNodes()) {
    const paired = after
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === node.getName());
    assert.deepEqual(paired.getExtras(), node.getExtras());
    assert.deepEqual(paired.getMatrix(), node.getMatrix());
  }
  assert.deepEqual(
    after.getRoot().listTextures()[0].getImage(),
    before.getRoot().listTextures()[0].getImage(),
  );
  const path = join(root, 'compressed.glb');
  await writeFile(path, result.bytes);
  assert.equal((await verifyPreparedGlb(path)).sha256, hash(result.bytes));
  const info = metadata(result.bytes).data;
  assert.ok(info.extensionsRequired.includes('EXT_meshopt_compression'));
  assert.ok(
    info.bufferViews.some((view) => view.extensions?.EXT_meshopt_compression?.mode === 'INDICES'),
  );
});

test('required virtual fallback validates real compressed data and rejects bad references/strides/counts/external buffers', async (t) => {
  const root = await scratch(t),
    encoded = (await compressGlbGeometry(await meshoptMapFixture())).bytes;
  for (const change of [
    (d) => (d.buffers[1].uri = 'https://example.test/buffer'),
    (d) => delete d.extensionsRequired,
    (d) =>
      d.bufferViews.find((v) => v.extensions?.EXT_meshopt_compression).extensions
        .EXT_meshopt_compression.count++,
    (d) =>
      (d.bufferViews.find(
        (v) => v.extensions?.EXT_meshopt_compression,
      ).extensions.EXT_meshopt_compression.byteOffset = 0x7fffffff),
    (d) =>
      (d.bufferViews.find(
        (v) => v.extensions?.EXT_meshopt_compression,
      ).extensions.EXT_meshopt_compression.byteStride = 3),
    (d) => (d.accessors[0].count = 0x7fffffff),
    (d) => (d.images[0].bufferView = d.bufferViews.findIndex((v) => v.buffer === 1)),
  ]) {
    const file = join(root, 'invalid.glb');
    await writeFile(file, mutate(encoded, change));
    await assert.rejects(verifyPreparedGlb(file));
  }
  const broken = Buffer.from(encoded),
    info = metadata(broken),
    view = info.data.bufferViews.find((v) => v.extensions?.EXT_meshopt_compression).extensions
      .EXT_meshopt_compression;
  broken[broken.length - info.bin.length + view.byteOffset] = 0;
  const path = join(root, 'broken.glb');
  await writeFile(path, broken);
  await assert.rejects(verifyPreparedGlb(path), /decoding/);
});

test('geometry-only output preserves original encoded image bytes and refuses overwriting source', async (t) => {
  const root = await scratch(t),
    source = join(root, 'source'),
    target = join(root, 'compressed');
  await mkdir(source);
  const bytes = await meshoptMapFixture(),
    input = join(source, 'scene.glb');
  await writeFile(input, bytes);
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      map: 'de_qa',
      tier: 'desktop',
      bytes: bytes.length,
      assetVersion: 'fixture',
      outputSha256: hash(bytes),
    }),
  );
  const result = await compressPreparedGeometry({
    input,
    output: target,
    map: 'de_qa',
    tier: 'desktop',
  });
  assert.ok(result.manifest.bytes < bytes.length * 0.75);
  const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder }),
    a = await io.read(input),
    b = await io.read(result.path);
  assert.deepEqual(
    a.getRoot().listTextures()[0].getImage(),
    b.getRoot().listTextures()[0].getImage(),
  );
  assert.deepEqual(await readFile(input), Buffer.from(bytes));
  await assert.rejects(
    compressPreparedGeometry({ input, output: source, map: 'de_qa', tier: 'desktop' }),
    /new tier/,
  );
});
