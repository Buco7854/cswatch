import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedVariant } from '../src/gameplay-sounds.js';
import { gameplaySoundRegistry } from '../src/gameplay-sound-registry.js';
import { soundTokenHash } from '../src/sound-event-tokens.js';

test('a recorded seed always selects the same authored variation', () => {
  const step = gameplaySoundRegistry.events!['CT_Concrete.StepLeft'];
  assert.equal(step.variants?.length, 17);
  assert.equal(recordedVariant(step, 0), step.variants![0]);
  assert.equal(recordedVariant(step, 18), step.variants![1]);
  assert.equal(recordedVariant(step, 18), recordedVariant(step, 18));
  // Missing or malformed seeds keep the representative sample.
  for (const seed of [undefined, null, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 2])
    assert.equal(recordedVariant(step, seed), step.soundId);
  assert.equal(recordedVariant({ soundId: 'footstep' }, 5), 'footstep');
});

test('body and footstep events carry complete authored variations and distance curves', () => {
  const { items, events } = gameplaySoundRegistry;
  for (const [name, event] of Object.entries(events!)) {
    for (const id of event.variants ?? []) assert.ok(items[id], `${name} variant ${id}`);
    // The representative sample is one of the authored variations.
    if (event.variants) assert.ok(event.variants.includes(event.soundId), name);
    if (event.distance)
      for (let i = 1; i < event.distance.length; i++)
        assert.ok(event.distance[i][0] >= event.distance[i - 1][0], name);
    if (event.channel === 'sos') assert.equal(event.hash, soundTokenHash(name), name);
  }
  assert.deepEqual(events!['Player.Death'].distance, [
    [0, 1],
    [113.911, 0.593],
    [1400, 0],
  ]);
  assert.equal(events!['Player.Death'].variants?.length, 6);
  // Footsteps fade out where the game stops playing them.
  assert.deepEqual(events!['T_Concrete.StepLeft'].distance?.at(-1), [1100, 0]);
});
