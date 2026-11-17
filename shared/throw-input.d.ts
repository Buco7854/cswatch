import type { RecordedInput } from './playback.js';
/** Input read at the exact recorded throw event, retained globally across replay slices.
 * An event-network snapshot is not proof of the player's launch/release command. */
export type ThrowInputSnapshot = {
  eventIndex: number;
  tick: number;
  actorId: string;
} & (
  | { provenance: 'unavailable'; input?: never; sampleTick?: never }
  | {
      provenance: 'event-usercmd' | 'event-network' | 'nearby-network';
      input: RecordedInput;
      sampleTick: number;
    }
);
