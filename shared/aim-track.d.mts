export type AimChunk = { version: 1; tracks: [id: string, data: string][] };
export type AimTrack = { ticks: Int32Array; angles: Int16Array; connected: Uint8Array };
export type AimSample = [tick: number, yaw: number, pitch: number, continuous: boolean];

export const aimChunkBytes: number;
export function quantizeAim(value: unknown): number | undefined;
export function encodeAimChunk(
  start: number,
  end: number,
  players: ReadonlyMap<string, Iterable<AimSample>>,
): AimChunk | undefined | null;
export function decodeAimChunk(
  value: unknown,
  start: number,
  end: number,
  actors: ReadonlySet<string>,
): Map<string, AimTrack>;
export function sampleAim(
  track: AimTrack,
  tick: number,
): { yaw: number; pitch: number } | undefined;
export function aimBoundary(tracks: ReadonlyMap<string, AimTrack>, tick: number): string;
