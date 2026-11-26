import assert from 'node:assert/strict';
import test from 'node:test';
import { mortonEncode3 } from 'cs2parser/browser';
import {
  BLAST_SECONDS,
  CELL,
  GRID,
  HALF_GRID,
  densityField,
  analyticSmokeField,
  activeSmokeHoles,
  indexSmokeBlasts,
  occupiedBounds,
  scenePoint,
  smokeEnvelope,
  smokeNoiseAt,
  smokeSampleAlpha,
  smokeTransmittance,
  unionSmokeBounds,
} from '../../frontend/src/smoke-field.js';
import { encodeDensity, smokeJournal } from '../../frontend/src/smoke-journal.js';

const index = (x, y, z) => x + GRID * (y + GRID * z);
const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);

test('each four-inch sample erodes thin smoke with noise and fills dense smoke', () => {
  // smoke_volume.vfx: smoothstep(0, 0.2, mix(d - (1 - n), d + n, d)).
  close(smokeSampleAlpha(0.45, 0.8), 1);
  assert.equal(smokeSampleAlpha(0.03, 0.5), 0);
  assert.ok(smokeSampleAlpha(0.2, 0.9) > smokeSampleAlpha(0.2, 0.6));
  let previous = 0;
  for (let density = 0; density <= 1; density += 0.05) {
    const alpha = smokeSampleAlpha(density, 0.7);
    assert.ok(alpha >= previous && alpha <= 1);
    previous = alpha;
  }
});

test('cellular noise is deterministic in world space and rises with the cloud age', () => {
  const at = (age) => smokeNoiseAt(1.3, 0.4, -2.2, age);
  assert.equal(at(2), at(2));
  assert.notEqual(at(0), at(3));
  for (let i = 0; i < 64; i++) {
    const value = smokeNoiseAt(i * 0.37, i * 0.11, -i * 0.29, i * 0.1);
    assert.ok(value >= 0.12 && value <= 1, String(value));
  }
});

test('encoding is linear in simulated concentration and rotates Source axes', () => {
  const raw = new Float32Array(GRID ** 3);
  raw[mortonEncode3(3, 7, 11)] = 25;
  raw[mortonEncode3(4, 7, 11)] = 80;
  raw[mortonEncode3(5, 7, 11)] = -2;
  const bytes = encodeDensity(raw);
  assert.equal(bytes[index(3, 11, GRID - 1 - 7)], 128);
  assert.equal(bytes[index(4, 11, GRID - 1 - 7)], 255);
  assert.equal(bytes[index(5, 11, GRID - 1 - 7)], 0);
  assert.equal(
    bytes.reduce((sum, value) => sum + value),
    383,
  );
  assert.deepEqual(scenePoint([100, 200, -50]), [2.54, -1.27, -5.08]);
});

test('occupied bounds include trilinear support, clip to the grid and union both states', () => {
  const density = new Uint8Array(GRID ** 3);
  assert.equal(occupiedBounds(density), null);
  density[index(0, 16, 31)] = 255;
  const a = occupiedBounds(density);
  assert.ok(a);
  a.min.forEach((v, i) => close(v, [-HALF_GRID, -CELL / 2, HALF_GRID - 1.5 * CELL][i]));
  a.max.forEach((v, i) => close(v, [-HALF_GRID + 1.5 * CELL, 1.5 * CELL, HALF_GRID][i]));
  density.fill(0);
  density[index(31, 0, 0)] = 1;
  const b = occupiedBounds(density);
  const union = unionSmokeBounds(a, b);
  assert.ok(union);
  assert.deepEqual(union.min, [-HALF_GRID, -HALF_GRID, -HALF_GRID]);
  union.max.forEach((v, i) => close(v, [HALF_GRID, 1.5 * CELL, HALF_GRID][i]));
});

test('the density field keeps the recorded bytes and their occupied bounds', () => {
  const density = new Uint8Array(GRID ** 3);
  density[index(16, 16, 16)] = 255;
  const field = densityField(density);
  assert.equal(field.texels, density);
  assert.deepEqual(field.bounds, occupiedBounds(density));
  assert.equal(densityField(new Uint8Array(GRID ** 3)).bounds, null);
});

test('transmittance clips segment bounds and applies blend, envelope and HE clearing', () => {
  const current = densityField(new Uint8Array(GRID ** 3).fill(255));
  const previous = densityField(new Uint8Array(GRID ** 3));
  const cloud = {
    previous,
    current,
    origin: [0, 0, 0],
    scale: 1,
    mix: 1,
    bounds: current.bounds,
    amount: 1,
    age: 4,
    holes: [],
  };
  const core = smokeTransmittance(cloud, [0, 0, 0], [2, 0, 0]);
  assert.ok(core < 0.02);
  assert.ok(smokeTransmittance(cloud, [HALF_GRID - 2, 0, 0], [HALF_GRID + 5, 0, 0]) < 0.02);
  assert.equal(smokeTransmittance(cloud, [0, 0, 0], [0, 0, 0]), 1);
  assert.equal(smokeTransmittance(cloud, [0, HALF_GRID + 1, 0], [2, HALF_GRID + 1, 0]), 1);
  // An empty previous state, half blended and half faded, leaves a thin, eroded cloud.
  assert.ok(smokeTransmittance({ ...cloud, mix: 0.5, amount: 0.5 }, [0, 0, 0], [2, 0, 0]) > core);
  assert.equal(smokeTransmittance({ ...cloud, amount: 0 }, [0, 0, 0], [2, 0, 0]), 1);
  assert.ok(
    smokeTransmittance(
      { ...cloud, holes: [{ position: [1, 0, 0], since: 0.3 }] },
      [0, 0, 0],
      [2, 0, 0],
    ) > 0.9,
  );
  assert.equal(smokeEnvelope(0, 1, 0.5), 0);
  assert.equal(smokeEnvelope(1, 0.25, 0.5), 0.5);
  assert.equal(smokeEnvelope(1, 0, 0.5), 0);
});

test('forward, backward and direct journal seeks yield identical paired bytes', () => {
  const seed = [0, 1, 1, 16, 15, 16, 0, 0, 0, 0, 0, 0];
  const heartbeat = [0, 0, 0];
  const stop = [1, 0, 0];
  const frames = [seed, heartbeat, heartbeat, heartbeat, stop, heartbeat];
  let end = 0;
  const updates = frames.map((payload, seq) => [seq * 8 + 1, (end += payload.length + 4)]);
  const journal = Buffer.from(
    frames.flatMap((payload, seq) => [seq, 0, payload.length, 0, ...payload]),
  ).toString('base64');
  const track = { journal, updates, origin: [0, 0, 0] };
  const seek = smokeJournal(track);
  const offset = (i) => updates[i][1];
  for (let i = 0; i < 3; i++) seek(offset(i), offset(Math.max(0, i - 1)));
  const forward = seek(offset(3), offset(2));
  assert.ok(forward.current.bounds);
  assert.notDeepEqual(forward.current.texels, forward.previous.texels);
  assert.equal(forward.stoppedAt, 33);
  seek(offset(5), offset(4));
  assert.deepEqual(seek(offset(3), offset(2)), forward);
  assert.deepEqual(smokeJournal(track)(offset(3), offset(2)), forward);
});

test('cropped smoke depth camera preserves offset world rays and re-encodes linear depth', async () => {
  const { PerspectiveCamera, Vector3 } =
    await import('../../frontend/node_modules/three/build/three.module.js');
  const { cropSmokeCamera } = await import('../../frontend/src/smoke-depth.js');
  const main = new PerspectiveCamera(67, 1.6, 0.05, 3000);
  main.position.set(3, 4, 5);
  main.lookAt(-1, 2, 0);
  main.setViewOffset(1000, 625, 24, 12, 1000, 625);
  main.updateMatrixWorld();
  const near = main.near,
    far = 23;
  const crop = { x: 112, y: 91, width: 240, height: 289 };
  const depth = new PerspectiveCamera();
  cropSmokeCamera(depth, main, crop, 1000, 625, far);
  for (const [x, y] of [
    [0, 0],
    [0.5, 0.5],
    [1, 1],
  ]) {
    const world = new Vector3(
      (2 * (crop.x + x * crop.width)) / 1000 - 1,
      (2 * (crop.y + y * crop.height)) / 625 - 1,
      0.98,
    ).unproject(main);
    const projected = world.clone().project(depth);
    close(projected.x, 2 * x - 1);
    close(projected.y, 2 * y - 1);
    const d = (projected.z + 1) * 0.5;
    close((near * far) / (far + (near - far) * d), -world.applyMatrix4(main.matrixWorldInverse).z);
  }
  assert.equal(depth.far, far);
  assert.equal(main.far, 3000);
});

test('HE clearing is tied to recorded detonation time and reach, and refills over five seconds', () => {
  const field = densityField(new Uint8Array(GRID ** 3).fill(210));
  const cloud = {
    previous: field,
    current: field,
    origin: [0, 0, 0],
    scale: 1,
    mix: 1,
    bounds: field.bounds,
    amount: 1,
    age: 4,
    holes: [],
  };
  const blasts = indexSmokeBlasts([
    { type: 'flashbang_detonate', tick: 100, x: 0, y: 0, z: 0 },
    { type: 'hegrenade_detonate', tick: 100, x: 0, y: 0, z: 0 },
    // 2000 inches away: beyond the 250-inch reach past the occupied grid.
    { type: 'hegrenade_detonate', tick: 101, x: 2000, y: 0, z: 0 },
  ]);
  assert.deepEqual(activeSmokeHoles(blasts, cloud, 90, 99, 64), []);
  const opened = activeSmokeHoles(blasts, cloud, 90, 111, 64);
  assert.equal(opened.length, 1);
  close(opened[0].since, 11 / 64);
  const through = (holes) => smokeTransmittance({ ...cloud, holes }, [-1, 0, 0], [1, 0, 0]);
  assert.ok(through(opened) > 0.9);
  const refilling = activeSmokeHoles(blasts, cloud, 90, 100 + 64 * 3, 64);
  assert.ok(through(refilling) < through(opened));
  assert.deepEqual(activeSmokeHoles(blasts, cloud, 90, 100 + 64 * BLAST_SECONDS, 64), []);
  assert.deepEqual(activeSmokeHoles(blasts, cloud, 102, 111, 64), []);
});

test('the analytic field supplies a bounded cloud without a journal', () => {
  const current = analyticSmokeField();
  assert.ok(current.bounds);
  assert.equal(current.texels.length, GRID ** 3);
  assert.deepEqual(current, analyticSmokeField());
  const cloud = {
    origin: [0, 0, 0] as [number, number, number],
    scale: 1,
    previous: current,
    current,
    mix: 1,
    bounds: current.bounds,
    amount: 1,
    age: 4,
    holes: [],
  };
  assert.ok(smokeTransmittance(cloud, [-1, 1.3, 0], [1, 1.3, 0]) < 0.02);
  assert.equal(smokeTransmittance(cloud, [-4, 5, 0], [4, 5, 0]), 1);
});
