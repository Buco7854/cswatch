import type { Playback } from './types';
import type { CombatMoment } from './review-moments';
import { eventPlayer, roundAt } from './review-events';

export type DamageRow = { playerId?: string; name: string; team?: 2 | 3; damage: number };
export type CombatDamage = {
  taken: DamageRow[];
  dealt: DamageRow[];
  coverage: 'complete' | 'partial' | 'unavailable';
};

/** Recorded round damage up to this elimination, never future hits, match
 * controller totals, nickname joins or an assumed 100 damage for a kill. */
export function combatDamage(
  data: Playback,
  moment: CombatMoment,
  selected: string,
  last: number,
): CombatDamage {
  const round = roundAt(data, moment.tick, last);
  const taken = new Map<string, DamageRow>();
  const dealt = new Map<string, DamageRow>();
  let complete =
    data.eventAvailability?.player_hurt === true &&
    data.events.some((event) => event.type === 'round_start' && event.tick === round.start);
  let observed = false;
  for (const event of data.events) {
    if (
      event.type !== 'player_hurt' ||
      !Number.isSafeInteger(event.tick) ||
      event.tick < round.start ||
      event.tick > moment.tick
    )
      continue;
    const attacker = eventPlayer(data, event, 'attacker');
    const victim = eventPlayer(data, event, 'user');
    // An unresolved participant could be the selected player. It cannot establish
    // complete coverage or be joined by a duplicate or changed nickname.
    if (!attacker || !victim) complete = false;
    const incoming = victim?.id === selected;
    const outgoing = attacker?.id === selected;
    if (!incoming && !outgoing) continue;
    const amount = event.dmg_health;
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > 1_000_000
    ) {
      complete = false;
      continue;
    }
    observed = true;
    const add = (rows: Map<string, DamageRow>, player: typeof attacker, team: unknown) => {
      const key = player?.id || 'unresolved';
      const row = rows.get(key) || {
        playerId: player?.id,
        name: player?.name || '',
        team: team === 2 || team === 3 ? team : undefined,
        damage: 0,
      };
      row.damage += amount;
      rows.set(key, row);
    };
    if (incoming) add(taken, attacker, event.attacker_team_num);
    if (outgoing) add(dealt, victim, event.user_team_num);
  }
  const sorted = (rows: Map<string, DamageRow>) =>
    [...rows.values()].sort(
      (a, b) => b.damage - a.damage || (a.playerId || '').localeCompare(b.playerId || ''),
    );
  return {
    taken: sorted(taken),
    dealt: sorted(dealt),
    coverage: complete ? 'complete' : observed ? 'partial' : 'unavailable',
  };
}
