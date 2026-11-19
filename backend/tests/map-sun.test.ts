import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Box3,
  DirectionalLight,
  Vector3,
} from '../../frontend/node_modules/three/build/three.module.js';
import { applySunShadow, mapSun } from '../../frontend/src/map-sun.js';
import type { SourceSun } from '../../frontend/src/source-sun.js';

function projectBounds(result: NonNullable<ReturnType<typeof mapSun>>, bounds: Box3) {
  const light = new DirectionalLight();
  light.position.set(...result.position);
  light.target.position.set(...result.target);
  light.target.updateMatrixWorld(true);
  light.updateMatrixWorld(true);
  applySunShadow(light, result.shadow, result.up);
  light.shadow.updateMatrices(light);
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new Vector3(x, y, z).project(light.shadow.camera);
        assert.ok(
          Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1,
          'Every main-map corner must fit the actual Three shadow camera',
        );
      }
  assert.equal(light.shadow.needsUpdate, true);
}

test('authored sun fits the complete static main-map volume and updates the actual shadow projection', () => {
  const bounds = new Box3(new Vector3(-100, -10, -70), new Vector3(80, 35, 140)),
    direction = new Vector3(-0.47, 0.766, 0.438).normalize(),
    source = {
      directionToSun: direction.toArray() as [number, number, number],
      color: [0.88, 0.82, 0.64] as [number, number, number],
    },
    result = mapSun(source, bounds)!;
  assert.deepEqual(result.color, source.color);
  const light = new DirectionalLight();
  light.position.set(...result.position);
  light.target.position.set(...result.target);
  light.target.updateMatrixWorld(true);
  light.updateMatrixWorld(true);
  const old = light.shadow.camera.projectionMatrix.clone();
  applySunShadow(light, result.shadow, result.up);
  light.shadow.updateMatrices(light);
  assert.equal(old.equals(light.shadow.camera.projectionMatrix), false);
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new Vector3(x, y, z).project(light.shadow.camera);
        assert.ok(
          Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1,
        );
      }
  assert.deepEqual(bounds.min.toArray(), [-100, -10, -70]);
});

test('missing or invalid map bounds keep an ordinary bounded shadow camera and overhead sun is finite', () => {
  assert.equal(mapSun(null), null);
  const source = {
    directionToSun: [0, 1, 0] as [number, number, number],
    color: [1, 1, 1] as [number, number, number],
  };
  const result = mapSun(source, new Box3(new Vector3(-10, 0, -10), new Vector3(10, 5, 10)))!;
  assert.deepEqual(result.up, [0, 0, 1]);
  assert.ok(Object.values(result.shadow).every(Number.isFinite));
  assert.equal(mapSun(source)?.shadow.left, -45);
  assert.equal(mapSun({ ...source, directionToSun: [NaN, 0, 0] }), null);
});

test('sun rejects malformed direction/color evidence before overflow or invalid light uniforms', () => {
  const source: SourceSun = { directionToSun: [0, 1, 0], color: [0.8, 0.6, 0.3] };
  for (const directionToSun of [
    [0, 0, 0],
    [0, 2, 0],
    [0, 0.5, 0],
    [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [0, NaN, 0],
    [0, Infinity, 0],
    [0, 1],
    [0, 1, 0, 0],
    ['0', 1, 0],
    new Array(3),
  ])
    assert.equal(mapSun({ ...source, directionToSun } as SourceSun), null);
  const sparseColor = new Array(3);
  sparseColor[0] = 1;
  for (const color of [
    [0, 0, 0],
    [1.001, 1, 1],
    [-0.001, 1, 1],
    [NaN, 1, 1],
    [Infinity, 1, 1],
    [1, 1],
    [1, 1, 1, 1],
    [1, '1', 1],
    sparseColor,
  ])
    assert.equal(mapSun({ ...source, color } as SourceSun), null);
  const rounded = mapSun({ ...source, directionToSun: [0, 1.00001, 0] })!;
  assert.deepEqual(rounded.position, [0, 50, 0], 'Small unit-vector roundoff normalizes safely');
});

test('actual static shadow projections fit translated, flat and point volumes for axis and steep sun directions', () => {
  const directions: SourceSun['directionToSun'][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, -1],
    new Vector3(0.01, 1, 0.01).normalize().toArray(),
    new Vector3(1, 0.02, -1).normalize().toArray(),
  ];
  for (const bounds of [
    new Box3(new Vector3(99_800, -99_900, 88_000), new Vector3(100_000, -99_800, 88_120)),
    new Box3(new Vector3(-30, 5, -10), new Vector3(20, 5, 40)),
    new Box3(new Vector3(30, 40, 50), new Vector3(30, 40, 50)),
  ]) {
    const before = bounds.clone();
    for (const directionToSun of directions) {
      const source = Object.freeze({
          directionToSun: Object.freeze([...directionToSun]) as SourceSun['directionToSun'],
          color: Object.freeze([0.8, 0.6, 0.3]) as SourceSun['color'],
        }),
        result = mapSun(source, bounds)!;
      projectBounds(result, bounds);
      const actualDirection = new Vector3(...result.position)
        .sub(new Vector3(...result.target))
        .normalize();
      assert.ok(actualDirection.dot(new Vector3(...directionToSun)) > 1 - 1e-10);
      assert.deepEqual(
        result,
        mapSun(source, bounds),
        'Static inputs do not move the shadow volume',
      );
      assert.deepEqual(bounds, before, 'Fitting never mutates prepared-map bounds');
      assert.deepEqual(result.color, source.color, 'Authored linear color stays unchanged');
    }
  }
});

test('nonfinite, excessive and empty main-map bounds retain finite fallback projection limits', () => {
  const source: SourceSun = { directionToSun: [1, 0, 0], color: [1, 1, 1] },
    fallback = mapSun(source)!;
  for (const bounds of [
    new Box3(),
    new Box3(new Vector3(-1, -1, -1), new Vector3(1, Infinity, 1)),
    new Box3(new Vector3(-1, NaN, -1), new Vector3(1, 1, 1)),
    new Box3(new Vector3(-1, -1, -1), new Vector3(100_001, 1, 1)),
  ])
    assert.deepEqual(mapSun(source, bounds), fallback);
});
