export type SmokeTrack = {
  entity: number;
  serial: number;
  start: number;
  end: number;
  origin: [number, number, number];
  color: [number, number, number];
  journal: string;
  /** Recorded replay tick and byte end of that complete journal prefix. */
  updates: [number, number][];
};
export const smokeLimits: Readonly<{
  tracks: number;
  active: number;
  journalBytes: number;
  recordingsBytes: number;
  frames: number;
  updates: number;
  coordinate: number;
}>;
export function validSmokeTracks(value: unknown, lastTick: number): value is SmokeTrack[];
