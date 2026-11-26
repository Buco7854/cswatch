import { expect, test } from '@playwright/test';
import { Vector3 } from 'three';
import { activeBloodDecals, bloodDecalSeconds, bloodPlacement } from '../src/blood-decals';
import { indexBodyHits } from '../src/body-hits';

/** The attacker at the origin aims along +x (Source yaw 0) at a victim 2 m away. */
function replay(hitgroup = 'chest') {
  const player = (id: string, x: number, yaw: number, team: number) => ({
    id,
    x,
    y: 0,
    z: 0,
    yaw,
    pitch: 0,
    alive: true,
    team,
    health: 100,
    weapon: 'ak47',
  });
  return {
    map: 'de_test',
    tickRate: 64,
    sample: false,
    players: [],
    rounds: [],
    frames: Array.from({ length: 40 }, (_, i) => ({
      tick: i * 16,
      players: [player('a', 0, 0, 3), player('v', 2 / 0.0254, 180, 2)],
    })),
    events: [
      {
        type: 'player_hurt',
        tick: 64,
        user_steamid: 'v',
        attacker_steamid: 'a',
        weapon: 'ak47',
        hitgroup,
        health: 40,
        dmg_armor: 0,
      },
    ],
  } as unknown as Parameters<typeof bloodPlacement>[0];
}
type Segment = { target: [number, number, number]; position: [number, number, number] };
/** A wall facing -x at x = 3 m. */
const wall = (segment: Segment) => {
  const [x0, y0, z0] = segment.target,
    [x1, y1, z1] = segment.position;
  if (x1 <= 3 || x0 >= 3) return null;
  const t = (3 - x0) / (x1 - x0);
  return {
    point: new Vector3(3, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t),
    distance: t * Math.hypot(x1 - x0, y1 - y0, z1 - z0),
    entity: -1,
    material: 0,
    // Either side of a triangle may come back; the decal faces the shot.
    normal: new Vector3(1, 0, 0),
  };
};
/** Floor at y = 0 only. */
const floor = (segment: Segment) => {
  const [x0, y0, z0] = segment.target,
    [, y1] = segment.position;
  if (!(y0 > 0 && y1 < 0)) return null;
  return {
    point: new Vector3(x0, 0, z0),
    distance: y0,
    entity: -1,
    material: 0,
    normal: new Vector3(0, -1, 0),
  };
};

test('blood lands on the wall behind the recorded hit, facing the shot', () => {
  const data = replay();
  const [hit] = indexBodyHits(data.events);
  const placement = bloodPlacement(data, hit, wall as never)!;
  expect(placement.wall).toBe(true);
  expect(placement.normal.distanceTo(new Vector3(-1, 0, 0))).toBeCloseTo(0, 9);
  expect(placement.center.x).toBeCloseTo(3 - 0.004, 6);
  // Chest height above the recorded feet.
  expect(placement.center.y).toBeCloseTo(1.3, 1);
  expect(placement.along.dot(placement.normal)).toBeCloseTo(0, 6);
  // Cached and deterministic for the same hit.
  expect(bloodPlacement(data, hit, wall as never)).toBe(placement);
});

test('without a wall within reach the blood falls to the floor; nothing to land on leaves none', () => {
  const data = replay('head');
  const [hit] = indexBodyHits(data.events);
  const placement = bloodPlacement(data, hit, floor as never)!;
  expect(placement.wall).toBe(false);
  expect(placement.normal.distanceTo(new Vector3(0, 1, 0))).toBeCloseTo(0, 9);
  expect(placement.center.y).toBeCloseTo(0.004, 6);
  expect(placement.center.x).toBeCloseTo(2.6, 2);
  expect(bloodPlacement(replay(), indexBodyHits(replay().events)[0], (() => null) as never)).toBe(
    undefined,
  );
});

test('decals are short-lived and fade before they leave', () => {
  const data = replay();
  const query = wall as never;
  expect(activeBloodDecals(data, 64, query)).toHaveLength(0);
  const fresh = activeBloodDecals(data, 64 + 8, query);
  expect(fresh).toHaveLength(1);
  expect(fresh[0].alpha).toBe(1);
  const fading = activeBloodDecals(data, 64 + 64 * (bloodDecalSeconds - 1), query)[0];
  expect(fading.alpha).toBeCloseTo(0.5, 6);
  expect(activeBloodDecals(data, 64 + 64 * (bloodDecalSeconds + 0.1), query)).toHaveLength(0);
});
