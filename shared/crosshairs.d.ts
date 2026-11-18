/** Exact controller crosshair changes, joined only by immutable Steam ID. */
export type CrosshairSample = { tick: number; actor: string; code: string | null };
export type CrosshairData = {
  samples: CrosshairSample[];
  /** False after parser failure or a bounded output limit. */
  complete: boolean;
};
