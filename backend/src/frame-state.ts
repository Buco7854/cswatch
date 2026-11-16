import type { DeadTime, Frame, Player, Position } from '../../shared/playback.js';
import { hasNetworkAliasEvidence, recordedInput } from './player-input.js';

const finite = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const rounded = (value: unknown) => Math.round(finite(value) * 100) / 100;

/** Native row order is not a contract. Group ticks before deriving timeout boundaries. */
export function collectFrameState(rows: Record<string, unknown>[]): {
  frames: Frame[];
  players: Player[];
  deadTimes: DeadTime[];
} {
  const sorted = rows
    .filter(
      (row) =>
        Number.isSafeInteger(row.tick) &&
        Number(row.tick) >= 0 &&
        Number(row.tick) <= 64 * 60 * 180,
    )
    .sort((a, b) => Number(a.tick) - Number(b.tick));
  const roster = new Map<string, Player>(),
    frames: Frame[] = [],
    deadTimes: DeadTime[] = [];
  let frame: Frame | undefined, segment: DeadTime | undefined;
  const aliasesAvailable = hasNetworkAliasEvidence(sorted);
  for (const row of sorted) {
    if (
      ![row.X, row.Y, row.Z].every((value) => typeof value === 'number' && Number.isFinite(value))
    )
      continue;
    if (
      row.steamid === undefined ||
      row.steamid === null ||
      (typeof row.steamid === 'number' && !Number.isSafeInteger(row.steamid))
    )
      continue;
    const id = String(row.steamid);
    if (!/^\d{1,20}$/.test(id)) continue;
    const tick = Number(row.tick);
    if (!frame || tick !== frame.tick) {
      frame = { tick, players: [] };
      frames.push(frame);
      const kind = row.is_technical_timeout
        ? 'technical'
        : row.is_ct_timeout || row.is_terrorist_timeout
          ? 'timeout'
          : row.is_freeze_period
            ? 'freeze'
            : null;
      if (segment && kind !== segment.kind) {
        segment.end = tick;
        deadTimes.push(segment);
        segment = undefined;
      }
      if (kind && !segment) segment = { start: tick, end: tick, kind };
    }
    roster.set(id, {
      id,
      name: String(row.name || 'Player').slice(0, 80),
      team: finite(row.team_num),
    });
    const player: Position = {
      id,
      x: rounded(row.X),
      y: rounded(row.Y),
      z: rounded(row.Z),
      yaw: rounded(row.yaw),
      pitch: rounded(row.pitch),
      health: finite(row.health),
      team: finite(row.team_num),
      alive: Boolean(row.is_alive),
      weapon: String(row.active_weapon_name || '').slice(0, 50),
    };
    if (typeof row.armor_value === 'number' && Number.isFinite(row.armor_value))
      player.armor = row.armor_value;
    if (typeof row.balance === 'number' && Number.isFinite(row.balance)) player.money = row.balance;
    if (typeof row.active_weapon_ammo === 'number' && Number.isFinite(row.active_weapon_ammo))
      player.ammo = row.active_weapon_ammo;
    if (typeof row.duck_amount === 'number' && Number.isFinite(row.duck_amount))
      player.duck = rounded(row.duck_amount);
    if (typeof row.flash_duration === 'number' && Number.isFinite(row.flash_duration))
      player.flash = rounded(row.flash_duration);
    for (const [field, property] of [
      ['has_helmet', 'helmet'],
      ['has_defuser', 'defuser'],
      ['is_scoped', 'scoped'],
      ['is_defusing', 'defusing'],
    ] as const)
      if (typeof row[field] === 'boolean') player[property] = row[field];
    for (const [field, property] of [
      ['current_equip_value', 'equipmentValue'],
      ['start_balance', 'startMoney'],
      ['cash_spent_this_round', 'spentThisRound'],
    ] as const)
      if (
        typeof row[field] === 'number' &&
        Number.isSafeInteger(row[field]) &&
        row[field] >= 0 &&
        row[field] <= 1000000000
      )
        player[property] = row[field];
    if (
      Array.isArray(row.inventory) &&
      row.inventory.length <= 64 &&
      row.inventory.every((item) => typeof item === 'string' && item.length <= 80)
    )
      player.inventory = row.inventory;
    const input = recordedInput(row, aliasesAvailable);
    if (input) player.input = input;
    frame.players.push(player);
  }
  if (segment) {
    segment.end = frames.at(-1)!.tick;
    deadTimes.push(segment);
  }
  if (!frames.length || roster.size > 64 || frames.length > 180000)
    throw new Error('Invalid frame state');
  return { frames, players: [...roster.values()], deadTimes };
}
