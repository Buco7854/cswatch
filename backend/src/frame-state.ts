import type { DeadTime, Frame, Player, Position } from '../../shared/playback.js';
import { hasNetworkAliasEvidence, recordedInput } from './player-input.js';
import {
  playerColumns,
  recordedCameraFov,
  recordedReloadTickLimit,
  type PlayerColumns,
} from './parser-fields.js';

const finite = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const rounded = (value: unknown) => Math.round(finite(value) * 100) / 100;

/** Native row order is not a contract. Group ticks before deriving timeout boundaries. */
type FrameState = {
  frames: Frame[];
  players: Player[];
  deadTimes: DeadTime[];
};
type ReloadObservation = {
  tick: number;
  handle: number;
  active: boolean;
  start?: number;
};
export function collectFrameState(rows: Record<string, unknown>[]): FrameState {
  const sorted = rows
    .filter(
      (row) =>
        Number.isSafeInteger(row.tick) &&
        Number(row.tick) >= 0 &&
        Number(row.tick) <= 64 * 60 * 180,
    )
    .sort((a, b) => Number(a.tick) - Number(b.tick));
  return collectOrderedFrameState(sorted, hasNetworkAliasEvidence(sorted));
}

/** Sort small row indices, retaining native columns rather than a second full
 * raw object graph. The reusable row is consumed synchronously by projection. */
export function collectColumnFrameState(value: PlayerColumns): FrameState {
  const columns = playerColumns(value);
  const indices = new Uint32Array(columns.tick.length);
  let count = 0;
  for (let index = 0; index < columns.tick.length; index++) {
    const tick = columns.tick[index];
    if (
      typeof tick === 'number' &&
      Number.isSafeInteger(tick) &&
      tick >= 0 &&
      tick <= 64 * 60 * 180
    )
      indices[count++] = index;
  }
  const order = indices
    .subarray(0, count)
    .sort((a, b) => Number(columns.tick[a]) - Number(columns.tick[b]));
  const fields = Object.entries(columns);
  function* rows() {
    const row: Record<string, unknown> = Object.create(null);
    for (const index of order) {
      for (const [field, values] of fields) row[field] = values[index];
      yield row;
    }
  }
  return collectOrderedFrameState(rows(), hasNetworkAliasEvidence(rows()));
}

function collectOrderedFrameState(
  rows: Iterable<Record<string, unknown>>,
  aliasesAvailable: boolean,
): FrameState {
  const roster = new Map<string, Player>(),
    frames: Frame[] = [],
    deadTimes: DeadTime[] = [];
  const reloads = new Map<string, ReloadObservation>();
  let frame: Frame | undefined, segment: DeadTime | undefined;
  for (const row of rows) {
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
    const previousReload = reloads.get(id);
    const handle = row.active_weapon;
    const active = row.is_in_reload;
    if (
      player.alive &&
      id !== '0' &&
      player.weapon &&
      typeof handle === 'number' &&
      Number.isSafeInteger(handle) &&
      handle > 0 &&
      handle < 0xffffffff &&
      typeof active === 'boolean'
    ) {
      let start: number | undefined;
      if (active && previousReload?.handle === handle && tick === previousReload.tick + 4)
        start = previousReload.active ? previousReload.start : tick;
      reloads.set(id, { tick, handle, active, start });
      if (start !== undefined && tick - start < recordedReloadTickLimit)
        player.reloadStarted = start;
    } else reloads.delete(id);
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
    const scope = row[recordedCameraFov];
    if (
      player.alive &&
      player.scoped &&
      typeof scope === 'number' &&
      Number.isSafeInteger(scope) &&
      scope >= 5 &&
      scope < 90
    )
      player.scopeFov = scope;
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
    const stats: NonNullable<Position['stats']> = {};
    for (const [field, property] of [
      ['kills_total', 'kills'],
      ['deaths_total', 'deaths'],
      ['assists_total', 'assists'],
      ['headshot_kills_total', 'headshotKills'],
      ['damage_total', 'damage'],
    ] as const) {
      const value = row[field];
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 1000000000
      )
        stats[property] = value;
    }
    if (Object.keys(stats).length) player.stats = stats;
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
