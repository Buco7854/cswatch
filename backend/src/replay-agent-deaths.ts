export const { agentDeathLimit, deathAnchor, validAgentDeaths } = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../shared/agent-deaths.mjs' : './agent-deaths.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/agent-deaths.mjs');
import type { Playback } from '../../shared/playback.js';

export function replayAgentDeaths({ events, frames, players, rounds, tickRate }: Playback) {
  const roster = new Set(players.map(({ id }) => id));
  const entries = new Map<string, NonNullable<Playback['agentDeaths']>[number]>();
  for (const event of events) {
    const id = event.user_steamid;
    if (
      event.type !== 'player_death' ||
      typeof id !== 'string' ||
      id === '0' ||
      !/^\d{1,20}$/.test(id) ||
      !roster.has(id) ||
      !Number.isSafeInteger(event.tick) ||
      event.tick < frames[0].tick ||
      event.tick > frames.at(-1)!.tick
    )
      continue;
    const round = rounds.findLast((item) => item.tick <= event.tick);
    if (!round || (round.endTick !== undefined && event.tick >= round.endTick)) continue;
    const anchor = deathAnchor(frames, id, event.tick, round.tick, tickRate);
    if (anchor) entries.set(id + ':' + event.tick, anchor);
    if (entries.size >= agentDeathLimit) break;
  }
  return entries.size ? [...entries.values()] : undefined;
}
