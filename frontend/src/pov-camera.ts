import type { Position } from './types';
import { canonicalEquipmentKey } from './equipment-key';
export type CameraView = { position: [number, number, number]; target: [number, number, number] };
const sniperRifles = new Set(['awp', 'ssg08', 'scar20', 'g3sg1']);

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
