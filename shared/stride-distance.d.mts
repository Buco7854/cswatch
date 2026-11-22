import type { Position } from './playback.js';
export function strideDisplacement(
  from: Position | undefined,
  to: Position | undefined,
  seconds: number,
): { horizontal: number; vertical: number } | undefined;
export function strideCentimeters(
  from: Position | undefined,
  to: Position | undefined,
  seconds: number,
): number;
