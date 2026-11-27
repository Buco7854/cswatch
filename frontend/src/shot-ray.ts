import { frameAt, poseTimingAt } from './playback';
import { playerPose } from './player-pose';
import { firstPersonView } from './pov-camera';
import type { WorldQueries } from './world/queries';
import type { Playback } from './types';

type Point = [number, number, number];
/** A recorded shot as it leaves the recorded eye along the recorded aim, ending
 * where it meets the prepared map (scene metres). */
export type ShotRay = {
  from: Point;
  to: Point;
  direction: Point;
  material?: number;
  /** World-space normal of the surface hit. */
  normal?: Point;
};
export const shotReach = 80;

export function recordedShotRay(
  data: Playback,
  id: string,
  tick: number,
  queries: Pick<WorldQueries, 'hit'>,
): ShotRay | null {
  const span = frameAt(data, tick);
  const pawn = span.frame.players.find((player) => player.id === id);
  if (!pawn?.alive) return null;
  const view = firstPersonView(
    playerPose(
      pawn,
      span.next.players.find((player) => player.id === id),
      span.alpha,
      poseTimingAt(data, span, id),
    ),
  );
  const d = view.target.map((value, axis) => value - view.position[axis]);
  const length = Math.hypot(...d);
  if (!length) return null;
  const direction = d.map((value) => value / length) as Point;
  const far = view.position.map((value, axis) => value + direction[axis] * shotReach) as Point;
  const found = queries.hit({ target: view.position, position: far });
  return {
    from: view.position as Point,
    to: found ? (found.point.toArray() as Point) : far,
    direction,
    ...(found ? { material: found.material } : {}),
    ...(found?.normal ? { normal: found.normal.toArray() as Point } : {}),
  };
}
