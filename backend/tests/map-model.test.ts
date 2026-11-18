import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmbientLight,
  DirectionalLight,
  DataTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  Matrix4,
  PointLight,
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
