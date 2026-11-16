import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameAt, skipDeadTime } from '../../frontend/src/playback.js';
import { sample } from '../../frontend/src/sample.js';
test('frame lookup clamps ends and interpolates between adjacent ticks', () => {
  assert.equal(frameAt(sample, -1).frame.tick, 0);
  const state = frameAt(sample, 6);
  assert.equal(state.frame.tick, 4);
  assert.equal(state.next.tick, 8);
  assert.equal(state.alpha, 0.5);
  assert.equal(frameAt(sample, 1e7).alpha, 0);
});
test('dead-time skip respects freeze and timeout boundaries', () => {
  assert.equal(skipDeadTime(sample, 64), 128);
  assert.equal(skipDeadTime(sample, 64, 'timeout'), 64);
  assert.equal(skipDeadTime(sample, 1664), 1792);
  assert.equal(skipDeadTime(sample, 2000), 2000);
  assert.equal(skipDeadTime(sample, 1792), 1792);
});
