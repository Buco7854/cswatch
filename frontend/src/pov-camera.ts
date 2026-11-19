import type { Position } from './types';
export type CameraView = { position: [number, number, number]; target: [number, number, number] };
/** Fit the same recorded horizontal extent on portrait and landscape canvases. */
export function overheadDistance(extent: number, verticalFov: number, aspect: number) {
  return (
    (Math.max(1, extent) * 1.05) /
    (2 * Math.tan((verticalFov * Math.PI) / 360) * Math.min(1, Math.max(0.1, aspect)))
  );
}
/** Shared spectator eye placement from recorded position/angles and the viewer's
 * standing/duck eye offset. Source units are inches/Z-up; output is meters/Y-up. */
export function firstPersonView(
  player: Pick<Position, 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'duck'>,
): CameraView {
  const yaw = (player.yaw * Math.PI) / 180,
    pitch = (player.pitch * Math.PI) / 180;
  const position: [number, number, number] = [
    player.x * 0.0254,
    player.z * 0.0254 + 1.65 - (player.duck ?? 0) * 0.7,
    -player.y * 0.0254,
  ];
  return {
    position,
    target: [
      position[0] + Math.cos(yaw) * Math.cos(pitch) * 8,
      position[1] - Math.sin(pitch) * 8,
      position[2] - Math.sin(yaw) * Math.cos(pitch) * 8,
    ],
  };
}
