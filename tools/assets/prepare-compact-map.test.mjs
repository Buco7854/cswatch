import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { compactBoundaryLocks, simplifyCompactBoundaries } from './compact-map-boundaries.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { compactSimplificationRatio, prepareCompactMap } from './prepare-compact-map.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import sharp from 'sharp';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('large compact maps target the published triangle budget before simplification', () => {
  assert.equal(compactSimplificationRatio(1_000_000), 0.22);
  // A native Dust2 input previously retained 602,471 triangles and lost its
  // whole compact tier at the final 450,000 triangle check.
  const source = 2_735_787;
  assert.ok(source * 0.22 > 450_000);
  assert.ok(source * compactSimplificationRatio(source) < 450_000);
  // Batch constraints can also overshoot just below the nominal limit.
  assert.ok(compactSimplificationRatio(2_000_000) < 0.22);
});

test('compact boundaries pin positions shared by other batches, including repeated material vertices', async () => {
  await MeshoptSimplifier.ready;
  const first = new Float32Array([0, 0, 0, 0, 0, 0, 2, 1, 0, 2, 1, 0]);
  const second = new Float32Array([2, 1, 0, 4, 0, 0, 3, 2, 0]);
  const third = new Float32Array([4, 0, 0, 6, 0, 0, 5, 2, 0]);
  assert.deepEqual(
    compactBoundaryLocks([first, second, third]).map((locks) => [...locks]),
    [
      [0, 0, 1, 1],
      [1, 1, 0],
      [1, 0, 0],
    ],
  );
});

test('shared-border simplification keeps adjacent batches and their entire common edge', async () => {
  await MeshoptSimplifier.ready;
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const length = 16;
  const batches = [];
  for (const side of [-1, 1]) {
    const positions = [],
      colors = [],
      indices = [];
    for (let y = 0; y < length; y++) {
      positions.push(0, y, 0, side, y, 0);
      colors.push(80, 100, 120, 80, 100, 120);
      const i = y * 2;
      if (y + 1 < length) indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    const attribute = (type, array) =>
      document.createAccessor().setBuffer(buffer).setType(type).setArray(array);
    const primitive = document
      .createPrimitive()
      .setIndices(attribute('SCALAR', Uint16Array.from(indices)))
      .setAttribute('POSITION', attribute('VEC3', Float32Array.from(positions)))
      .setAttribute('COLOR_0', attribute('VEC3', Uint8Array.from(colors)).setNormalized(true));
    scene.addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
    batches.push(primitive);
  }
  simplifyCompactBoundaries(document, 0.1);
  for (const primitive of batches) {
    assert.ok(primitive.getIndices().getCount() >= 3);
    const points = primitive.getAttribute('POSITION');
    const ys = new Set();
    for (let i = 0; i < points.getCount(); i++) {
      const [x, y] = points.getElement(i, []);
      if (x === 0) ys.add(y);
    }
    assert.deepEqual(
      [...ys].sort((a, b) => a - b),
      Array.from({ length }, (_, i) => i),
    );
  }
});

test('a compact tier binds its prepared source and retains placed opaque surfaces and colors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-compact-test-'));
  try {
    const source = new Document();
    const buffer = source.createBuffer();
    const world = source.createScene();
    source.getRoot().setDefaultScene(world);
    const positions = [0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4];
    const slopes = new Uint8Array(128 * 128 * 3);
    for (let offset = 0; offset < slopes.length; offset += 3) {
      slopes[offset] = 135 + (offset % 83);
      slopes[offset + 1] = 61 + (offset % 29);
      slopes[offset + 2] = 34;
    }
    const texture = source
      .createTexture()
      .setImage(
        await sharp(slopes, {
          raw: { width: 128, height: 128, channels: 3 },
        })
          .png()
          .toBuffer(),
      )
      .setMimeType('image/png');
    const material = source.createMaterial().setBaseColorTexture(texture);
    const surface = source
      .createPrimitive()
      .setMaterial(material)
      .setAttribute(
        'POSITION',
        source
          .createAccessor()
          .setBuffer(buffer)
          .setType('VEC3')
          .setArray(Float32Array.from(positions)),
      )
      .setAttribute(
        'TEXCOORD_0',
        source
          .createAccessor()
          .setBuffer(buffer)
          .setType('VEC2')
          .setArray(Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1])),
      )
      .setIndices(
        source
          .createAccessor()
          .setBuffer(buffer)
          .setType('SCALAR')
          .setArray(Uint16Array.from([0, 1, 2, 2, 3, 0])),
      );
    world.addChild(
      source
        .createNode()
        .setTranslation([10, 5, -20])
        .setMesh(source.createMesh().addPrimitive(surface)),
    );
    world.addChild(
      source
        .createNode()
        .setTranslation([100, 0, 0])
        .setExtras({
          cswatch: { kind: 'skybox', schemaVersion: 1 },
        })
        .setMesh(source.createMesh().addPrimitive(surface.clone())),
    );
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
    });
    const original = await io.writeBinary(source);
    const input = join(root, 'mobile', 'scene.glb');
    const manifest = join(root, 'mobile', 'manifest.json');
    await mkdir(join(root, 'mobile'));
    await writeFile(input, original);
    const metadata = {
      schemaVersion: 1,
      tier: 'mobile',
      map: 'de_fixture',
      assetVersion: 'fixture',
      bytes: original.length,
      outputSha256: sha256(original),
    };
    await writeFile(manifest, JSON.stringify(metadata));
    const output = join(root, 'compact');
    const result = await prepareCompactMap({ input, output, map: 'de_fixture' });
    assert.ok(result.bytes < original.length);
    assert.equal(result.sourceSha256, sha256(original));
    assert.equal(result.triangles, 2);
    const encoded = join(output, 'scene.glb');
    const verified = await verifyPreparedGlb(encoded, { compact: true });
    assert.equal(verified.sha256, result.outputSha256);
    const compact = await io.read(encoded);
    assert.equal(compact.getRoot().listTextures().length, 0);
    const bounds = getBounds(compact.getRoot().getDefaultScene());
    assert.ok(Math.abs(bounds.min[0] - 10) < 0.01 && Math.abs(bounds.max[0] - 14) < 0.01);
    assert.ok(Math.abs(bounds.min[2] + 20) < 0.01 && Math.abs(bounds.max[2] + 16) < 0.01);
    const [r, g, b] = compact
      .getRoot()
      .listMeshes()[0]
      .listPrimitives()[0]
      .getAttribute('COLOR_0')
      .getElement(0, []);
    assert.ok(r > g && g > b && b > 0);
    assert.deepEqual(await readFile(input), Buffer.from(original));
    await assert.rejects(prepareCompactMap({ input, output, map: 'de_fixture' }), {
      code: 'EEXIST',
    });
    await writeFile(manifest, JSON.stringify({ ...metadata, outputSha256: 'a'.repeat(64) }));
    await assert.rejects(
      prepareCompactMap({ input, output: join(root, 'wrong-source'), map: 'de_fixture' }),
      /does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
