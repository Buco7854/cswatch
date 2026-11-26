/** Direct sun on a character from the world geometry that bakes the map's own sun shadows.
 * The probe volume's sun occlusion is a few metres coarse, so a player stepping out of a
 * doorway's shadow stays dark. Rays toward the sun from points along the body give the sharp
 * edge the world's lightmaps show. A sample depends only on the pose, so a seek or a pause
 * settles to the same light. */
import { createContext } from 'react';
import { Vector3, Vector4 } from 'three';
import type { WorldQueries } from './world/queries';

type Point = [number, number, number];
export type ActorSunProbe = {
  hit: WorldQueries['hit'];
  /** Unit direction toward the sun, viewer coordinates. */
  toSun: Vector3;
};
export const ActorSun = createContext<ActorSunProbe | null>(null);

/** Metres above the feet; the shader interpolates between them by fragment height. */
export const actorSunHeights = [0.1, 0.6, 1.1, 1.6] as const;
/** Half the lateral spread of a sample pair: a short penumbra instead of a hard flip. */
const spread = 0.12;
const reach = 96;

const side = new Vector3(),
  from = new Vector3(),
  to = new Vector3();
/** Sun visibility in [0, 1] at each height above `feet` (viewer metres). */
export function sampleActorSun(probe: ActorSunProbe, feet: Vector3, out = new Vector4()) {
  side.set(0, 1, 0).cross(probe.toSun);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const values = actorSunHeights.map((height) => {
    let open = 0;
    for (const offset of [-spread, spread]) {
      from.copy(feet).addScaledVector(side, offset);
      from.y += height;
      to.copy(from).addScaledVector(probe.toSun, reach);
      if (!probe.hit({ target: from.toArray() as Point, position: to.toArray() as Point })) open++;
    }
    return open / 2;
  });
  return out.set(values[0], values[1], values[2], values[3]);
}

/** At most this many characters re-trace per rendered frame; the rest keep their last light. */
export const actorSunBudget = 4;
let frame = -1,
  used = 0;
export function claimActorSunUpdate(renderedFrame: number) {
  if (renderedFrame !== frame) {
    frame = renderedFrame;
    used = 0;
  }
  if (used >= actorSunBudget) return false;
  used++;
  return true;
}
