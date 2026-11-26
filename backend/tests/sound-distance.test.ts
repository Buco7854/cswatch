import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceGain } from '../../frontend/src/gameplay-playback.js';
import { gameplaySoundRegistry } from '../src/gameplay-sound-registry.js';

test('authored distance curves interpolate between their points and hold beyond them', () => {
  const curve = [
    [25, 0.8],
    [30, 1],
    [440, 0.735294],
    [2500, 0.014706],
  ];
  assert.equal(distanceGain(curve, 0), 0.8);
  assert.equal(distanceGain(curve, 30), 1);
  assert.ok(Math.abs(distanceGain(curve, 235) - (1 + 0.735294) / 2) < 1e-6);
  assert.equal(distanceGain(curve, 9000), 0.014706);
  assert.equal(distanceGain([], 100), 1);
});

test('firearm near and distant layers come from the official events and stay single-layer', () => {
  const items = gameplaySoundRegistry.items;
  const ak = items['ak47-fire'];
  assert.ok(ak.distance && ak.distant);
  const far = items[ak.distant];
  assert.match(far.source, /^sounds\/weapons\/ak47\/ak47_distant\.vsnd_c$/);
  // The distant layer is silent close by and rises with distance, where the near layer fades.
  assert.equal(distanceGain(far.distance!, 500), 0);
  assert.ok(distanceGain(far.distance!, 2300) > distanceGain(ak.distance, 2300));
  for (const item of Object.values(items))
    if (item.distant) assert.equal(items[item.distant].distant, undefined);
});
