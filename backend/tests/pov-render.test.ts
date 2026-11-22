import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Color,
  CubeTexture,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  type WebGLRenderer,
} from '../../frontend/node_modules/three/build/three.module.js';
import { renderPovEquipment } from '../../frontend/src/pov-render.js';
import { renderSkyBehindMap } from '../../frontend/src/sky-render.js';

test('first-person composition preserves world/sky ordering and renderer state, including render failures', () => {
  for (const withSky of [false, true])
    for (const throwing of [undefined, 'world', 'equipment']) {
      const world = new Scene(),
        sky = new Scene(),
        equipment = new Scene(),
        worldCamera = new PerspectiveCamera(48),
        skyCamera = new PerspectiveCamera(48, 1, 0.05, 6000),
        equipmentCamera = new PerspectiveCamera(54, 1, 0.025, 8);
      const worldBackground = new Color('#abc123'),
        skyBackground = new Color('#def234'),
        worldEnvironment = new CubeTexture(),
        skyEnvironment = new CubeTexture(),
        equipmentEnvironment = new CubeTexture();
      world.background = worldBackground;
      world.environment = worldEnvironment;
      world.environmentIntensity = 0.8;
      world.environmentRotation.y = 0.4;
      sky.background = skyBackground;
      sky.environment = skyEnvironment;
      sky.environmentIntensity = 0.3;
      sky.environmentRotation.y = 0.1;
      equipment.environment = equipmentEnvironment;
      equipment.environmentIntensity = 0.5;
      equipment.environmentRotation.y = -0.2;
      const worldSun = new DirectionalLight(0xffffff, 1.8),
        equipmentSun = new DirectionalLight(0xffffff, 0.396);
      world.add(worldSun);
      equipment.add(equipmentSun);
      const calls: string[] = [];
      const renderer = {
        autoClear: true,
        clear(color: boolean, depth: boolean, stencil: boolean) {
          assert.deepEqual([color, depth, stencil], [true, true, true]);
          assert.equal(this.autoClear, false);
          calls.push('clear');
        },
        clearDepth() {
          assert.equal(this.autoClear, false);
          calls.push('depth');
        },
        render(scene: Scene, view: PerspectiveCamera) {
          if (scene === sky) {
            assert.equal(view, skyCamera);
            assert.equal(sky.background, worldBackground);
            assert.equal(sky.environment, worldEnvironment);
            assert.equal(sky.environmentIntensity, 0.8);
            assert.equal(sky.environmentRotation.y, 0.4);
            assert.equal(this.autoClear, false);
            calls.push('sky');
          } else if (scene === world) {
            assert.equal(view, worldCamera);
            assert.equal(world.background, withSky ? null : worldBackground);
            assert.equal(this.autoClear, !withSky);
            assert.deepEqual(world.children, [worldSun]);
            assert.equal(worldSun.intensity, 1.8);
            calls.push('world');
            if (throwing === 'world') throw new Error('Original world render failure');
          } else {
            assert.equal(scene, equipment);
            assert.equal(view, equipmentCamera);
            assert.equal(this.autoClear, false);
            assert.equal(equipment.environment, worldEnvironment);
            assert.equal(equipment.environmentIntensity, 0.8 * 0.75);
            assert.equal(equipment.environmentRotation.y, 0.4);
            assert.deepEqual(equipment.children, [equipmentSun]);
            assert.equal(equipmentSun.intensity, 0.396);
            calls.push('equipment');
            if (throwing === 'equipment') throw new Error('Original equipment render failure');
          }
        },
      };
      const compose = () => {
        if (withSky) renderSkyBehindMap(renderer, world, sky, worldCamera, skyCamera);
        renderPovEquipment(
          renderer as unknown as WebGLRenderer,
          world,
          equipment,
          worldCamera,
          equipmentCamera,
          withSky,
          0.75,
        );
      };
      if (throwing) assert.throws(compose, new RegExp(`Original ${throwing} render failure`));
      else compose();
      const worldPass = withSky ? ['clear', 'sky', 'depth', 'world'] : ['world'];
      assert.deepEqual(
        calls,
        throwing === 'world' ? worldPass : [...worldPass, 'depth', 'equipment'],
      );
      assert.equal(renderer.autoClear, true);
      assert.equal(world.background, worldBackground);
      assert.equal(world.environment, worldEnvironment);
      assert.equal(world.environmentIntensity, 0.8);
      assert.equal(world.environmentRotation.y, 0.4);
      assert.equal(sky.background, skyBackground);
      assert.equal(sky.environment, skyEnvironment);
      assert.equal(sky.environmentIntensity, 0.3);
      assert.equal(sky.environmentRotation.y, 0.1);
      assert.equal(equipment.environment, equipmentEnvironment);
      assert.equal(equipment.environmentIntensity, 0.5);
      assert.equal(equipment.environmentRotation.y, -0.2);
      assert.deepEqual(world.children, [worldSun]);
      assert.equal(worldSun.intensity, 1.8);
      assert.deepEqual(equipment.children, [equipmentSun]);
      assert.equal(equipmentSun.intensity, 0.396);
    }
});
