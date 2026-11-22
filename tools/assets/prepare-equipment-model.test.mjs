import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import {
  selectedEquipmentModels,
  equipmentModelRegistry,
  equipmentModelIds,
} from './equipment-model-registry.mjs';
import {
  assertEquipmentWeaponBounds,
  inspectEquipmentGltf,
  prepareEquipmentModel,
} from './prepare-equipment-model.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { staticModelBounds } from './static-model-bounds.mjs';
async function fixture(root) {
  const document = new Document(),
    buffer = document.createBuffer(),
    scene = document.createScene();
  const positions = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 0, 0, 1, 0, 0.2, 0]))
    .setBuffer(buffer);
  const pixels = Buffer.alloc(64 * 32 * 4);
  for (let i = 0; i < 64 * 32; i++)
    pixels.set(i % 2 ? [115, 98, 79, 255] : [45, 72, 110, 255], i * 4);
  const texture = document
    .createTexture()
    .setImage(
      await sharp(pixels, { raw: { width: 64, height: 32, channels: 4 } })
        .png()
        .toBuffer(),
    )
    .setMimeType('image/png');
  const material = document.createMaterial('native material').setBaseColorTexture(texture);
  const uv = document
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', positions)
    .setAttribute('TEXCOORD_0', uv)
    .setMaterial(material);
  // A studio preview translation separate from the local geometry, as in the M4A4.
  const studio = [-0.004903525, 0.3150511, 0.46316564];
  scene.addChild(
    document
      .createNode('body')
      .setTranslation(studio)
      .setMesh(document.createMesh().addPrimitive(primitive)),
  );
  scene.addChild(
    document.createNode('weapon').setTranslation(studio).setRotation([-0.5, -0.5, -0.5, 0.5]),
  );
  const input = join(root, 'input.glb');
  await new NodeIO().write(input, document);
  return input;
}
test('fixed registry selects real source identities and rejects arbitrary names/duplicates', () => {
  assert.equal(equipmentModelRegistry.m4a1.resource, 'weapons/models/m4a4/weapon_rif_m4a4.vmdl_c');
  assert.equal(
    equipmentModelRegistry.incgrenade.resource,
    'weapons/models/grenade/incendiary/weapon_incendiarygrenade.vmdl_c',
  );
  assert.ok(equipmentModelIds.length <= 96);
  assert.deepEqual(selectedEquipmentModels('ak47,smokegrenade'), ['ak47', 'smokegrenade']);
  for (const value of ['../private', 'https://example.test/a', 'ak47,ak47', '', undefined])
    assert.throws(() => selectedEquipmentModels(value));
});
test('equipment publication retains an authored muzzle node and its independent native source evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-equipment-muzzle-'));
  try {
    const input = await fixture(root),
      nativeMuzzle = {
        bone: 'weapon',
        position: [20, 2, 4],
        rotation: [0, 0, 0, 1],
      },
      result = await prepareEquipmentModel({
        input,
        output: join(root, 'output'),
        id: 'ak47',
        assetVersion: 'original-muzzle-test',
        nativeMuzzle,
      });
    assert.deepEqual(result.provenance.nativeMuzzle, {
      ...nativeMuzzle,
      units: 'source-inches',
      node: 'cswatch_native_muzzle',
    });
    const glb = await readFile(result.path),
      json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12))),
      markerIndex = json.nodes.findIndex((node) => node.name === 'cswatch_native_muzzle'),
      marker = json.nodes[markerIndex],
      bone = json.nodes.find((node) => node.name === 'weapon');
    assert.ok(markerIndex >= 0);
    assert.ok(bone.children.includes(markerIndex));
    assert.deepEqual(marker.translation, [0.508, 0.0508, 0.1016]);
    assert.equal(marker.extras.cswatchNativeAttachment, 'muzzle_flash');
    assert.equal(result.manifest.schemaVersion, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('equipment packing removes the authored studio translation, bounds textures, retains native dimensions and refuses overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-equipment-model-'));
  try {
    const input = await fixture(root),
      output = join(root, 'output');
    const result = await prepareEquipmentModel({
      input,
      output,
      id: 'ak47',
      assetVersion: 'original-test',
    });
    assert.equal(result.manifest.coordinateSystem, 'weapon-meters-y-up-x-forward');
    assert.equal(result.manifest.schemaVersion, 2);

    assert.ok(
      result.manifest.decodedTextureBytes > 0 &&
        result.manifest.decodedTextureBytes <= 16 * 1024 ** 2,
    );
    assert.ok(result.manifest.geometryBytes <= 8 * 1024 ** 2);
    assert.ok(result.manifest.bounds.max[0] > 0.9999 && result.manifest.bounds.max[0] < 1.0001);
    assert.ok(Math.abs(result.manifest.bounds.max[1] - 0.2) < 1e-6);
    assert.ok(result.manifest.bytes < 16 * 1024 ** 2);
    await MeshoptDecoder.ready;
    const doc = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .read(result.path);
    assert.equal(doc.getRoot().listAnimations().length, 0);
    assert.equal(doc.getRoot().listSkins().length, 0);
    assert.deepEqual(
      Array.from(
        doc
          .getRoot()
          .listAccessors()
          .find((x) => x.getType() === 'VEC3')
          .getArray(),
      ),
      [0, 0, 0, 0, 0, 1, 0, Math.fround(0.2), 0],
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8')),
      result.manifest,
    );
    await assert.rejects(
      () => prepareEquipmentModel({ input, output, id: 'ak47', assetVersion: 'replacement' }),
      /EEXIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('equipment input rejects remote/traversal resources and symlinks before NodeIO resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-equipment-uri-'));
  try {
    for (const uri of [
      'https://example.test/a.bin',
      '../outside.bin',
      '%2e%2e/secret',
      '/absolute.bin',
      'a\\b.bin',
      'data:application/octet-stream;base64,AAAA',
    ]) {
      const input = join(root, 'unsafe.gltf');
      await writeFile(
        input,
        JSON.stringify({
          asset: { version: '2.0' },
          buffers: [{ uri, byteLength: 12 }],
          bufferViews: [{ buffer: 0, byteLength: 12 }],
          accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 1 }],
        }),
      );
      await assert.rejects(() => inspectEquipmentGltf(input), /local|path/);
    }
    const source = await fixture(root),
      link = join(root, 'linked.glb');
    await symlink(source, link);
    await assert.rejects(() => inspectEquipmentGltf(link));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('raw metadata rejects excessive accessor, sparse and Meshopt allocations before NodeIO reads buffers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-equipment-allocation-'));
  try {
    const input = await fixture(root),
      bytes = await readFile(input),
      base = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
    for (const mutate of [
      (json) => {
        json.accessors[0].count = 1000000000;
      },
      (json) => {
        json.accessors[0].sparse = {
          count: 1000000000,
          indices: { bufferView: 0, componentType: 5125 },
          values: { bufferView: 0 },
        };
      },
      (json) => {
        json.bufferViews[0].extensions = {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: 0,
            byteLength: 4,
            byteStride: 12,
            count: 1000000000,
            mode: 'ATTRIBUTES',
          },
        };
      },
    ]) {
      const json = structuredClone(base);
      mutate(json);
      const path = join(root, 'oversized.gltf');
      await writeFile(path, JSON.stringify(json));
      await assert.rejects(() => inspectEquipmentGltf(path), /accessor|Meshopt|buffer/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the pre-normalization M4A4 bounds fail the weapon frame check', () => {
  assert.throws(
    () =>
      assertEquipmentWeaponBounds({
        min: [0.03530949, 0.10220745, -0.04741227],
        max: [0.93167426, 0.39421043, 0.04388749],
      }),
    /outside the authored weapon frame/,
  );
});

const realPack = process.env.CSWATCH_EQUIPMENT_TEST_PACK;
test(
  'every model in the genuine fixed registry is packed in its own weapon frame',
  { skip: !realPack },
  async () => {
    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    for (const id of equipmentModelIds) {
      const manifest = JSON.parse(await readFile(join(realPack, id, 'manifest.json'), 'utf8'));
      const document = await io.read(join(realPack, id, 'model.glb'));
      const bounds = staticModelBounds(document);
      assert.equal(manifest.schemaVersion, 2, id);
      assertEquipmentWeaponBounds(bounds);
      for (const axis of [0, 1, 2])
        for (const edge of ['min', 'max'])
          assert.ok(Math.abs(bounds[edge][axis] - manifest.bounds[edge][axis]) < 1e-5, id);
      if (id === 'defuser') continue;
      const joint = document
        .getRoot()
        .listNodes()
        .find((node) => node.getName() === 'weapon');
      assert.ok(joint, id);
      assert.ok(Math.hypot(...joint.getWorldTranslation()) < 1e-6, id);
      // The Source bone still has its native local axes inside the Y-up pack.
      const world = joint.getWorldMatrix();
      assert.ok(Math.abs(world[0] - 1) < 1e-6 && Math.abs(world[9] - 1) < 1e-6, id);
    }
  },
);
