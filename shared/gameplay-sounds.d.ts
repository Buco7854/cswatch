/** Optional gameplay audio. Times and coordinates come from the recording, not actor motion. */
export type GameplaySoundCategory =
  'weapon' | 'footstep' | 'reload' | 'utility' | 'objective' | 'round';
export type GameplaySoundCue = {
  id: string;
  tick: number;
  /** Explicit recorded stop for this native event, never an inferred loop duration. */
  endTick?: number;
  soundId: string;
  category: GameplaySoundCategory;
  evidence: 'game-event' | 'network-sound';
  /** A representative native sample is not the exact Source sound mix or surface selection. */
  selection: 'representative' | 'recorded';
  /** Exact recorded native event name when token/hash resolution succeeded. */
  eventName?: string;
  actor?: string;
  position?: { x: number; y: number; z: number };
  /** Native firearm pitch/yaw in degrees at the recorded origin. A map contact is reconstructed at playback. */
  shotAngles?: { pitch: number; yaw: number };
  volume?: number;
  pitch?: number;
};
export type GameplaySoundInfo = {
  coverage: Record<GameplaySoundCategory, 'available' | 'partial' | 'unavailable'>;
  truncated: boolean;
};
export type SharedGameplaySoundCatalog = {
  schemaVersion: 1;
  items: Record<
    string,
    {
      url: string;
      sha256: string;
      bytes: number;
      durationMs: number;
      sampleRate: number;
      channels: number;
      mime: 'audio/wav';
    }
  >;
};
