import { expect, test } from '@playwright/test';
import { createFollowBoom } from '../src/follow-camera';

test('the follow boom pulls in at once, eases back out and snaps on a new player or a time jump', () => {
  const boom = createFollowBoom();
  expect(boom.update('a', 0, 2.7)).toBe(2.7);
  // A wall at 1.1 m pulls the lens in on the same frame.
  expect(boom.update('a', 1 / 60, 1.1)).toBe(1.1);
  // Clear again: it eases out without overshoot.
  let length = 1.1;
  for (let frame = 2; frame < 20; frame++) {
    const next = boom.update('a', frame / 60, 2.7);
    expect(next).toBeGreaterThan(length);
    expect(next).toBeLessThan(2.7);
    length = next;
  }
  expect(boom.settling(2.7)).toBe(true);
  // A grazing wall that flickers between two lengths never pushes the lens outward first.
  const flicker = createFollowBoom();
  flicker.update('a', 0, 1.5);
  const samples = [1.5, 1.52, 1.5, 1.52, 1.5].map((allowed, i) =>
    flicker.update('a', (i + 1) / 60, allowed),
  );
  expect(Math.max(...samples) - Math.min(...samples)).toBeLessThan(0.002);
  // Another player, or a seek, starts from that player's allowed length.
  expect(boom.update('b', 1, 2.0)).toBe(2.0);
  expect(boom.update('b', 5, 2.7)).toBe(2.7);
});
