import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnimationClip,
  NumberKeyframeTrack,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Texture,
} from '../../frontend/node_modules/three/build/three.module.js';
import {
  equipmentModelResources,
  mapModelResources,
  modelDecodedBuffers,
  retainEquipmentModel,
} from '../../frontend/src/map-model-resources.js';
import type { GLTF } from '../../frontend/node_modules/three-stdlib/loaders/GLTFLoader.js';

test('retained model estimate counts aliased bitmap and geometry buffers once, plus source binary and copied image views', () => {
  const scene = new Group(),
    geometry = new BufferGeometry(),
    positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    bitmap = { width: 16, height: 32 },
    texture = new Texture(bitmap),
    copy = texture.clone(),
    first = new MeshStandardMaterial({ map: texture }),
    second = new MeshStandardMaterial({ map: copy });
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  scene.add(new Mesh(geometry, first), new Mesh(geometry, second));
  const json = {
      buffers: [{ byteLength: 100 }],
      images: [{ bufferView: 0 }, { bufferView: 0 }],
      bufferViews: [{ byteLength: 20 }],
    },
    parser = { json },
    resources = mapModelResources({ scene, scenes: [scene], parser } as unknown as GLTF),
    byKey = new Map(resources.map((resource) => [resource.key, resource]));
  assert.equal(byKey.get(bitmap)!.bytes, 16 * 32 * 4);
  assert.equal(resources.filter((resource) => resource.key === bitmap).length, 1);
  assert.equal(byKey.get(positions.buffer)!.bytes, positions.buffer.byteLength);
  assert.equal(byKey.get(parser)!.bytes, 120 + JSON.stringify(json).length * 4);
  let geometries = 0,
    textures = 0,
    materials = 0;
  geometry.addEventListener('dispose', () => geometries++);
  texture.addEventListener('dispose', () => textures++);
  copy.addEventListener('dispose', () => textures++);
  first.addEventListener('dispose', () => materials++);
  second.addEventListener('dispose', () => materials++);
  for (const resource of resources) resource.dispose?.();
  assert.equal(geometries, 1);
  assert.equal(textures, 2);
  assert.equal(materials, 2);
});

test('actor animation buffers are bounded and aliased track arrays count only once', () => {
  const scene = new Group(),
    track = new NumberKeyframeTrack('.position[x]', [0, 1], [0, 2]),
    alias = new NumberKeyframeTrack('.position[y]', [0, 1], [0, 2]);
  alias.times = track.times;
  alias.values = track.values;
  const gltf = {
    scene,
    scenes: [scene],
    animations: [new AnimationClip('idle', 1, [track, alias])],
    parser: { json: {} },
  } as unknown as GLTF;
  const resources = mapModelResources(gltf);
  assert.equal(resources.filter((resource) => resource.key === track.times.buffer).length, 1);
  assert.equal(
    resources.find((resource) => resource.key === track.times.buffer)?.bytes,
    track.times.buffer.byteLength,
  );
  assert.equal(resources.filter((resource) => resource.key === track.values.buffer).length, 1);
  assert.equal(
    resources.find((resource) => resource.key === track.values.buffer)?.bytes,
    track.values.buffer.byteLength,
  );
});

test('required meshopt layouts charge decoded backing stores once, including views retained only by the parser', () => {
  const scene = new Group(),
    geometry = new BufferGeometry(),
    positions = new Float32Array(30),
    skin = new Uint8Array(64);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  scene.add(new Mesh(geometry, new MeshStandardMaterial()));
  const fallback = { EXT_meshopt_compression: { fallback: true } };
  const json = {
    extensionsRequired: ['EXT_meshopt_compression'],
    buffers: [
      { byteLength: 100 },
      { byteLength: 1000, extensions: fallback },
      { uri: 'backed.bin', byteLength: 60, extensions: fallback },
    ],
  };
  const parser = { json },
    gltf = { scenes: [scene], parser } as unknown as GLTF;
  modelDecodedBuffers.set(gltf, new Set([positions.buffer, skin.buffer]));
  const byKey = new Map(mapModelResources(gltf).map((resource) => [resource.key, resource.bytes]));
  assert.equal(byKey.get(positions.buffer), positions.byteLength);
  assert.equal(byKey.get(skin.buffer), skin.byteLength);
  assert.equal(byKey.get(parser), 160 + JSON.stringify(json).length * 4);
});

test('ready equipment retains render data and authored material and clip evidence without retaining the loader', () => {
  const scene = new Group();
  const material = new MeshStandardMaterial();
  const positions = new Float32Array(9);
  const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3));
  scene.add(new Mesh(geometry, material));
  const unused = new Texture();
  const json = {
    buffers: [{ byteLength: 1_000_000 }],
    materials: [{ pbrMetallicRoughness: {} }],
    animations: [{ name: 'reload' }],
  };
  const parser = { json, associations: new Map([[material, { materials: 0 }]]) };
  const gltf = { scene, scenes: [scene], animations: [], parser } as unknown as GLTF;
  gltf.parser.associations.set(unused, { textures: 1 });
  const retained = retainEquipmentModel(gltf);
  assert.equal(retained.scene, scene);
  assert.equal(retained.animations, gltf.animations);
  assert.notEqual(retained.parser, parser);
  assert.deepEqual(retained.parser.json, {
    materials: json.materials,
    animations: json.animations,
  });
  assert.equal(retained.parser.associations.get(material)?.materials, 0);
  assert.equal(retained.parser.associations.has(unused), false);
  const resources = equipmentModelResources(retained);
  assert.equal(resources.find((row) => row.key === positions.buffer)?.bytes, positions.byteLength);
  assert.equal(
    resources.find((row) => row.key === retained.parser)?.bytes,
    JSON.stringify(retained.parser.json).length * 4,
  );
  assert.equal(
    resources.some((row) => row.key === parser),
    false,
  );
});
