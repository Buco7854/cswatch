import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedLocomotion } from '../../frontend/src/agent-locomotion.js';
import type { Position } from '../../shared/playback.js';
const player = {
  id: '76561198000000001',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  health: 100,
  alive: true,
  team: 3,
  weapon: 'ak47',
} as Position;
test('motion uses only immutable contiguous horizontal position and recorded duck, never vertical jump guesses', () => {
  const to = { ...player, x: 25, y: 0, z: 999, duck: 1 };
  assert.equal(recordedLocomotion({ ...player, duck: 0 }, to, 0, 8, 64, 0.5).speed, 5.08);
  assert.equal(recordedLocomotion({ ...player, duck: 0 }, to, 0, 8, 64, 0.5).duck, 0.5);
  for (const [other, end] of [
    [{ ...to, id: 'different' }, 8],
    [{ ...to, alive: false }, 8],
    [to, 64],
    [to, 0],
  ] as const)
    assert.equal(recordedLocomotion(player, other, 0, end, 64, 0).speed, 0);
  assert.equal(recordedLocomotion(player, { ...player, z: 100 }, 0, 8, 64, 0).speed, 0);
});
