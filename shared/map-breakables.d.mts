export type MapPropPose = {
  modelId: string;
  origin: [number, number, number];
  angles: [number, number, number];
};
/** A verified stationary prop or brush was explicitly deleted. Ticks are [start, end). */
export const breakablePoseCodec: 'cell32-angle20';
export type MapBreakable = MapPropPose & {
  hidden: [number, number][];
  className?: 'func_breakable';
  poseCodec?: typeof breakablePoseCodec;
};
export const breakableLimits: Readonly<{ active: number; tracks: number; intervals: number }>;
export function breakableKey(row: unknown): string | undefined;
export function validMapBreakables(rows: unknown, lastTick: number): rows is MapBreakable[];
export function uniqueBreakableNodes<Node>(
  tracks: readonly MapBreakable[] | undefined,
  visit: (accept: (node: Node, tag: unknown) => void) => void,
): Map<string, Node | null>;
export function uniqueDoorNodes<Node>(
  wanted: ReadonlySet<string> | ReadonlyMap<string | undefined, unknown>,
  visit: (accept: (node: Node, tag: unknown) => void) => void,
): Map<string, Node | null>;
export function doorAnglesMatch(recorded: unknown, authored: unknown): boolean;
/** Sparse network observations, Source yaw relative to the authored closed pose.
 * Null releases the channel back to the authored state; explicit deletion is [start,end). */
export type MapDoor = MapPropPose & {
  samples: [number, number | null][];
  hidden: [number, number][];
  models?: [number, string | null][];
};
export const doorLimits: Readonly<{ active: number; tracks: number; samples: number }>;
export function doorKey(row: unknown): string | undefined;
export function validMapDoors(rows: unknown, lastTick: number): rows is MapDoor[];
