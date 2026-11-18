import assert from 'node:assert/strict';
import test from 'node:test';
import { thirdPersonFollow } from '../../frontend/src/follow-camera.js';
const player = { id: '100', x: 100, y: 200, z: 300, yaw: 0, alive: true };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);
test('follow camera preserves Source axes, stays2–3m behind shoulder and aims at the recorded actor chest', () => {
  for (const yaw of [0, 90, 180, 270]) {
    const pose = thirdPersonFollow({ ...player, yaw }, undefined, 0)!;
    const feet = [2.54, 7.62, -5.08],
      angle = (yaw * Math.PI) / 180;
    near(Math.hypot(pose.position[0] - feet[0], pose.position[2] - feet[2]), Math.hypot(2.6, 0.65));
    near(
      (pose.position[0] - feet[0]) * Math.cos(angle) -
        (pose.position[2] - feet[2]) * Math.sin(angle),
      -2.6,
    );
    near(pose.position[1], feet[1] + 1.6);
    near(pose.target[1], feet[1] + 1.25);
    assert.deepEqual([pose.target[0], pose.target[2]], [feet[0], feet[2]]);
    assert.equal(pose.actor, player.id);
  }
});
test('follow interpolation uses immutable identity, shortest recorded yaw arc and no interpolation through death', () => {
  const next = { ...player, x: 200, yaw: 10 };
  const pose = thirdPersonFollow({ ...player, yaw: 350 }, next, 0.5)!;
  near(pose.target[0], 150 * 0.0254);
  near(pose.position[0], 150 * 0.0254 - 2.6);
  assert.deepEqual(
    thirdPersonFollow(player, { ...next, id: '200' }, 1),
    thirdPersonFollow(player, undefined, 0),
  );
  assert.deepEqual(
    thirdPersonFollow(player, { ...next, alive: false }, 1),
    thirdPersonFollow(player, undefined, 0),
  );
});
test('follow camera handles clamped crouch/interpolation and rejects invalid recorded transforms without NaN', () => {
  const low = thirdPersonFollow({ ...player, duck: 1 }, undefined, 0)!;
  near(low.position[1], 300 * 0.0254 + 0.9);
  near(low.target[1], 300 * 0.0254 + 0.55);
  assert.deepEqual(
    thirdPersonFollow({ ...player, duck: 2 }, undefined, Infinity),
    thirdPersonFollow({ ...player, duck: 1 }, undefined, 0),
  );
  assert.deepEqual(
    thirdPersonFollow(player, { ...player, x: 200 }, -1),
    thirdPersonFollow(player, undefined, 0),
  );
  for (const invalid of [{ x: NaN }, { z: Infinity }, { yaw: NaN }, { duck: NaN }])
    assert.equal(thirdPersonFollow({ ...player, ...invalid }, undefined, 0), null);
  const robust = thirdPersonFollow(player, { ...player, x: Infinity }, 0.5)!;
  assert.ok([...robust.position, ...robust.target].every(Number.isFinite));
});
