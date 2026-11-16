import type { Playback, GameEvent } from './types';

export type ReviewRound = { number: number; start: number; end: number; liveTick?: number };
export type ReviewEvent = {
  id: string;
  tick: number;
  type: 'kill' | 'death' | 'elimination' | 'plant' | 'defuse' | 'explosion' | 'round-end' | 'throw';
  actor: string;
  target?: string;
  weapon?: string;
  team?: number;
  selected: boolean;
  headshot?: boolean;
};

/** Inclusive boundaries assign a boundary event to one round, including the final match tick. */
export function roundAt(data: Playback, tick: number, last: number): ReviewRound {
  const rounds = [...data.rounds].sort((a, b) => a.tick - b.tick);
  if (!rounds.length) return { number: 1, start: 0, end: last };
  let index = rounds.length - 1;
  while (index > 0 && rounds[index].tick > tick) index--;
  const round = rounds[index];
  return {
    number: round.number,
    start: round.tick,
    end: Math.min(last, rounds[index + 1] ? rounds[index + 1].tick - 1 : last),
    liveTick: round.liveTick,
  };
}

function eventPlayer(data: Playback, event: GameEvent, role: 'attacker' | 'user') {
  const id = event[`${role}_steamid`];
  if (typeof id === 'string' && id !== '0') return data.players.find((player) => player.id === id);
  // Names are never identity in real replays. The original practice fixture alone has synthetic IDs.
  if (data.sample) {
    const matches = data.players.filter((player) => player.name === event[`${role}_name`]);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

export function roundEvents(
  data: Playback,
  round: ReviewRound,
  selected: string,
  scope: 'all' | 'player' = 'all',
): ReviewEvent[] {
  return data.events
    .flatMap<ReviewEvent>((event, index) => {
      if (event.tick < round.start || event.tick > round.end || !Number.isSafeInteger(event.tick))
        return [];
      const attacker = eventPlayer(data, event, 'attacker'),
        user = eventPlayer(data, event, 'user');
      const actor = typeof event.user_name === 'string' ? event.user_name : user?.name || '';
      const base = { id: `${event.tick}:${event.type}:${index}`, tick: event.tick };
      if (event.type === 'player_death') {
        const death = user?.id === selected,
          kill = attacker?.id === selected;
        if (scope === 'player' && !death && !kill) return [];
        return [
          {
            ...base,
            type: death ? 'death' : kill ? 'kill' : 'elimination',
            actor:
              typeof event.attacker_name === 'string' ? event.attacker_name : attacker?.name || '',
            target: actor,
            weapon: typeof event.weapon === 'string' ? event.weapon : undefined,
            headshot: event.headshot === true,
            selected: death || kill,
          } satisfies ReviewEvent,
        ];
      }
      const weapon = typeof event.weapon === 'string' ? event.weapon.replace(/^weapon_/, '') : '';
      if (
        event.type === 'grenade_thrown' ||
        (event.type === 'weapon_fire' &&
          ['smokegrenade', 'flashbang', 'hegrenade', 'molotov', 'incgrenade', 'decoy'].includes(
            weapon,
          ))
      ) {
        if (scope === 'player' && user?.id !== selected) return [];
        return [
          {
            ...base,
            type: 'throw',
            actor,
            weapon,
            selected: user?.id === selected,
          } satisfies ReviewEvent,
        ];
      }
      const objectives = {
        bomb_planted: 'plant',
        bomb_defused: 'defuse',
        bomb_exploded: 'explosion',
        round_end: 'round-end',
      } as const;
      const type = objectives[event.type as keyof typeof objectives];
      if (!type) return [];
      return [
        {
          ...base,
          type,
          actor,
          selected: user?.id === selected,
          team:
            event.type === 'round_end' && typeof event.winner === 'number'
              ? event.winner
              : undefined,
        } satisfies ReviewEvent,
      ];
    })
    .sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}
