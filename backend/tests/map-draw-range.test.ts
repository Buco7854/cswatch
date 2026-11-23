import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Texture,
  MeshStandardMaterial,
  type WebGLRenderer,
} from '../../frontend/node_modules/three/build/three.module.js';
import { installMapDrawRanges } from '../../frontend/src/map-draw-range.js';

test('map batches retain crossing triangles and restore shared geometry for other instances and passes', () => {
  const scene = new Scene(),
    camera = new PerspectiveCamera(90, 1, 0.1, 20);
  for (const indexed of [true, false]) {
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld();
    const geometry = new BufferGeometry();
    const coordinates: number[] = [];
    for (const x of [-100, 0, 100]) {
      for (let i = 0; i < 64; i++) coordinates.push(x - 0.1, 0, -2, x + 0.1, 0, -2, x, 1, -2);
    }
    // One triangle in the final block crosses the frustum edge.
    coordinates[coordinates.length - 3] = 1;
    geometry.setAttribute('position', new Float32BufferAttribute(coordinates, 3));
    if (indexed) geometry.setIndex(Array.from({ length: 576 }, (_, i) => i));
    const material = new MeshBasicMaterial();
    const mesh = new Mesh(geometry, material),
      second = new Mesh(geometry, material);
    second.position.x = 100;
    scene.add(mesh, second);
    scene.updateMatrixWorld();
    const ranges: { start: number; count: number }[] = [];
    let fail = false;
    const direct = () => {
      ranges.push({ ...geometry.drawRange });
      if (fail) throw new Error('interrupted draw');
    };
    const renderer = {
      renderBufferDirect: direct,
      info: { render: { frame: 1 } },
    } as unknown as WebGLRenderer;
    const release = installMapDrawRanges(renderer, scene, scene);
    const draw = (object = mesh) =>
      renderer.renderBufferDirect(camera, scene, geometry, material, object, null);
    draw();
    draw(second);
    assert.deepEqual(ranges, [
      { start: 192, count: 384 },
      { start: 0, count: 192 },
    ]);
    fail = true;
    assert.throws(() => draw(), /interrupted draw/);
    assert.deepEqual(geometry.drawRange, { start: 0, count: Infinity });
    fail = false;
    renderer.renderBufferDirect(camera, null, geometry, material, mesh, null);
    const displaced = new MeshStandardMaterial({ displacementMap: new Texture() });
    renderer.renderBufferDirect(camera, scene, geometry, displaced, mesh, null);
    assert.deepEqual(ranges.slice(-2), [
      { start: 0, count: Infinity },
      { start: 0, count: Infinity },
    ]);
    camera.position.x = 300;
    camera.updateMatrixWorld();
    renderer.info.render.frame++;
    const previous = ranges.length;
    draw();
    assert.equal(ranges.length, previous);
    release();
    assert.equal(renderer.renderBufferDirect, direct);
    scene.remove(mesh, second);
  }
});
