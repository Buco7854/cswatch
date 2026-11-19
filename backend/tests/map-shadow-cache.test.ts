import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Bone,
  BoxGeometry,
  DirectionalLight,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
  Texture,
  type WebGLRenderer,
} from '../../frontend/node_modules/three/build/three.module.js';
import { MapShadowCache } from '../../frontend/src/map-shadow-cache.js';
import { prepareMapModel } from '../../frontend/src/map-model.js';

function fixture() {
  const cache = new MapShadowCache(),
    scene = new Scene(),
    camera = new PerspectiveCamera(),
    renderer = {
      shadowMap: { type: 2, needsUpdate: false },
      clippingPlanes: [],
      localClippingEnabled: false,
    } as unknown as WebGLRenderer,
    source = new Group(),
    mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial()),
    light = new DirectionalLight();
  source.add(mesh);
  light.castShadow = true;
  const map = prepareMapModel(source).main;
  scene.add(map, light, light.target);
  const update = () => {
    renderer.shadowMap.needsUpdate = false;
    scene.updateMatrixWorld(true);
    const changed = cache.update(scene, camera, renderer);
    assert.equal(renderer.shadowMap.needsUpdate, changed);
    return changed;
  };
  assert.equal(update(), true);
  assert.equal(update(), false);
  return { cache, scene, camera, renderer, map, light, update };
}

test('static shadow cache preserves map placement, lighting, camera-layer and late-map invalidation', () => {
  const { scene, camera, renderer, map, light, update } = fixture();
  for (let index = 0; index < 10; index++) {
    camera.position.x++;
    assert.equal(update(), false, 'Camera movement does not change a fixed directional shadow');
  }
  map.position.x += 2;
  assert.equal(update(), true);
  assert.equal(update(), false);
  const parent = new Group();
  scene.add(parent);
  parent.add(map);
  parent.scale.setScalar(2);
  assert.equal(update(), true);
  light.target.position.z++;
  assert.equal(update(), true);
  light.shadow.camera.far++;
  assert.equal(update(), true);
  light.shadow.mapSize.x *= 2;
  assert.equal(update(), true);
  light.shadow.needsUpdate = true;
  assert.equal(update(), true);
  light.shadow.needsUpdate = false;
  assert.equal(update(), false);
  camera.layers.enable(2);
  assert.equal(update(), true);
  renderer.shadowMap.type = 1;
  assert.equal(update(), true);
  map.visible = false;
  assert.equal(update(), true);
  assert.equal(update(), false);
  map.visible = true;
  assert.equal(update(), true);
  parent.remove(map);
  parent.add(prepareMapModel(new Group().add(new Mesh(new BoxGeometry()))).main);
  assert.equal(update(), true, 'Late and replacement map identities refresh cached shadows');
});

test('changing normal, instanced and skinned casters keep live shadows', () => {
  const { scene, update } = fixture(),
    material = new MeshStandardMaterial(),
    normal = new Mesh(new BoxGeometry(), material),
    instanced = new InstancedMesh(new BoxGeometry(), material, 1),
    bone = new Bone(),
    skin = new SkinnedMesh(new BoxGeometry(), material);
  skin.add(bone);
  skin.bind(new Skeleton([bone]));
  normal.castShadow = instanced.castShadow = skin.castShadow = true;
  scene.add(normal, instanced, skin);
  assert.equal(update(), true);
  assert.equal(update(), false);
  normal.position.x++;
  assert.equal(update(), true);
  assert.equal(update(), false);
  material.alphaTest = 0.4;
  assert.equal(update(), true);
  material.alphaMap = new Texture();
  assert.equal(update(), true);
  assert.equal(update(), false);
  material.alphaMap.offset.x = 0.25;
  assert.equal(update(), true, 'UV motion needs no texture-version bump');
  material.alphaMap.matrixAutoUpdate = false;
  material.alphaMap.matrix.elements[6] += 0.25;
  assert.equal(update(), true, 'Explicit UV matrices remain observable');
  normal.geometry.attributes.position.needsUpdate = true;
  assert.equal(update(), true);
  normal.geometry.morphAttributes.position = [normal.geometry.attributes.position.clone()];
  assert.equal(update(), true);
  normal.geometry.morphAttributes.position[0].needsUpdate = true;
  assert.equal(update(), true);
  instanced.instanceMatrix.needsUpdate = true;
  assert.equal(update(), true);
  bone.rotation.y += 0.1;
  assert.equal(update(), true);
  assert.equal(update(), false);
  skin.morphTargetInfluences = [0.5];
  assert.equal(update(), true);
  normal.castShadow = false;
  assert.equal(update(), true);
  instanced.visible = false;
  assert.equal(update(), true);
  scene.remove(skin);
  assert.equal(update(), true);
});

test('mutable map trees retain ordinary shadow updates without large per-mesh snapshots', () => {
  const { scene, map, update } = fixture(),
    source = new Group();
  source.add(new Mesh(new BoxGeometry()), new Bone());
  const mutable = prepareMapModel(source).main;
  scene.remove(map);
  scene.add(mutable);
  assert.equal(update(), true);
  assert.equal(update(), true);
  scene.remove(mutable);
  scene.add(map);
  assert.equal(update(), true);
  assert.equal(update(), false);
});

test('application depth callbacks retain ordinary shadow updates and external update requests survive', () => {
  const { scene, camera, renderer, cache, update } = fixture(),
    mesh = new Mesh(new BoxGeometry());
  mesh.castShadow = true;
  mesh.onBeforeShadow = () => {};
  scene.add(mesh);
  assert.equal(update(), true);
  assert.equal(update(), true);
  scene.remove(mesh);
  assert.equal(update(), true);
  assert.equal(update(), false);
  renderer.shadowMap.needsUpdate = true;
  assert.equal(cache.update(scene, camera, renderer), false);
  assert.equal(
    renderer.shadowMap.needsUpdate,
    true,
    'Another owner may explicitly request refresh',
  );
});
