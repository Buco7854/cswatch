export type InfernoPoint = [x: number, y: number, z: number];
export type InfernoDelta = [slot: number] | [slot: number, ...InfernoPoint];
export type InfernoUpdate = [tick: number, changes: InfernoDelta[]];
export type InfernoTrack = {
  entity: number;
  serial: number;
  end: number;
  updates: InfernoUpdate[];
};
export type InfernoBank = { version: 1; tracks: InfernoTrack[] };

export const infernoLimits: Readonly<{
  slots: number;
  scale: number;
  coordinate: number;
  tracks: number;
  active: number;
  trackUpdates: number;
  updates: number;
  trackBytes: number;
  recordingBytes: number;
  trackOverhead: number;
}>;
export function infernoUpdateBytes(update: InfernoUpdate): number;
export function validInfernoBank(value: unknown, lastTick: number): value is InfernoBank;
