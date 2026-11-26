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
test('recorded positions follow a C1 curve through continuous neighbours without overshoot', () => {
  const at = (tick: number, x: number, extra = {}) => ({ tick, pose: { ...p, x, ...extra } });
  const curved = (before: number, from: number, to: number, after: number, alpha: number) =>
    playerPose({ ...p, x: from }, { ...p, x: to }, alpha, {
      ...timing,
      before: at(-4, before),
      after: at(8, after),
    }).x;
  // Constant recorded velocity stays exactly linear.
  assert.equal(curved(-8, 0, 8, 16, 0.25), 2);
  // A stop never runs past the last recorded position, and the path leaves it flat.
  for (const alpha of [0.25, 0.5, 0.75, 0.95]) assert.ok(curved(-8, 0, 8, 8, alpha) <= 8);
  assert.ok(curved(-8, 0, 8, 8, 0.95) > curved(-8, 0, 8, 8, 0.9));
  // Velocity matches on both sides of a recorded sample.
  const slope = (from: number, to: number, alpha: number, before: number, after: number) =>
    (curved(before, from, to, after, alpha + 1e-4) - curved(before, from, to, after, alpha)) / 1e-4;
  const into = slope(0, 8, 0.9999 - 1e-4, -4, 20),
    out = slope(8, 20, 0, 0, 36);
  assert.ok(Math.abs(into / 4 - out / 4) / Math.abs(out / 4) < 0.01, `${into} ${out}`);
});
test('respawn, teleport and round-boundary neighbours leave the interval linear', () => {
  const span = (before: object, after: object) =>
    playerPose(p, { ...p, x: 8 }, 0.5, { ...timing, ...before, ...after }).x;
  const linear = 4;
  for (const before of [
    { before: { tick: -4, pose: { ...p, x: -3000 } } },
    { before: { tick: -4, pose: { ...p, x: -8, alive: false } } },
    { before: { tick: -4, pose: { ...p, id: 'other', x: -8 } } },
    { before: { tick: -40, pose: { ...p, x: -8 } } },
  ])
    for (const after of [
      { after: { tick: 8, pose: { ...p, x: 3000 } } },
      { after: { tick: 8, pose: { ...p, x: 16, alive: false } } },
    ])
      assert.equal(span(before, after), linear);
  assert.equal(
    playerPose(p, { ...p, x: 8 }, 0.5, {
      ...timing,
      roundBoundary: true,
      before: { tick: -4, pose: { ...p, x: 0 } },
    }),
    p,
  );
});
