import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoxGeometry,
  Color,
  CubeTexture,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
  Quaternion,
} from '../../frontend/node_modules/three/build/three.module.js';
import {
  renderSkyBehindMap,
  skyCameraFor,
  updateSkyCamera,
} from '../../frontend/src/sky-render.js';

test('landscape camera preserves main world pose and projection while extending only its own bounded far plane', () => {
  const parent = new Group(),
    main = new PerspectiveCamera(72, 1.5, 0.05, 3000),
    sky = new Scene(),
    terrain = new Mesh(new BoxGeometry(10, 10, 10));
  parent.position.set(5, 0, 0);
  parent.rotation.y = 0.2;
  parent.add(main);
  main.position.set(10, 12, 14);
  terrain.position.x = 20000;
  sky.add(terrain);
  const projection = main.projectionMatrix.clone(),
    prepared = skyCameraFor(sky),
    copy = updateSkyCamera(main, prepared);
  assert.equal(main.far, 3000);
  assert.ok(main.projectionMatrix.equals(projection));
  assert.equal(copy.near, main.near);
  assert.equal(copy.fov, main.fov);
  assert.equal(copy.aspect, main.aspect);
  assert.ok(copy.position.distanceTo(main.getWorldPosition(new Vector3())) < 1e-8);
  const expectedRotation = main.getWorldQuaternion(new Quaternion()).toArray();
  copy.quaternion
    .toArray()
    .forEach((value, index) => assert.ok(Math.abs(value - expectedRotation[index]) < 1e-12));
  assert.ok(copy.far > 19000);
  assert.ok(copy.far < 30000);
  terrain.position.x = 1e9;
  const extreme = updateSkyCamera(main, skyCameraFor(sky));
  assert.equal(extreme.far, 1_000_000);
  assert.equal(main.far, 3000);
});
test('sky renders behind main depth and restores background and renderer state even when main rendering fails', () => {
  for (const fail of [false, true]) {
    const main = new Scene(),
      sky = new Scene(),
      camera = new PerspectiveCamera(),
      skyCamera = new PerspectiveCamera(),
      draws: string[] = [];
    main.background = new Color('#91a7b3');
    main.backgroundIntensity = 0.75;
    main.backgroundRotation.y = 0.3;
    main.environment = new CubeTexture();
    main.environmentIntensity = 0.8;
    main.environmentRotation.y = -0.2;
    sky.background = new Color('#123456');
    sky.backgroundIntensity = 2;
    sky.backgroundBlurriness = 0.5;
    sky.backgroundRotation.y = 0.7;
    const originalMain = main.background,
      originalSky = sky.background;
    const originalSkyEnvironment = new CubeTexture();
    sky.environment = originalSkyEnvironment;
    sky.environmentIntensity = 0.4;
    sky.environmentRotation.y = 0.9;
    const renderer = {
      autoClear: true,
      clear() {
        draws.push('clear');
      },
      clearDepth() {
        draws.push('depth');
      },
      render(scene: Scene, active: PerspectiveCamera) {
        if (scene === sky) {
          draws.push('sky');
          assert.equal(active, skyCamera);
          assert.equal(sky.background, originalMain);
          assert.equal(sky.backgroundIntensity, 0.75);
          assert.equal(sky.environment, main.environment);
          assert.equal(sky.environmentIntensity, 0.8);
          assert.equal(sky.environmentRotation.y, -0.2);
        } else {
          draws.push('main');
          assert.equal(active, camera);
          assert.equal(main.background, null);
          if (fail) throw new Error('Original QA render failure');
        }
      },
    };
    if (fail)
      assert.throws(
        () => renderSkyBehindMap(renderer, main, sky, camera, skyCamera),
        /QA render failure/,
      );
    else renderSkyBehindMap(renderer, main, sky, camera, skyCamera);
    assert.deepEqual(draws, ['clear', 'sky', 'depth', 'main']);
    assert.equal(renderer.autoClear, true);
    assert.equal(main.background, originalMain);
    assert.equal(sky.background, originalSky);
    assert.equal(sky.backgroundIntensity, 2);
    assert.equal(sky.backgroundBlurriness, 0.5);
    assert.equal(sky.backgroundRotation.y, 0.7);
    assert.equal(sky.environment, originalSkyEnvironment);
    assert.equal(sky.environmentIntensity, 0.4);
    assert.equal(sky.environmentRotation.y, 0.9);
  }
});
