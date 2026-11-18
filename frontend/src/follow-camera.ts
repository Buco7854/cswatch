/** Approximate spectator follow camera. Inputs are recorded Source inches/Z-up, output is viewer meters/Y-up. */
export type FollowSample = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  duck?: number;
};
type Vec3 = [number, number, number];
export type FollowCamera = { actor: string; position: Vec3; target: Vec3 };
const coordinate = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1e7;
const valid = (sample: FollowSample) =>
  !!sample.id &&
  [sample.x, sample.y, sample.z, sample.yaw].every(coordinate) &&
  (sample.duck === undefined || Number.isFinite(sample.duck));
export function thirdPersonFollow(
  from: FollowSample,
  next: FollowSample | undefined,
  alpha: number,
): FollowCamera | null {
  if (!valid(from)) return null;
  const to = next && next.id === from.id && next.alive === from.alive && valid(next) ? next : from;
  const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
  const yaw =
    (((from.yaw + (((((to.yaw - from.yaw) % 360) + 540) % 360) - 180) * blend) % 360) * Math.PI) /
    180;
  const x = (from.x + (to.x - from.x) * blend) * 0.0254,
    y = (from.z + (to.z - from.z) * blend) * 0.0254,
    z = -(from.y + (to.y - from.y) * blend) * 0.0254;
  const crouch = Math.min(1, Math.max(0, from.duck ?? 0)) * 0.7;
  // A small shoulder offset makes the held model visible without changing native geometry.
  return {
    actor: from.id,
    position: [
      x - Math.cos(yaw) * 2.6 + Math.sin(yaw) * 0.65,
      y + 1.6 - crouch,
      z + Math.sin(yaw) * 2.6 + Math.cos(yaw) * 0.65,
    ],
    target: [x, y + 1.25 - crouch, z],
  };
}
