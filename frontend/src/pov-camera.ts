import type { Position } from './types';
import type { EquipmentModel, EquipmentModelTransform } from '../../shared/equipment-models';
import { canonicalEquipmentKey } from './equipment-key';
export type CameraView = { position: [number, number, number]; target: [number, number, number] };
const sniperRifles = new Set(['awp', 'ssg08', 'scar20', 'g3sg1']);

export const povNear = 0.025;
export const povFar = 8;
// The standard first-person placement is 2.5 Source inches right, zero forward
// and 1.5 inches down. The authored arms already include their distance from the eye.
export const povOffset = { right: 2.5 * 0.0254, up: -1.5 * 0.0254, forward: 0 };

/** A 68° horizontal lens at 4:3. Fit at least a square aperture on tall
 * canvases, while retaining their real aspect ratio and undistorted geometry. */
export function povProjection(viewportAspect: number) {
  const aspect = Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 16 / 9;
  const tangent = 0.75 * Math.tan((68 * Math.PI) / 360);
  const fov = (2 * Math.atan(tangent / Math.min(1, aspect)) * 180) / Math.PI;
  return { aspect, fov };
}

/** Eye-relative fallback from the weapon-frame bounds. Preserve native scale. */
export function staticPovAttachment(bounds: EquipmentModel['bounds']): EquipmentModelTransform {
  // Farther from the lens for wide/long silhouettes, with space below the reticle.
  const height = bounds.max[1] - bounds.min[1];
  const width = bounds.max[2] - bounds.min[2];
  const near = Math.max(0.32, height * 2.2, width * 1.3);
  return {
    position: [
      0.13 + Math.max(0.45, near - bounds.min[0]),
      -0.192 - povOffset.up - bounds.max[1],
      0.19 - (bounds.max[2] + bounds.min[2]) / 2,
    ],
    rotation: [0, 0, 0],
    scale: 1,
  };
}

/** Bring the static fallback in from the right edge on narrow canvases. */
export function fitPovAttachment(
  preset: EquipmentModelTransform,
  viewportAspect: number,
): EquipmentModelTransform {
  const { aspect } = povProjection(viewportAspect);
  const lateral = Math.min(1, Math.max(0.1, aspect) / 1.6);
  return {
    ...preset,
    position: [preset.position[0], preset.position[1], preset.position[2] * lateral],
  };
}

/** Convert the recorded Source horizontal reference to Three.js vertical degrees. */
export function scopedVerticalFov(player: Position | undefined) {
  if (
    !player?.alive ||
    !player.scoped ||
    player.scopeFov === undefined ||
    !Number.isSafeInteger(player.scopeFov) ||
    player.scopeFov < 5 ||
    player.scopeFov >= 90 ||
    !sniperRifles.has(canonicalEquipmentKey(player.weapon))
  )
    return;
  return (2 * Math.atan(0.75 * Math.tan((player.scopeFov * Math.PI) / 360)) * 180) / Math.PI;
}
/** Fit the same recorded horizontal extent on portrait and landscape canvases. */
export function overheadDistance(extent: number, verticalFov: number, aspect: number) {
  return (
    (Math.max(1, extent) * 1.05) /
    (2 * Math.tan((verticalFov * Math.PI) / 360) * Math.min(1, Math.max(0.1, aspect)))
  );
}
/** Source units are inches/Z-up. The viewer eye is in meters/Y-up. */
export function recordedEyePosition(
  player: Pick<Position, 'x' | 'y' | 'z' | 'duck' | 'eyeOffset'>,
): CameraView['position'] {
  const offset = player.eyeOffset;
  const ox = offset?.length === 3 ? offset[0] : 0;
  const oy = offset?.length === 3 ? offset[1] : 0;
  const height = offset ? offset[offset.length - 1] * 0.0254 : 1.65 - (player.duck ?? 0) * 0.7;
  return [(player.x + ox) * 0.0254, player.z * 0.0254 + height, -(player.y + oy) * 0.0254];
}

export function firstPersonView(
  player: Pick<Position, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'duck' | 'eyeOffset'>,
): CameraView {
  const yaw = (player.yaw * Math.PI) / 180,
    pitch = (player.pitch * Math.PI) / 180;
  const position = recordedEyePosition(player);
  return {
    position,
    target: [
      position[0] + Math.cos(yaw) * Math.cos(pitch) * 8,
      position[1] - Math.sin(pitch) * 8,
      position[2] - Math.sin(yaw) * Math.cos(pitch) * 8,
    ],
  };
}
