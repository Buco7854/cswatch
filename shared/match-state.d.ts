/** Recorded side scores and game-rule clocks. Samples are complete snapshots,
 * not patches. Missing fields stay unknown; identities never follow nicknames. */
export type MatchPhase =
  | 'warmup'
  | 'freeze'
  | 'live'
  | 'timeout'
  | 'technical'
  | 'paused'
  | 'round-end'
  | 'intermission'
  | 'game-over';
export type MatchClock = {
  kind: 'round' | 'freeze' | 'timeout' | 'warmup';
  startTick?: number;
  endTick?: number;
  paused?: boolean;
  /** Actual recorded pause-start network tick mapped into the demo clock. */
  pausedAtTick?: number;
};
export type MatchStateSample = {
  tick: number;
  ctScore?: number;
  tScore?: number;
  /** Recorded start counter, or completed-round counter plus recorded win status.
   * Never a local replay ordinal, score total or fixed-half calculation. */
  roundNumber?: number;
  roundNumberSource?: 'round-start' | 'completed-counter';
  roundsPlayed?: number;
  overtime?: number;
  gamePhase?: number;
  phase?: MatchPhase;
  clock?: MatchClock;
};
export type MatchStateData = { complete: boolean; samples: MatchStateSample[] };
/** A successful event query can establish zero events. Missing/failed queries cannot. */
export type EventAvailability = { player_death: boolean; player_hurt: boolean };
