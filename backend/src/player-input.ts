import type { RecordedInput, Frame, ReplayCapabilities, GameEvent } from '../../shared/playback.js';

/** Source 2 InputBitMask_t; masks are actions, not physical key bindings.
 * https://github.com/SteamDatabase/GameTracking-CS2/blob/master/DumpSource2/schemas/client/InputBitMask_t.h
 * https://github.com/LaihoE/demoparser/blob/main/src/parser/src/maps.rs (BUTTONMAP)
 */
const masks = {
  forward: 8n,
  back: 16n,
  left: 512n,
  right: 1024n,
  jump: 2n,
  duck: 4n,
  walk: 65536n,
  attack: 1n,
  attack2: 2048n,
  reload: 8192n,
  use: 32n,
} as const;
const aliases = {
  forward: 'FORWARD',
  back: 'BACK',
  left: 'LEFT',
  right: 'RIGHT',
  jump: 'JUMP',
  duck: 'DUCK',
  walk: 'WALK',
  attack: 'FIRE',
  attack2: 'RIGHTCLICK',
  reload: 'RELOAD',
  use: 'USE',
} as const;

export function uint64(value: unknown): bigint | undefined {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return;
  if (
    typeof value !== 'bigint' &&
    typeof value !== 'number' &&
    !(typeof value === 'string' && /^\d{1,20}$/.test(value))
  )
    return;
  const result = BigInt(value);
  return result >= 0n && result <= 18446744073709551615n ? result : undefined;
}
const mouseCount = (value: unknown) =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= -2147483648 &&
  value <= 2147483647
    ? value
    : undefined;

/** Null/default-missing commands never become invented key releases or view-angle mouse deltas. */
export function recordedInput(
  row: Record<string, unknown>,
  allowAliases = false,
): RecordedInput | undefined {
  const command = uint64(row.usercmd_buttons_held) ?? uint64(row.usercmd_buttonstate_1);
  const network = uint64(row.buttons);
  const held = command ?? network;
  const mouseDx = mouseCount(row.usercmd_mouse_dx),
    mouseDy = mouseCount(row.usercmd_mouse_dy);
  const availableAliases =
    allowAliases && Object.values(aliases).some((field) => typeof row[field] === 'boolean');
  if (held === undefined && !availableAliases && mouseDx === undefined && mouseDy === undefined)
    return;
  const input: RecordedInput = {
    source:
      command !== undefined || (network === undefined && !availableAliases) ? 'usercmd' : 'network',
  };
  if (held !== undefined) {
    input.buttons = held.toString();
    for (const [name, mask] of Object.entries(masks))
      input[name as keyof typeof masks] = (held & mask) !== 0n;
  } else if (availableAliases) {
    for (const [name, field] of Object.entries(aliases))
      if (typeof row[field] === 'boolean')
        input[name as keyof typeof aliases] = row[field] as boolean;
  }
  if (command !== undefined) {
    const state2 = uint64(row.usercmd_buttonstate_2),
      state3 = uint64(row.usercmd_buttonstate_3);
    // Upstream's three-bit EInButtonState encoding: held=state1, with transitions in states2/3.
    const pressed =
      uint64(row.usercmd_buttons_pressed) ??
      (state2 !== undefined && state3 !== undefined ? state3 | (command & state2) : undefined);
    const released =
      uint64(row.usercmd_buttons_released) ??
      (state2 !== undefined && state3 !== undefined ? state3 | (~command & state2) : undefined);
    if (pressed !== undefined) input.pressedButtons = pressed.toString();
    if (released !== undefined) input.releasedButtons = released.toString();
  }
  if (mouseDx !== undefined) input.mouseDx = mouseDx;
  if (mouseDy !== undefined) input.mouseDy = mouseDy;
  return input;
}

export function hasNetworkAliasEvidence(rows: Iterable<Record<string, unknown>>) {
  for (const row of rows)
    if (Object.values(aliases).some((field) => row[field] === true)) return true;
  return false;
}
const utilities = new Set([
  'smokegrenade',
  'flashbang',
  'hegrenade',
  'molotov',
  'incgrenade',
  'decoy',
]);
export function isRecordedUtilityThrow(event: GameEvent) {
  return (
    event.type === 'grenade_thrown' ||
    (event.type === 'weapon_fire' &&
      typeof event.weapon === 'string' &&
      utilities.has(event.weapon.replace(/^weapon_/, '')))
  );
}
export function replayCapabilities(frames: Frame[], events: GameEvent[]): ReplayCapabilities {
  const result: ReplayCapabilities = {
    economy: false,
    equipment: false,
    inventory: false,
    inputButtons: 'unavailable',
    mouseInput: false,
    utilityThrows: events.some(isRecordedUtilityThrow),
  };
  for (const frame of frames)
    for (const player of frame.players) {
      if (player.money !== undefined) result.economy = true;
      if (
        player.armor !== undefined ||
        player.helmet !== undefined ||
        player.defuser !== undefined ||
        player.equipmentValue !== undefined
      )
        result.equipment = true;
      if (player.inventory !== undefined) result.inventory = true;
      if (!player.input) continue;
      if (
        player.input.buttons !== undefined ||
        Object.keys(aliases).some(
          (key) => typeof player.input?.[key as keyof typeof aliases] === 'boolean',
        )
      ) {
        if (player.input.source === 'usercmd') result.inputButtons = 'usercmd';
        else if (result.inputButtons === 'unavailable') result.inputButtons = 'network';
      }
      if (player.input.mouseDx !== undefined || player.input.mouseDy !== undefined)
        result.mouseInput = true;
    }
  return result;
}
