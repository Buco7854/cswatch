import type { GameplaySoundCue } from '../../shared/gameplay-sounds';
import registry from '../../shared/gameplay-sounds.json';
import type { CameraView } from './pov-camera';
import { impactSurfaceProperty } from './shot-impacts';

const events = registry.events as Record<string, { soundId: string } | undefined>;
/** The surface's official bullet impact sample, or the default one. */
export const wallImpactSampleFor = (material: string | undefined) =>
  events[impactSurfaceProperty(material).sound]?.soundId ?? wallImpactSample;

export type WallTrace = ((segment: CameraView) => CameraView['position']) & {
  /** The authored material name of the first world triangle along the segment. */
  surface?: (segment: CameraView) => string | undefined;
};
export const wallImpactSample = registry.events['Default.BulletImpact'].soundId;
const metresPerInch = 0.0254;
const reach = 12;

/** The shot origin and aim are recorded. Only an intersection with loaded world
 * triangles supplies the representative impact position. */
export function nearWallContact(cue: GameplaySoundCue, trace: WallTrace) {
  if (!cue.position || !cue.shotAngles) return;
  const { x, y, z } = cue.position;
  const pitch = (cue.shotAngles.pitch * Math.PI) / 180;
  const yaw = (cue.shotAngles.yaw * Math.PI) / 180;
  const horizontal = reach * Math.cos(pitch);
  const origin: CameraView['position'] = [x * metresPerInch, z * metresPerInch, -y * metresPerInch];
  const end: CameraView['position'] = [
    origin[0] + horizontal * Math.cos(yaw),
    origin[1] - reach * Math.sin(pitch),
    origin[2] - horizontal * Math.sin(yaw),
  ];
  const hit = trace({ target: origin, position: end });
  if (hit === end) return;
  return {
    x: hit[0] / metresPerInch,
    y: -hit[2] / metresPerInch,
    z: hit[1] / metresPerInch,
    material: trace.surface?.({ target: origin, position: end }),
  };
}
