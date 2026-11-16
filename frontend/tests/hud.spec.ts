import { test, expect } from '@playwright/test';

// Explicit test-only replay exercises recorded/unknown fields. It is never a
// production sample or personal match-history entry.
const names = ['marlow', 'echo', 'sable', 'north', 'rook', 'vex', 'atlas', 'ghost', 'finn', 'koda'];
const players = names.map((name, index) => ({
  id: 'fixture-player-' + index,
  name,
  team: index < 5 ? 3 : 2,
}));
const frames = [0, 1280].map((tick) => ({
  tick,
  players: players.map((player, index) => ({
    id: player.id,
    x: index * 60,
    y: index < 5 ? 100 : -100,
    z: 0,
    yaw: 0,
    pitch: 0,
    health: 100,
    alive: true,
    team: player.team,
    weapon: 'AK47',
    ...(index !== 1
      ? {
          money: index === 0 ? 0 : 1200,
          armor: 0,
          equipmentValue: index === 0 ? 0 : 3000,
          helmet: false,
          defuser: false,
          scoped: false,
          defusing: false,
          startMoney: 800,
          spentThisRound: 800,
          inventory: ['SmokeGrenade', 'Flashbang', 'Flashbang', 'AK47'],
        }
      : {}),
    ...(index === 0
      ? {
          input: {
            source: 'network',
            buttons: '65545',
            forward: true,
            back: false,
            left: false,
            right: false,
            jump: false,
            duck: false,
            walk: true,
            attack: true,
            attack2: false,
            reload: false,
            use: false,
          },
        }
      : index === 2
        ? { input: { source: 'usercmd', mouseDx: 12, mouseDy: -4 } }
        : {}),
  })),
}));
const replay = {
  version: 1,
  map: 'de_fixture',
  sample: false,
  tickRate: 64,
  players,
  frames,
  rounds: [{ number: 1, tick: 0, liveTick: 128 }],
  events: [],
  capabilities: {
    economy: true,
    equipment: true,
    inventory: true,
    inputButtons: 'network',
    mouseInput: true,
    utilityThrows: false,
  },
};

test('recorded analysis HUD distinguishes unknown inputs and preserves economy zeros', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.addInitScript(() =>
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({ inputs: true, economy: true, inputLayout: 'zqsd', quality: 'low' }),
    ),
  );
  await page.route('**/api/demos/hud-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'hud-fixture',
        name: 'Explicit HUD test fixture',
        source: 'upload',
        status: 'ready',
        size: 1024,
        created_at: 1700000000,
        public: true,
        owned: false,
        map: 'de_fixture',
        duration: 20,
        rounds: 1,
        error: null,
      },
    }),
  );
  await page.route('**/api/demos/hud-fixture/playback', (route) => route.fulfill({ json: replay }));
  await page.goto('/watch/hud-fixture');
  const hud = page.getByRole('complementary', { name: 'Analysis HUD' });
  await expect(hud).toBeVisible();
  await expect(hud.getByText('Network button states', { exact: true })).toBeVisible();
  await expect(hud.locator('.input-forward')).toHaveAttribute('data-state', 'pressed');
  await expect(hud.locator('.input-forward kbd')).toHaveText('Z');
  await expect(hud.locator('.input-left')).toHaveAttribute('data-state', 'released');
  await expect(
    hud.getByText('Mouse movement is unavailable for this player at this moment.'),
  ).toBeVisible();
  await hud.getByRole('tab', { name: 'Economy', exact: true }).click();
  await expect(
    hud
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: /marlow/ }) })
      .getByRole('cell'),
  ).toHaveText(['$0', '$0']);
  await hud.getByText('Selected loadout', { exact: false }).click();
  await expect(hud.locator('.economy-inventory li').filter({ hasText: 'Flashbang' })).toHaveText(
    'Flashbang×2',
  );
  await hud.getByRole('button', { name: /echo/ }).click();
  await hud.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await expect(
    hud.getByText('Input actions were not recorded for this player at this moment.'),
  ).toBeVisible();
  await expect(hud.locator('.input-action-key')).toHaveCount(0);
  await hud.getByRole('tab', { name: 'Economy', exact: true }).click();
  await hud.getByRole('button', { name: /sable/ }).click();
  await hud.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await expect(hud.locator('.input-forward')).toHaveAttribute('data-state', 'unknown');
  await expect(hud.getByLabel('Recorded mouse movement')).toContainText('12');
  await expect(hud.getByLabel('Recorded mouse movement')).toContainText('-4');
  for (const [width, height] of [
    [320, 740],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await hud.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return (
          r.left >= 0 &&
          r.top >= 0 &&
          r.right <= innerWidth &&
          r.bottom <= innerHeight &&
          r.height > 70
        );
      }),
    ).toBe(true);
    await hud.getByRole('button', { name: 'Collapse analysis HUD' }).click();
    await expect(hud.locator('.analysis-hud-content')).toHaveCount(0);
    await hud.getByRole('button', { name: 'Expand analysis HUD' }).click();
  }
  await hud.getByRole('button', { name: 'Close analysis HUD' }).click();
  await expect(hud).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem('viewer-settings') || '{}');
      return value.inputs === false && value.economy === false && value.inputLayout === 'zqsd';
    }),
  ).toBe(true);
});
