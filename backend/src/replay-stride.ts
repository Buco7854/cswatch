import type { Playback } from '../../shared/playback.js';
const { strideCentimeters } = (await import(
  import.meta.url.endsWith('.ts') ? '../../shared/stride-distance.mjs' : './stride-distance.mjs'
)) as typeof import('../../shared/stride-distance.mjs');

/** Compute at actual write boundaries after byte-adaptive chunking. */
export function replayStride(data: Playback) {
  const actors = new Set(
    data.players.map((player) => player.id).filter((id) => /^\d{1,20}$/.test(id)),
  );
  const starts = data.rounds.map((round) => round.tick).sort((a, b) => a - b);
  const distances = new Map<string, number>();
  let cursor = 0;
  let round = 0;
  return (offset: number): [string, number][] => {
    while (cursor < offset) {
      const from = data.frames[cursor++],
        to = data.frames[cursor];
      while (round < starts.length && starts[round] <= from.tick) round++;
      if ((starts[round] ?? Infinity) <= to.tick) continue;
      const positions = new Map(from.players.map((position) => [position.id, position]));
      const elapsed = (to.tick - from.tick) / data.tickRate;
      for (const position of to.players) {
        if (!actors.has(position.id)) continue;
        const distance = strideCentimeters(positions.get(position.id), position, elapsed);
        if (distance) distances.set(position.id, (distances.get(position.id) ?? 0) + distance);
      }
    }
    return [...actors].map((actor) => [actor, distances.get(actor) ?? 0]);
  };
}
