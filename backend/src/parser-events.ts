import { parseEvent, parseEvents } from '@laihoe/demoparser2';
import type { GameEvent } from '../../shared/playback.js';
import type { EventAvailability } from '../../shared/match-state.js';
import { eventInputFields, readEventRows } from './throw-input.js';

type Group = { kinds: string[]; player?: string[][]; other?: string[] };
const groups: Group[] = [
  { kinds: ['player_death', 'player_hurt'], player: [['team_num']] },
  {
    kinds: ['weapon_fire', 'grenade_thrown'],
    player: [
      ['X', 'Y', 'Z'],
      eventInputFields.filter((field) => !field.startsWith('usercmd_')),
      eventInputFields.filter((field) => field.startsWith('usercmd_')),
    ],
  },
  { kinds: ['round_start', 'round_freeze_end', 'round_end'] },
  {
    kinds: [
      'bomb_planted',
      'bomb_beginplant',
      'bomb_abortplant',
      'bomb_begindefuse',
      'bomb_abortdefuse',
      'bomb_defused',
      'bomb_exploded',
    ],
    player: [['has_defuser']],
    other: ['game_time'],
  },
  {
    kinds: [
      'smokegrenade_detonate',
      'smokegrenade_expired',
      'flashbang_detonate',
      'hegrenade_detonate',
      'inferno_startburn',
      'inferno_expire',
    ],
  },
];

type Row = Record<string, any>;

function readSingle(
  source: string,
  kind: string,
  { player, other }: Group,
  single: typeof parseEvent,
): Row[] {
  if (other) {
    try {
      return single(source, kind, player?.flat(), other);
    } catch {
      return single(source, kind);
    }
  }
  if (player) return readEventRows((fields) => single(source, kind, fields), player);
  return single(source, kind);
}

export function readGameEvents(source: string, batch = parseEvents, single = parseEvent) {
  const events: GameEvent[] = [];
  const warnings: string[] = [];
  const eventAvailability: EventAvailability = { player_death: false, player_hurt: false };
  for (const group of groups) {
    const { kinds, player, other } = group;
    let byKind: Map<string, Row[]> | undefined;
    try {
      const grouped = new Map(kinds.map((kind): [string, Row[]] => [kind, []]));
      for (const row of batch(source, kinds, player?.flat(), other)) {
        const rows = grouped.get(row.event_name);
        if (!rows) throw new Error('Unexpected native event kind');
        rows.push(row);
      }
      byKind = grouped;
    } catch {
      // Older recording/field combinations may fail for just one kind.
    }
    for (const kind of kinds) {
      try {
        const rows = byKind?.get(kind) ?? readSingle(source, kind, group, single);
        if (kind === 'player_death' || kind === 'player_hurt') eventAvailability[kind] = true;
        for (const row of rows) events.push({ ...row, type: kind, tick: row.tick });
      } catch {
        warnings.push(`Event ${kind} is unavailable.`);
      }
    }
  }
  // Group order preserves the existing tie break on simultaneous events.
  events.sort((a, b) => a.tick - b.tick);
  return { events, warnings, eventAvailability };
}
