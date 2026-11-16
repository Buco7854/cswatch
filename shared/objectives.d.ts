/** Source objective state, captured at recorded demo ticks. Deadline values are demo ticks. */
export type PlantObjectiveSample = {
  kind: 'plant';
  tick: number;
  entity: string;
  present: boolean;
  arming?: boolean;
  actor?: string;
  /** Recorded CC4.m_fArmedTime mapped from server time; not a default plant duration. */
  endTick?: number;
};
export type BombObjectiveSample = {
  kind: 'bomb';
  tick: number;
  entity: string;
  present: boolean;
  ticking?: boolean;
  beingDefused?: boolean;
  defused?: boolean;
  exploded?: boolean;
  /** Recorded defuser Steam ID, resolved through the complete network pawn handle. */
  actor?: string;
  site?: 0 | 1;
  endTick?: number;
  duration?: number;
  defuseEndTick?: number;
  defuseDuration?: number;
};
export type ObjectiveSample = PlantObjectiveSample | BombObjectiveSample;
export type ObjectiveData = {
  samples: ObjectiveSample[];
  /** False after parser failure or a bounded output limit. */
  complete: boolean;
};
