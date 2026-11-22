/** Recorded entity samples. Coordinates and Euler angles use Source units/Z-up. */
export type PresentItemSample = {
  id: string;
  tick: number;
  present: true;
  equipment: string;
  kind: 'dropped' | 'planted' | 'projectile';
  x: number;
  y: number;
  z: number;
  /** All three values are present together only when recorded. No synthetic spin. */
  pitch?: number;
  yaw?: number;
  roll?: number;
};
export type ItemSample = PresentItemSample | { id: string; tick: number; present: false };
/** Coverage describes observed recorded equipment by category. */
export type ItemStateInfo = {
  complete: boolean;
  /** A missing item category must not invalidate unrelated recorded evidence. */
  coverage: { dropped: boolean; planted: boolean; projectile: boolean };
};
