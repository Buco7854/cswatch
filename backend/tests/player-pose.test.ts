import test from 'node:test';
import assert from 'node:assert/strict';
import { playerPose } from '../../frontend/src/player-pose.js';
const p = {
  id: '76561198000000001',
  x: 0,
  y: 10,
  z: 20,
  yaw: 359,
  pitch: 350,
  alive: true,
  duck: 0,
  health: 100,
  ammo: 30,
};
const timing = { fromTick: 0, nextTick: 4, tickRate: 64 };
test('recorded pose interpolates wrap-safe look/position/duck and retains sampled state without mutating inputs', () => {
  const q = { ...p, x: 8, y: 18, z: 24, yaw: 1, pitch: 10, duck: 1, health: 50, ammo: 0 };
  assert.deepEqual(playerPose(p, q, 0.5, timing), {
    ...p,
    x: 4,
    y: 14,
    z: 22,
    yaw: 360,
    pitch: 360,
    duck: 0.5,
  });
  assert.deepEqual(p, {
    id: '76561198000000001',
    x: 0,
    y: 10,
    z: 20,
    yaw: 359,
    pitch: 350,
    alive: true,
    duck: 0,
    health: 100,
    ammo: 30,
  });
});
test('identity death round large-gap and teleport discontinuities never interpolate a future actor state', () => {
  for (const [q, span] of [
    [{ ...p, id: 'other' }, timing],
    [{ ...p, alive: false }, timing],
    [{ ...p, x: 100000 }, timing],
    [
      { ...p, x: 2 },
      { ...timing, nextTick: 64 },
    ],
    [
      { ...p, x: 2 },
      { ...timing, roundBoundary: true },
    ],
  ] as const)
    assert.equal(playerPose(p, q, 0.5, span), p);
  assert.equal(playerPose(p, undefined, 0.5, timing), p);
  assert.equal(playerPose(p, { ...p, x: 8 }, NaN, timing), p);
});
