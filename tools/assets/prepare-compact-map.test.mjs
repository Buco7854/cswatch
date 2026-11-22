import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { prepareCompactMap } from './prepare-compact-map.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import sharp from 'sharp';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
