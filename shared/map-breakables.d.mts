export type MapPropPose = {
  modelId: string;
  origin: [number, number, number];
  angles: [number, number, number];
};
/** A verified CDynamicProp was explicitly deleted. Ticks are [start, end). */
export type MapBreakable = MapPropPose & { hidden: [number, number][] };
export const breakableLimits: Readonly<{ active: number; tracks: number; intervals: number }>;
export function breakableKey(row: unknown): string | undefined;
export function validMapBreakables(rows: unknown, lastTick: number): rows is MapBreakable[];
export function uniqueBreakableNodes<Node>(
  wanted: { has(key: string): boolean },
  visit: (accept: (node: Node, tag: unknown) => void) => void,
): Map<string, Node | null>;
