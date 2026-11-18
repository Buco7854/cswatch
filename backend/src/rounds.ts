/** Native warmup/incomplete round events may contain null or unknown winners.
 * Only the recorded numeric team IDs establish a winning side. */
export function recordedRoundWinner(value: unknown): 2 | 3 | undefined {
  return value === 2 || value === 3 ? value : undefined;
}
