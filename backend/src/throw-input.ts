import type { GameEvent, Player } from '../../shared/playback.js';
import type { ThrowInputSnapshot } from '../../shared/throw-input.js';
import { hasNetworkAliasEvidence, isRecordedUtilityThrow, recordedInput } from './player-input.js';

const throwInputLimit = 10000;
export const eventInputFields = [
  'buttons',
  'FORWARD',
  'BACK',
  'LEFT',
  'RIGHT',
  'JUMP',
  'DUCK',
  'WALK',
  'FIRE',
  'RIGHTCLICK',
  'RELOAD',
  'USE',
  'usercmd_buttonstate_1',
  'usercmd_buttonstate_2',
  'usercmd_buttonstate_3',
  'usercmd_buttons_held',
  'usercmd_buttons_pressed',
  'usercmd_buttons_released',
  'usercmd_mouse_dx',
  'usercmd_mouse_dy',
] as const;
const identity = (row: Record<string, unknown>) =>
  JSON.stringify([
    row.tick,
    row.user_steamid,
    row.attacker_steamid,
    row.weapon,
    row.entityid,
    row.entity_id,
  ]);

/** Optional unsupported extras may not erase the original events or other groups.
 * Merge only an unchanged event sequence; never join snapshots by display name. */
export function readEventRows(
  read: (fields: string[]) => Record<string, unknown>[],
  groups: string[][],
) {
  try {
    return read([...new Set(groups.flat())]);
  } catch {
    /* Keep independent groups. */
  }
  const base = read([]);
  const keys = base.map(identity);
  const merge = (rows: Record<string, unknown>[]) => {
    if (rows.length !== base.length || rows.some((row, index) => identity(row) !== keys[index]))
      return;
    for (let index = 0; index < rows.length; index++)
      for (const [key, value] of Object.entries(rows[index]))
        if (value !== undefined && value !== null) base[index][key] = value;
  };
  for (const group of groups) {
    try {
      merge(read(group));
    } catch {
      for (const field of group) {
        try {
          merge(read([field]));
        } catch {
          /* Unknown remains absent. */
        }
      }
    }
  }
  return base;
}

/** Native `buttons` is the previous network button mask. A snapshot read at an
 * event is not a verified release command or a physical mouse/key binding.
 * No sampled 16Hz frame or velocity is consulted to manufacture launch input. */
export function collectThrowInputs(events: GameEvent[], players: Player[]) {
  const snapshots: ThrowInputSnapshot[] = [];
  const actors = new Set(players.map((player) => player.id));
  let complete = true;
  for (const [eventIndex, event] of events.entries()) {
    if (!isRecordedUtilityThrow(event)) continue;
    const actorId = event.user_steamid;
    if (typeof actorId !== 'string' || !/^\d{1,20}$/.test(actorId) || !actors.has(actorId))
      continue;
    if (snapshots.length >= throwInputLimit) {
      complete = false;
      break;
    }
    const row: Record<string, unknown> = {};
    for (const field of eventInputFields) row[field] = event['user_' + field];
    if (row.WALK === undefined) row.WALK = event.user_IN_WALK;
    const input = recordedInput(row, hasNetworkAliasEvidence([row]));
    snapshots.push(
      input
        ? {
            eventIndex,
            tick: event.tick,
            actorId,
            sampleTick: event.tick,
            provenance: input.source === 'usercmd' ? 'event-usercmd' : 'event-network',
            input,
          }
        : { eventIndex, tick: event.tick, actorId, provenance: 'unavailable' },
    );
  }
  return { snapshots, complete };
}

/** Input metadata belongs in its bounded global index, not every bullet event. */
export function removeEventInputExtras(events: GameEvent[]) {
  for (const event of events) {
    for (const field of eventInputFields) delete event['user_' + field];
    delete event.user_IN_WALK;
  }
}
