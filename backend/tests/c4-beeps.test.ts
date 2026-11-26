import assert from 'node:assert/strict';
import test from 'node:test';
import { c4BeepCues } from '../../frontend/src/c4-beeps.js';

const rate = 64;

test('C4 beeps follow the recorded timer, accelerate and stop at the recorded defuse', () => {
  const objectives = {
    complete: true,
    samples: [
      {
        kind: 'plant',
        tick: 0,
        entity: 'plant',
        present: true,
        arming: true,
        actor: 'p',
        endTick: 200,
      },
      {
        kind: 'bomb',
        tick: 200,
        entity: 'b',
        present: true,
        ticking: true,
        endTick: 200 + 40 * rate,
        duration: 40,
      },
      {
        kind: 'bomb',
        tick: 200 + 30 * rate,
        entity: 'b',
        present: true,
        ticking: false,
        defused: true,
      },
    ],
  };
  const cues = c4BeepCues(objectives as never, rate, () => ({ x: 1, y: 2, z: 3 }));
  assert.equal(cues[0].tick, 200);
  assert.deepEqual(cues[0].position, { x: 1, y: 2, z: 3 });
  assert.equal(cues[0].evidence, 'recorded-state');
  // One second between the first beeps; faster as the deadline approaches.
  assert.equal(cues[1].tick - cues[0].tick, rate);
  const gaps = cues.slice(1).map((cue, i) => cue.tick - cues[i].tick);
  assert.ok(gaps.at(-1)! < gaps[0]);
  assert.ok(cues.every((cue) => cue.tick < 200 + 30 * rate));
  assert.deepEqual(
    c4BeepCues(undefined, rate, () => undefined),
    [],
  );
});
