import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DemoReader } from 'cs2parser';
import type { Frame } from '../../shared/playback.js';
import type { MatchPerformance, MatchRank } from '../../shared/library-match.js';

export const performanceFile = 'match-performance.json';
export const performanceBytes = 64 * 1024;
const count = z.number().int().min(0).max(1_000_000_000);
const rank = z
  .object({
    mode: z.enum(['Premier', 'Wingman', 'Competitive']),
    value: z.number().int().positive().max(100000),
    change: z.number().int().min(-100000).max(100000).optional(),
  })
  .strict()
  .refine((value) => value.mode === 'Premier' || value.value <= 18);
const performance = z.record(
  z.string().regex(/^\d{1,20}$/),
  z
    .object({
      kills: count.optional(),
      deaths: count.optional(),
      assists: count.optional(),
      headshotKills: count.optional(),
      rank: rank.optional(),
    })
    .strict(),
);

function recordedRank(type: unknown, value: unknown): MatchRank | undefined {
  const mode =
    type === 11 ? 'Premier' : type === 12 ? 'Competitive' : type === 7 ? 'Wingman' : undefined;
  if (
    !mode ||
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > (mode === 'Premier' ? 100000 : 18)
  )
    return;
  return { mode, value };
}

/** Capture the controller at the final sampled frame. A matching server-issued
 * rank update can also establish the new rank and the change for that match. */
export function observeMatchPerformance(
  reader: DemoReader,
  actors: ReadonlySet<string>,
  final?: Frame,
) {
  const results: Record<string, MatchPerformance> = {};
  for (const { id, stats } of final?.players ?? []) {
    if (!stats || !actors.has(id)) continue;
    const { kills, deaths, assists, headshotKills } = stats;
    results[id] = { kills, deaths, assists, headshotKills };
  }
  const updates = new Map<string, Map<MatchRank['mode'], MatchRank>>();
  reader.on('CS_UM_ServerRankUpdate', ({ rank_update }) => {
    for (const row of rank_update.slice(0, 128)) {
      const account = row.account_id;
      if (
        account === undefined ||
        !Number.isInteger(account) ||
        account <= 0 ||
        account > 0xffffffff
      )
        continue;
      const id = (76561197960265728n + BigInt(account)).toString();
      if (!actors.has(id)) continue;
      const next = recordedRank(row.rank_type_id, row.rank_new);
      if (!next) continue;
      const prior = recordedRank(row.rank_type_id, row.rank_old);
      if (prior) next.change = next.value - prior.value;
      const modes = updates.get(id) ?? new Map<MatchRank['mode'], MatchRank>();
      modes.set(next.mode, next);
      updates.set(id, modes);
    }
  });
  reader.on('tickend', () => {
    if (!final || reader.currentTick !== final.tick) return;
    for (const controller of reader.playerControllers) {
      const id = controller.steamId;
      if (!id || !actors.has(id)) continue;
      const props = controller.entity?.properties;
      const observed = recordedRank(
        props?.['CCSPlayerController.m_iCompetitiveRankType'],
        props?.['CCSPlayerController.m_iCompetitiveRanking'],
      );
      if (observed) (results[id] ??= {}).rank = observed;
    }
  });
  return () => {
    for (const [id, modes] of updates) {
      const observed = results[id]?.rank;
      const update = observed
        ? modes.get(observed.mode)
        : modes.size === 1
          ? modes.values().next().value
          : undefined;
      if (update) (results[id] ??= {}).rank = update;
    }
    return results;
  };
}

/** Private, bounded child output. Only the requested member's record is ever
 * returned by a library route. The scratch file is never published with the replay. */
export function readMatchPerformance(folder: string, players: { id: string }[]) {
  const path = join(folder, performanceFile);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > performanceBytes)
    throw new Error('Invalid match performance file');
  const results = performance.parse(JSON.parse(readFileSync(path, 'utf8')));
  const actors = new Set(players.map((player) => player.id));
  if (Object.keys(results).some((id) => !actors.has(id)))
    throw new Error('Invalid match performance identity');
  return results;
}
