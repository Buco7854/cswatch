import assert from 'node:assert/strict';
import test from 'node:test';
import { CubeTexture, Scene } from '../../frontend/node_modules/three/build/three.module.js';
import { mapIblSize, withSceneEnvironment } from '../../frontend/src/map-ibl.js';

test('skylight filtering has a phone/desktop bound independent of backdrop resolution and validates complete faces', () => {
  const cube = new CubeTexture();
  cube.images = Array.from({ length: 6 }, () => ({ width: 1024, height: 1024 }));
  assert.equal(mapIblSize(cube, true), 128);
  assert.equal(mapIblSize(cube, false), 256);
  cube.images = Array.from({ length: 6 }, () => ({ width: 100, height: 100 }));
  assert.equal(mapIblSize(cube, false), 64);
  for (const faces of [
    [],
    Array.from({ length: 5 }, () => ({ width: 32, height: 32 })),
    Array.from({ length: 6 }, () => ({ width: 4096, height: 4096 })),
    Array.from({ length: 6 }, () => ({ width: 12, height: 12 })),
    Array.from({ length: 6 }, () => ({ width: NaN, height: NaN })),
    Array.from({ length: 6 }, () => ({ width: 32, height: 16 })),
    Array.from({ length: 6 }, (_, index) => ({ width: index ? 32 : 64, height: index ? 32 : 64 })),
  ]) {
    cube.images = faces;
    assert.throws(() => mapIblSize(cube, false), /six decoded bounded square faces/);
  }
});

test('secondary passes inherit current sky energy/rotation and restore their owned environment even on a failed draw', () => {
  const world = new Scene(),
    pass = new Scene(),
    source = new CubeTexture(),
    own = new CubeTexture();
  world.environment = source;
  world.environmentIntensity = 1.2;
  world.environmentRotation.set(0.1, 0.2, -0.3);
  pass.environment = own;
  pass.environmentIntensity = 0.4;
  pass.environmentRotation.set(-0.2, 0.7, 0.1);
  const original = pass.environmentRotation.clone(),
    sourceRotation = world.environmentRotation.clone();
  let disposals = 0;
  source.addEventListener('dispose', () => disposals++);
  own.addEventListener('dispose', () => disposals++);
  for (const fail of [false, true]) {
    const draw = () =>
      withSceneEnvironment(world, pass, () => {
        assert.equal(pass.environment, source);
        assert.equal(pass.environmentIntensity, 1.2);
        assert.ok(pass.environmentRotation.equals(sourceRotation));
        if (fail) throw new Error('Original renderer failure');
        return 'drawn';
      });
    if (fail) assert.throws(draw, /Original renderer failure/);
    else assert.equal(draw(), 'drawn');
    assert.equal(pass.environment, own);
    assert.equal(pass.environmentIntensity, 0.4);
    assert.ok(pass.environmentRotation.equals(original));
    assert.equal(world.environment, source);
    assert.ok(world.environmentRotation.equals(sourceRotation));
    assert.equal(
      disposals,
      0,
      'Shared backdrop/environment resources are never released by a pass',
    );
  }
  world.environment = null;
  withSceneEnvironment(world, pass, () => assert.equal(pass.environment, null));
  assert.equal(pass.environment, own);
});
