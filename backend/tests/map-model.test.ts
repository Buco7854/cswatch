import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmbientLight,
  AnimationClip,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  DirectionalLight,
  DataTexture,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Matrix4,
  PointLight,
  SkinnedMesh,
  Texture,
} from '../../frontend/node_modules/three/build/three.module.js';
import {
  assertMapBaseColorTextures,
  cloneMapModel,
  prepareMapModel,
} from '../../frontend/src/map-model.js';

test('map clones suppress nested exported lights before rendering without changing the cached asset', () => {
  const scene = new Group(),
    nested = new Group(),
    sun = new DirectionalLight(0xffffff, 2049),
    point = new PointLight(0xff8800, 9000),
    ambient = new AmbientLight(0xffffff, 100),
    mesh = new Mesh();
  nested.add(sun, point, mesh);
  scene.add(nested, ambient);
  const copy = cloneMapModel(scene);
  const lights: number[] = [];
  copy.traverse((object) => {
    if (
      object instanceof AmbientLight ||
      object instanceof DirectionalLight ||
      object instanceof PointLight
    ) {
      assert.equal(object.visible, false);
      assert.equal(object.intensity, 0);
      lights.push(object.id);
    }
    if (object instanceof Mesh) {
      assert.equal(object.castShadow, true);
      assert.equal(object.receiveShadow, true);
    }
  });
  assert.equal(lights.length, 3);
  assert.equal(sun.intensity, 2049);
  assert.equal(point.intensity, 9000);
  assert.equal(ambient.intensity, 100);
  assert.equal(sun.visible, true);
  assert.equal(mesh.castShadow, false);
});

test('native sky tags extract complete transformed roots without changing the cached map or matching names', () => {
  const scene = new Group(),
    parent = new Group(),
    sky = new Group(),
    mesh = new Mesh(),
    named = new Group();
  parent.position.set(2, 3, 4);
  parent.rotation.y = 0.4;
  parent.scale.set(2, 1, 2);
  sky.position.set(3, 4, 5);
  sky.scale.setScalar(16);
  sky.userData.cswatch = { kind: 'skybox', schemaVersion: 1 };
  sky.name = 'Original tagged sky';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  sky.add(mesh);
  parent.add(sky);
  scene.add(parent, named);
  named.name = 'cswatch_skybox';
  scene.updateMatrixWorld(true);
  const expected = new Matrix4().makeRotationY(Math.PI / 2).multiply(sky.matrixWorld),
    prepared = prepareMapModel(scene),
    extracted = prepared.sky!.getObjectByName(sky.name)!;
  assert.ok(prepared.sky);
  assert.equal(prepared.main.getObjectByName(sky.name), undefined);
  assert.ok(
    prepared.main.getObjectByName('cswatch_skybox'),
    'A name alone never classifies sky geometry',
  );
  extracted.matrixWorld.elements.forEach((value, index) =>
    assert.ok(Math.abs(value - expected.elements[index]) < 1e-8),
  );
  extracted.traverse((object) => {
    if (object instanceof Mesh) {
      assert.equal(object.castShadow, false);
      assert.equal(object.receiveShadow, false);
    }
  });
  assert.equal(sky.parent, parent);
  assert.equal(mesh.castShadow, true);
});

test('map preparation retains one sky-only authored sun without adding sky lights or updating the cached source', () => {
  const scene = new Group(),
    sky = new Group(),
    sun = new DirectionalLight();
  sky.name = 'Original QA sky';
  sky.userData.cswatch = { kind: 'skybox', schemaVersion: 1 };
  sky.position.set(120, 30, -80);
  sky.rotation.x = -Math.PI / 3;
  sky.scale.setScalar(16);
  sun.name = 'Original QA sun';
  sun.userData.name = 'light_environment';
  sun.color.setRGB(0.7, 0.5, 0.4);
  sun.intensity = 3500;
  sky.add(sun);
  scene.add(sky);
  const originals = [scene, sky, sun].map((node) => ({
      local: node.matrix.clone(),
      world: node.matrixWorld.clone(),
      parent: node.parent,
    })),
    prepared = prepareMapModel(scene);
  assert.ok(prepared.sun, 'The main view retains sun evidence that was authored only in the sky');
  prepared.sun.directionToSun.forEach((value, index) =>
    assert.ok(Math.abs(value - [0.5, Math.sqrt(3) / 2, 0][index]) < 1e-10),
  );
  assert.deepEqual(prepared.sun.color, [0.7, 0.5, 0.4]);
  assert.equal(prepared.main.getObjectByName(sun.name), undefined);
  const extracted = prepared.sky!.getObjectByName(sun.name)! as DirectionalLight;
  assert.equal(extracted.visible, false);
  assert.equal(extracted.intensity, 0);
  const lights: DirectionalLight[] = [];
  prepared.sky!.traverse((node) => {
    if (node instanceof DirectionalLight) lights.push(node);
    assert.equal(
      node instanceof AmbientLight,
      false,
      'Shared scene lighting owns sky illumination',
    );
  });
  assert.deepEqual(lights, [extracted], 'No extra generic sun is inserted into the landscape');
  [scene, sky, sun].forEach((node, index) => {
    assert.deepEqual(node.matrix, originals[index].local);
    assert.deepEqual(node.matrixWorld, originals[index].world);
    assert.equal(node.parent, originals[index].parent);
  });
  assert.equal(sun.intensity, 3500);
  assert.equal(sun.visible, true);
});

test('main and sky sun conflicts share one fallback decision before sky extraction', () => {
  const scene = new Group(),
    sky = new Group(),
    mainSun = new DirectionalLight(),
    skySun = new DirectionalLight();
  sky.userData.cswatch = { kind: 'skybox', schemaVersion: 1 };
  mainSun.userData.name = skySun.userData.name = 'light_environment';
  mainSun.color.setRGB(0.7, 0.6, 0.4);
  skySun.color.copy(mainSun.color);
  mainSun.rotation.x = skySun.rotation.x = -0.8;
  sky.add(skySun);
  scene.add(mainSun, sky);
  assert.ok(prepareMapModel(scene).sun, 'Agreeing main and sky suns share authored lighting');
  skySun.color.g += 0.01;
  assert.equal(
    prepareMapModel(scene).sun,
    null,
    'Reparenting must not hide a source color conflict',
  );
  skySun.color.copy(mainSun.color);
  skySun.rotation.y += 0.1;
  assert.equal(
    prepareMapModel(scene).sun,
    null,
    'Reparenting must not hide a source pose conflict',
  );
});

test('main-only source sun includes the existing coordinate rotation once and missing evidence stays unavailable', () => {
  const scene = new Group(),
    sun = new DirectionalLight();
  assert.deepEqual(prepareMapModel(scene).sun, null);
  sun.userData.name = 'light_environment';
  sun.color.setRGB(0.8, 0.7, 0.6);
  scene.add(sun);
  const prepared = prepareMapModel(scene);
  assert.equal(prepared.sky, null);
  assert.ok(prepared.sun);
  prepared.sun.directionToSun.forEach((value, index) =>
    assert.ok(Math.abs(value - [1, 0, 0][index]) < 1e-10),
  );
  assert.deepEqual(prepared.sun.color, [0.8, 0.7, 0.6]);
});

test('map readiness requires decoded base-color images by material association, including identical names', () => {
  const scene = new Group(),
    plain = new MeshStandardMaterial(),
    textured = new MeshStandardMaterial(),
    evidence = {
      scene,
      parser: {
        json: { materials: [{}, { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }] },
        associations: new Map([
          [plain, { materials: 0 }],
          [textured, { materials: 1 }],
        ]),
      },
    };
  plain.name = textured.name = 'Identical original QA names';
  scene.add(new Mesh(undefined, plain), new Mesh(undefined, textured));
  assert.throws(() => assertMapBaseColorTextures(evidence), /base color texture failed/);
  textured.map = new Texture();
  assert.throws(() => assertMapBaseColorTextures(evidence), /base color texture failed/);
  textured.map = new DataTexture(new Uint8Array([202, 73, 48, 255]), 1, 1);
  assert.doesNotThrow(() => assertMapBaseColorTextures(evidence));
  scene.remove(scene.children[1]);
  assert.doesNotThrow(
    () => assertMapBaseColorTextures(evidence),
    'An unused textured material does not reject a plain scene',
  );
});

test('static map placement avoids repeated descendant updates and follows moved roots and ancestors', () => {
  const source = new Group(),
    nested = new Group(),
    mesh = new Mesh(),
    world = new Group();
  source.position.set(2, 3, 5);
  nested.position.set(-2, 7, 4);
  nested.rotation.set(0.3, 0.5, 0.1);
  nested.scale.set(2, 3, 4);
  mesh.name = 'Original immutable map mesh';
  mesh.position.set(1, 4, 2);
  nested.add(mesh);
  source.add(nested);
  const prepared = prepareMapModel(source),
    plain = new Group();
  plain.rotation.y = Math.PI / 2;
  plain.add(source.clone(true));
  world.add(prepared.main, plain);
  let descendantUpdates = 0;
  const actual = prepared.main.getObjectByName(mesh.name)!;
  const originalUpdate = actual.updateMatrixWorld;
  actual.updateMatrixWorld = function (force) {
    descendantUpdates++;
    originalUpdate.call(this, force);
  };
  const sameWorld = () => {
    world.updateMatrixWorld(true);
    assert.deepEqual(
      actual.matrixWorld.elements,
      plain.getObjectByName(mesh.name)!.matrixWorld.elements,
    );
  };
  sameWorld();
  descendantUpdates = 0;
  for (let index = 0; index < 10; index++) sameWorld();
  assert.equal(
    descendantUpdates,
    0,
    'Unchanged map descendants are not updated during forced scene traversals',
  );
  world.position.set(-1, 4, 2);
  world.rotation.x = 0.4;
  sameWorld();
  assert.equal(descendantUpdates, 1);
  prepared.main.position.set(4, 6, -5);
  plain.position.copy(prepared.main.position);
  sameWorld();
  assert.equal(descendantUpdates, 2);
  const other = new Group();
  other.position.set(-8, 1, 3);
  other.scale.set(2, 1, 2);
  world.add(other);
  other.add(prepared.main, plain);
  sameWorld();
  assert.equal(descendantUpdates, 3);
  assert.equal(mesh.matrixAutoUpdate, true, 'The cached original asset is never frozen');
  assert.equal(actual.matrixAutoUpdate, false);
  assert.equal((actual as Mesh).geometry, mesh.geometry);
  assert.equal((actual as Mesh).material, mesh.material);
  assert.equal(actual.castShadow, true);
  assert.equal(actual.receiveShadow, true);
});

test('animated, skinned, instanced and morphable map trees retain normal descendant updates', () => {
  for (const kind of ['clip', 'attached-clip', 'skin', 'bone', 'morph', 'instances'] as const) {
    const source = new Group(),
      mesh =
        kind === 'skin'
          ? new SkinnedMesh()
          : kind === 'instances'
            ? new InstancedMesh(new BufferGeometry(), new MeshStandardMaterial(), 1)
            : new Mesh();
    mesh.name = 'Mutable native node';
    source.add(mesh);
    if (kind === 'bone') mesh.add(new Bone());
    if (kind === 'morph') {
      mesh.geometry = new BufferGeometry();
      mesh.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
      mesh.geometry.morphAttributes.position = [new Float32BufferAttribute([1, 0, 0], 3)];
      mesh.updateMorphTargets();
    }
    if (kind === 'attached-clip') mesh.animations = [new AnimationClip('Original QA clip', 1, [])];
    const prepared = prepareMapModel(
        source,
        kind === 'clip' ? [new AnimationClip('Original', 1, [])] : [],
      ),
      actual = prepared.main.getObjectByName(mesh.name)!;
    assert.equal(actual.matrixAutoUpdate, true, kind);
    prepared.main.updateMatrixWorld(true);
    const before = actual.matrixWorld.clone();
    actual.position.x += 2;
    prepared.main.updateMatrixWorld(true);
    assert.equal(actual.matrixWorld.equals(before), false, kind);
  }
});
