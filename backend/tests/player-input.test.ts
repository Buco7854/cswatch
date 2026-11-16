import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedInput, uint64, replayCapabilities } from '../src/player-input.js';
import { collectFrameState } from '../src/frame-state.js';
import { readPlayerRows } from '../src/parser-fields.js';
import { chunkSchema } from '../src/replay.js';

const id = '76561198000000001';
const row = (extra: Record<string, unknown> = {}) => ({
  tick: 4,
  steamid: id,
  name: 'Test',
  X: 1,
  Y: 2,
  Z: 3,
  health: 100,
  team_num: 2,
  is_alive: true,
  ...extra,
});

test('recorded uint64 button masks retain high bits without unsafe Number conversion', () => {
  const bits = (1n << 63n) | 8n | 16n | 512n | 1024n | 2n | 4n | 65536n | 1n | 2048n | 8192n | 32n;
  const input = recordedInput({ buttons: bits.toString() })!;
  assert.equal(input.source, 'network');
  assert.equal(input.buttons, bits.toString());
  for (const key of [
    'forward',
    'back',
    'left',
    'right',
    'jump',
    'duck',
    'walk',
    'attack',
    'attack2',
    'reload',
    'use',
  ] as const)
    assert.equal(input[key], true, key);
  assert.equal(uint64('18446744073709551615'), 18446744073709551615n);
  assert.equal(uint64('18446744073709551616'), undefined);
  assert.equal(uint64(Number(bits)), undefined);
  assert.equal(uint64(-1), undefined);
  assert.equal(uint64('1.5'), undefined);
  assert.equal(recordedInput({ buttons: Number(bits) }), undefined);
});

test('real usercmd held/transition masks take precedence and preserve mouse counts', () => {
  const input = recordedInput({
    buttons: '16',
    usercmd_buttonstate_1: '8',
    usercmd_buttonstate_2: '24',
    usercmd_buttonstate_3: '2',
    usercmd_mouse_dx: -37,
    usercmd_mouse_dy: 0,
  })!;
  assert.equal(input.source, 'usercmd');
  assert.equal(input.buttons, '8');
  assert.equal(input.forward, true);
  assert.equal(input.back, false);
  assert.equal(input.pressedButtons, '10');
  assert.equal(input.releasedButtons, '18');
  assert.equal(input.mouseDx, -37);
  assert.equal(input.mouseDy, 0);
  assert.equal(
    recordedInput({ usercmd_buttons_held: 65536n, usercmd_buttonstate_1: '8' })?.walk,
    true,
  );
});

test('missing or unsupported delta inputs remain unavailable rather than inferred from movement or aim', () => {
  const unavailable = row({
    usercmd_buttonstate_1: null,
    usercmd_buttonstate_2: null,
    usercmd_buttonstate_3: null,
    usercmd_mouse_dx: null,
    usercmd_mouse_dy: undefined,
    buttons: null,
    FORWARD: false,
    velocity_X: 250,
    yaw: 123,
    balance: 700,
  });
  assert.equal(recordedInput(unavailable), undefined);
  const { frames } = collectFrameState([unavailable]);
  assert.equal(frames[0].players[0].input, undefined);
  assert.equal(frames[0].players[0].money, 700);
  assert.deepEqual(replayCapabilities(frames, []), {
    economy: true,
    equipment: false,
    inventory: false,
    inputButtons: 'unavailable',
    mouseInput: false,
    utilityThrows: false,
  });
  assert.equal(recordedInput({ buttons: '0' })?.forward, false); // Recorded idle state is distinct from missing data.
  assert.deepEqual(recordedInput({ usercmd_mouse_dx: 7, usercmd_mouse_dy: -2 }), {
    source: 'usercmd',
    mouseDx: 7,
    mouseDy: -2,
  });
});

test('optional parser failures preserve unrelated equipment/economy and actual zero values', () => {
  const values = row({
    balance: 0,
    armor_value: 70,
    inventory: ['Flashbang', 'Flashbang'],
    usercmd_mouse_dx: 9,
  });
  const rows = readPlayerRows(
    (fields) => {
      if (fields.includes('unknown_new_delta_property')) throw new Error('Unsupported property');
      return [
        Object.fromEntries(
          ['tick', 'steamid', 'name', ...fields].map((field) => [
            field,
            values[field as keyof typeof values],
          ]),
        ),
      ];
    },
    ['X', 'Y', 'Z', 'health', 'team_num', 'is_alive'],
    [
      ['balance', 'armor_value', 'inventory'],
      ['unknown_new_delta_property', 'usercmd_mouse_dx'],
    ],
  );
  const player = collectFrameState(rows).frames[0].players[0];
  assert.equal(player.money, 0);
  assert.equal(player.armor, 70);
  assert.deepEqual(player.inventory, ['Flashbang', 'Flashbang']);
  assert.equal(player.input?.mouseDx, 9);
  assert.equal(player.input?.buttons, undefined);
});

test('status and inventory are recorded independently; null never fabricates money, armor or key releases', () => {
  const { frames } = collectFrameState([
    row({
      balance: null,
      armor_value: null,
      has_helmet: false,
      has_defuser: true,
      is_scoped: true,
      is_defusing: false,
      current_equip_value: 3300,
      start_balance: 4000,
      cash_spent_this_round: 2700,
      inventory: ['AK-47', 'Smoke Grenade'],
      FORWARD: true,
    }),
    row({ tick: 8, FORWARD: false }),
    row({ tick: 12, FORWARD: null }),
  ]);
  const player = frames[0].players[0];
  assert.equal(player.money, undefined);
  assert.equal(player.armor, undefined);
  assert.equal(player.helmet, false);
  assert.equal(player.defuser, true);
  assert.equal(player.scoped, true);
  assert.equal(player.defusing, false);
  assert.equal(player.equipmentValue, 3300);
  assert.equal(player.startMoney, 4000);
  assert.equal(player.spentThisRound, 2700);
  assert.equal(player.input?.forward, true);
  assert.equal(frames[1].players[0].input?.forward, false);
  assert.equal(frames[2].players[0].input, undefined);
});

test('capabilities describe actual available source fields and recorded grenade release events', () => {
  const { frames } = collectFrameState([
    row({ balance: 2000, inventory: [], armor_value: 100, buttons: '8' }),
    row({ tick: 8, usercmd_buttons_held: '2048', usercmd_mouse_dx: -3 }),
  ]);
  const capabilities = replayCapabilities(frames, [
    {
      type: 'weapon_fire',
      tick: 4,
      weapon: 'weapon_smokegrenade',
      user_steamid: id,
      user_X: 1,
      user_Y: 2,
      user_Z: 3,
    },
  ]);
  assert.deepEqual(capabilities, {
    economy: true,
    equipment: true,
    inventory: true,
    inputButtons: 'usercmd',
    mouseInput: true,
    utilityThrows: true,
  });
  assert.equal(
    replayCapabilities(frames, [{ type: 'weapon_fire', tick: 4, weapon: 'weapon_ak47' }])
      .utilityThrows,
    false,
  );
  assert.equal(
    replayCapabilities(frames, [{ type: 'grenade_thrown', tick: 4 }]).utilityThrows,
    true,
  );
  const payload = { version: 2, index: 0, frames, grenades: [] };
  assert.equal(chunkSchema.safeParse(payload).success, true);
  const malicious = structuredClone(payload);
  malicious.frames[0].players[0].input!.buttons = '18446744073709551616';
  assert.equal(chunkSchema.safeParse(malicious).success, false);
  malicious.frames[0].players[0].input!.buttons = '8';
  malicious.frames[0].players[0].input!.mouseDx = Infinity;
  assert.equal(chunkSchema.safeParse(malicious).success, false);
});
