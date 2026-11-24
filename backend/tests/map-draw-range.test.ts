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
  Uint8BufferAttribute,
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

test('main and sky keep ordered ranges on either side of an off-camera region, and preserve the shadow pass', () => {
  const world = new Scene();
  const sky = new Scene();
  const camera = new PerspectiveCamera(90, 1, 0.1, 20);
  camera.updateMatrixWorld();
  const coordinates: number[] = [];
  // Two small visible islands separated by 16 blocks on the other side of the map.
  for (let b = 0; b < 18; b++) {
    const x = b === 0 || b === 17 ? 0 : 100;
    for (let i = 0; i < 64; i++) coordinates.push(x - 0.1, 0, -2, x + 0.1, 0, -2, x, 1, -2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(coordinates, 3));
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  const landscape = new Mesh(geometry, material);
  world.add(mesh);
  sky.add(landscape);
  const calls: number[][] = [];
  let interrupt = false;
  const renderer = {
    renderBufferDirect() {
      calls.push([geometry.drawRange.start, geometry.drawRange.count]);
      if (interrupt && geometry.drawRange.start) throw new Error('interrupted final range');
    },
    info: { render: { frame: 1 } },
  } as unknown as WebGLRenderer;
  const release = installMapDrawRanges(renderer, world, world, sky);
  const render = (scene: Scene | null, object: Mesh) =>
    renderer.renderBufferDirect(camera, scene, geometry, material, object, null);
  try {
    render(world, mesh);
    render(sky, landscape);
    render(null, mesh);
    assert.deepEqual(calls, [
      [0, 192],
      [17 * 192, 192],
      [0, 192],
      [17 * 192, 192],
      [0, Infinity],
    ]);
    interrupt = true;
    assert.throws(() => render(sky, landscape), /interrupted final range/);
    assert.deepEqual(geometry.drawRange, { start: 0, count: Infinity });
  } finally {
    release();
  }
});

test('large maps spread their block budget across distinct static geometries', () => {
  const scene = new Scene(),
    camera = new PerspectiveCamera(90, 1, 0.1, 20);
  const triangles = 700_000;
  const data = new Uint8Array(triangles * 3);
  for (let i = 0; i < data.length; i++) data[i] = i % 3;
  const index = new Uint8BufferAttribute(data, 1),
    material = new MeshBasicMaterial();
  const objects = [0, 1, ...Array<number>(8).fill(100)].map((x) => {
    const geometry = new BufferGeometry();
    geometry.setIndex(index);
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([x, 0, -2, x + 1, 0, -2, x, 1, -2], 3),
    );
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    return mesh;
  });
  let draws = 0;
  const renderer = {
    renderBufferDirect() {
      draws++;
    },
    info: { render: { frame: 1 } },
  } as unknown as WebGLRenderer;
  const release = installMapDrawRanges(renderer, scene, scene);
  try {
    // Seven million triangles exceed the original scan limit. Late off-camera
    // batches reusing the same three vertex IDs still have their own local bounds.
    for (const mesh of objects)
      renderer.renderBufferDirect(camera, scene, mesh.geometry, material, mesh, null);
    assert.equal(draws, 2);
  } finally {
    release();
  }
});
