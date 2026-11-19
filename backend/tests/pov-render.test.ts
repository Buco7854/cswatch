import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PerspectiveCamera,
  Scene,
  type WebGLRenderer,
} from '../../frontend/node_modules/three/build/three.module.js';
import { renderPovEquipment } from '../../frontend/src/pov-render.js';

test('first-person composition preserves world/sky ordering and renderer state, including render failures', () => {
  const world = new Scene(),
    equipment = new Scene(),
    camera = new PerspectiveCamera();
  const calls: unknown[] = [];
  const renderer = {
    autoClear: true,
    render(scene: Scene, view: unknown) {
      assert.equal(view, camera);
      calls.push([scene, this.autoClear]);
    },
    clearDepth() {
      calls.push('clear-depth');
    },
  };
  renderPovEquipment(renderer as unknown as WebGLRenderer, world, equipment, camera, false);
  assert.deepEqual(calls, [[world, true], 'clear-depth', [equipment, false]]);
  assert.equal(renderer.autoClear, true);
  calls.length = 0;
  renderPovEquipment(renderer as unknown as WebGLRenderer, world, equipment, camera, true);
  assert.deepEqual(calls, ['clear-depth', [equipment, false]]);
  renderer.render = () => {
    throw Error('Original render failure');
  };
  assert.throws(
    () => renderPovEquipment(renderer as unknown as WebGLRenderer, world, equipment, camera, true),
    /Original render failure/,
  );
  assert.equal(renderer.autoClear, true);
});
