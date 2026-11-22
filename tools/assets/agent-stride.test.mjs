import assert from 'node:assert/strict';
import test from 'node:test';
import { agentStride } from './agent-stride.mjs';

const times = Array.from({ length: 33 }, (_, i) => i / 32);
function track(x, z) {
  return times.map((time) =>
    [0, 0.5].map((offset) => {
      const phase = (time + offset) % 1;
      const plant = phase <= 0.5;
      const stride = plant ? 0.5 - phase : phase - 0.5;
      return [x * stride * 2, plant ? 0 : 0.2, z * stride * 2];
    }),
  );
}

test('in-place stride uses planted foot travel and rejects a mirrored source', () => {
  const west = agentStride('rifle-walk-w', track(1, 0), times, 1, [0, 0, 0]);
  assert.equal(west.strideSource, 'plant');
  assert.equal(west.strideMeters, 2);
  assert.equal(west.directionAlignment, 1);
  assert.throws(
    () => agentStride('rifle-walk-e', track(1, 0), times, 1, [0, 0, 0]),
    /direction does not match/,
  );
  const east = agentStride('rifle-walk-e', track(-1, 0), times, 1, [0, 0, 0]);
  assert.equal(east.strideMeters, west.strideMeters);
  assert.ok(Math.abs(east.phaseOffset - west.phaseOffset) < 1e-12);
});

test('authored root travel, when present, determines cycle distance', () => {
  const back = agentStride('pistol-run-s', track(0, -1), times, 1, [0, 0, -3]);
  assert.equal(back.strideSource, 'root');
  assert.equal(back.strideMeters, 3);
});
