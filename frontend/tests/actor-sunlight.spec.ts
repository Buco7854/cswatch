import { expect, test } from '@playwright/test';
import { Vector3 } from 'three';
import {
  actorSunBudget,
  actorSunHeights,
  claimActorSunUpdate,
  sampleActorSun,
} from '../src/actor-sunlight';

type Segment = { target: [number, number, number]; position: [number, number, number] };
/** A wall 1 m tall standing between the body and a low sun along +x. */
function wall(top: number) {
  return (segment: Segment) => {
    const [x0, y0] = segment.target,
      [x1, y1] = segment.position;
    if (x1 <= 1 || x0 >= 1) return null;
    const t = (1 - x0) / (x1 - x0),
      y = y0 + (y1 - y0) * t;
    return y < top ? ({ distance: t } as unknown as ReturnType<never>) : null;
  };
}

test('sun visibility is sampled along the body from the world geometry', () => {
  const toSun = new Vector3(1, 0.25, 0).normalize();
  const hit = wall(1.0) as never;
  const samples = sampleActorSun({ hit, toSun }, new Vector3(0, 0, 0));
  // Low samples are behind the wall; the head clears it.
  expect(samples.x).toBe(0);
  expect(samples.w).toBe(1);
  expect(actorSunHeights).toEqual([0.1, 0.6, 1.1, 1.6]);
  // The same pose gives the same light.
  expect(sampleActorSun({ hit, toSun }, new Vector3(0, 0, 0)).toArray()).toEqual(samples.toArray());
  // Open sky: fully lit.
  expect(sampleActorSun({ hit: (() => null) as never, toSun }, new Vector3()).toArray()).toEqual([
    1, 1, 1, 1,
  ]);
});

test('only a bounded number of bodies re-trace per frame', () => {
  let granted = 0;
  for (let i = 0; i < 10; i++) if (claimActorSunUpdate(41)) granted++;
  expect(granted).toBe(actorSunBudget);
  expect(claimActorSunUpdate(42)).toBe(true);
});
