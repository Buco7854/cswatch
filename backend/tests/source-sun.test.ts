import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectionalLight,
  Group,
  Matrix4,
  PointLight,
  Vector3,
} from '../../frontend/node_modules/three/build/three.module.js';
import { readSourceSun } from '../../frontend/src/source-sun.js';

function sun() {
  const light = new DirectionalLight();
  // This is the original glTF node name GLTFLoader retains independently of its
  // unique runtime object name. All fixtures here are original analytical data.
  light.userData.name = 'light_environment';
  light.name = 'light_environment_7';
  light.color.setRGB(0.8, 0.6, 0.3);
  return light;
}

function approximately(actual: readonly number[], expected: readonly number[]) {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-10));
}

test('native sun retains linear color and prepared coordinate orientation without native energy', () => {
  const source = new Group(),
    light = sun(),
    parent = new Group();
  source.rotation.y = Math.PI / 2;
  parent.rotation.x = -Math.PI / 3;
  parent.scale.setScalar(16);
  parent.position.set(120, -40, 9);
  light.position.set(-9, 4, 20);
  light.intensity = 999_999;
  light.visible = false;
  parent.add(light);
  source.add(parent);
  const originalWorld = light.matrixWorld.clone(),
    originalLocal = light.matrix.clone(),
    result = readSourceSun(source)!;
  approximately(result.directionToSun, [0.5, Math.sqrt(3) / 2, 0]);
  assert.deepEqual(result.color, [0.8, 0.6, 0.3]);
  assert.deepEqual(light.matrixWorld, originalWorld, 'Extraction does not update shared matrices');
  assert.deepEqual(light.matrix, originalLocal);
  assert.equal(light.intensity, 999_999);
  assert.equal(light.visible, false);
  light.intensity = 0;
  assert.deepEqual(
    readSourceSun(source),
    result,
    'Suppressed exporter energy is not evidence loss',
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.directionToSun), true);
  assert.equal(Object.isFrozen(result.color), true);
});

test('native sun accepts agreeing main/sky authoring and fails closed on color or pose conflict', () => {
  const source = new Group(),
    first = sun(),
    sky = sun();
  first.rotation.x = sky.rotation.x = -0.8;
  first.intensity = 2000;
  sky.intensity = 4000;
  sky.position.set(600, 400, 900);
  source.add(first, sky);
  assert.ok(readSourceSun(source));
  sky.color.g += 0.001;
  assert.equal(readSourceSun(source), null);
  sky.color.copy(first.color);
  sky.rotation.y = 0.05;
  assert.equal(readSourceSun(source), null);
  sky.rotation.copy(first.rotation);
  sky.quaternion.x += 1e-8;
  assert.ok(readSourceSun(source), 'Rounding differences in native duplicates remain supported');
});

test('source sun uses explicit fixed local matrices and excludes outside-root transforms', () => {
  const outside = new Group(),
    source = new Group(),
    light = sun();
  outside.rotation.z = 0.7;
  outside.add(source);
  source.rotation.y = Math.PI / 2;
  light.matrixAutoUpdate = false;
  light.matrix.makeRotationX(-Math.PI / 2);
  light.rotation.y = 0.4;
  source.add(light);
  approximately(readSourceSun(source)!.directionToSun, [0, 1, 0]);
  assert.deepEqual(light.matrix, new Matrix4().makeRotationX(-Math.PI / 2));
  assert.deepEqual(outside.matrixWorld, new Matrix4());
});

test('sun discovery requires native directional identity and finite nonzero authored evidence', () => {
  const source = new Group(),
    named = new DirectionalLight(),
    point = new PointLight(),
    light = sun();
  named.name = 'light_environment';
  point.userData.name = 'light_environment';
  source.add(named, point);
  assert.equal(readSourceSun(source), null);
  source.add(light);
  assert.ok(readSourceSun(source));
  for (const value of [NaN, Infinity, -0.1, 1.1]) {
    light.color.r = value;
    assert.equal(readSourceSun(source), null);
  }
  light.color.setRGB(0, 0, 0);
  assert.equal(readSourceSun(source), null);
  light.color.setRGB(0.8, 0.6, 0.3);
  light.scale.set(0, 0, 0);
  assert.equal(readSourceSun(source), null);
  light.scale.set(1, 1, 1);
  light.position.x = NaN;
  assert.equal(readSourceSun(source), null);
  light.position.set(0, 0, 0);
  light.matrixAutoUpdate = false;
  light.matrix.elements[10] = Infinity;
  assert.equal(readSourceSun(source), null);
});

test('native sun discovery bounds candidate count and local transform depth', () => {
  const source = new Group();
  for (let index = 0; index < 17; index++) source.add(sun());
  assert.equal(readSourceSun(source), null);
  source.clear();
  let parent = source;
  for (let depth = 0; depth < 257; depth++) {
    const next = new Group();
    parent.add(next);
    parent = next;
  }
  parent.add(sun());
  assert.equal(readSourceSun(source), null);
});

test('sun direction follows complete ancestor orientation instead of light position or target', () => {
  const source = new Group(),
    parent = new Group(),
    light = sun();
  source.rotation.set(0.2, 0.5, -0.3);
  parent.rotation.set(-0.8, -0.4, 0.6);
  light.rotation.set(0.1, 0.3, -0.2);
  source.add(parent);
  parent.add(light);
  const result = readSourceSun(source)!;
  source.updateMatrixWorld(true);
  const expected = new Vector3(0, 0, 1).transformDirection(light.matrixWorld);
  approximately(result.directionToSun, expected.toArray());
  light.position.set(-200, 600, -900);
  light.target.position.set(10, 20, 30);
  assert.deepEqual(readSourceSun(source), result, 'glTF sun orientation uses its local negative Z');
});
