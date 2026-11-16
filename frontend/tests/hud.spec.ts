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
    weapon: index === 3 ? 'weapon_awp' : 'AK47',
    ammo: index === 0 ? 0 : 30,
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
          ...(tick === 1280 && index === 0
            ? {
                money: 5400,
                armor: 80,
                health: 37,
                weapon: 'weapon_awp',
                ammo: 7,
                equipmentValue: 4750,
                inventory: ['weapon_awp', 'Flashbang'],
              }
            : {}),
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

test('broadcast HUD shows recorded loadouts and inputs without inventing missing data', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({
        inputs: true,
        mouseInput: true,
        economy: true,
        inputLayout: 'zqsd',
        quality: 'low',
      }),
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
  const ct = hud.locator('.broadcast-bank[data-team="3"]');
  const terrorists = hud.locator('.broadcast-bank[data-team="2"]');
  const row = (index: number) =>
    hud.locator('.broadcast-bank .broadcast-player[data-player-id="fixture-player-' + index + '"]');
  await expect(hud).toBeVisible();
  await expect(ct).toBeVisible();
  await expect(terrorists).toBeVisible();
  await expect(ct.locator('.broadcast-player')).toHaveCount(5);
  await expect(terrorists.locator('.broadcast-player')).toHaveCount(5);
  await expect(row(0).locator('.broadcast-cash')).toHaveText('$0');
  await expect(
    hud.locator('.observed-player,.broadcast-compact-card,.broadcast-bank-heading'),
  ).toHaveCount(0);
  const ctBounds = (await ct.boundingBox())!;
  const tBounds = (await terrorists.boundingBox())!;
  expect(ctBounds.x).toBeGreaterThan(720);
  expect(tBounds.x).toBeCloseTo(ctBounds.x, 0);
  expect(tBounds.y).toBeGreaterThanOrEqual(ctBounds.y + ctBounds.height);
  await expect(row(0).locator('.broadcast-ammo')).toContainText('0');
  await expect(row(0).locator('.broadcast-armor')).toContainText('0');
  await expect(row(0).getByRole('img', { name: 'Flashbang ×2', exact: true })).toBeVisible();
  await expect(row(1).locator('.broadcast-cash')).toHaveText('—');
  await expect(
    row(1).getByLabel('Inventory is unavailable at this moment.', { exact: true }),
  ).toBeVisible();
  await expect(row(3).locator('.broadcast-weapon-identity')).toContainText('AWP');
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  const details = page.locator('.viewer-drawer .broadcast-loadout');
  const loadout = details.locator('.broadcast-loadout-values');
  await details.locator('summary').click();
  await expect
    .poll(() =>
      details.evaluate((element) => {
        const body = element.querySelector('.broadcast-loadout-body')!.getBoundingClientRect();
        const viewport = element.closest('.viewer-drawer-content')!.getBoundingClientRect();
        return body.top >= viewport.top && body.bottom <= viewport.bottom + 1;
      }),
    )
    .toBe(true);
  await expect(
    loadout
      .locator('div')
      .filter({ has: page.getByText('Equipment', { exact: true }) })
      .locator('dd'),
  ).toHaveText('$0');
  await expect(
    details.locator('.broadcast-inventory li').filter({ hasText: 'Flashbang' }),
  ).toHaveText('Flashbang×2');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  const timeline = page.getByRole('slider', { name: 'Playback position', exact: true });
  await timeline.fill('1280');
  await expect(row(0).locator('.broadcast-cash')).toHaveText('$5,400');
  await expect(row(0).locator('.broadcast-health-value')).toHaveText('37 HP');
  await expect(row(0).locator('.broadcast-weapon-identity')).toContainText('AWP');
  await expect(row(0).locator('.broadcast-ammo')).toContainText('7');
  await expect(row(0).getByRole('img', { name: 'Flashbang ×1', exact: true })).toBeVisible();
  await expect(row(0).getByRole('img', { name: 'Flashbang ×2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await details.locator('summary').click();
  await expect(
    loadout
      .locator('div')
      .filter({ has: page.getByText('Equipment', { exact: true }) })
      .locator('dd'),
  ).toHaveText('$4,750');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await timeline.fill('0');
  await expect(row(0).locator('.broadcast-cash')).toHaveText('$0');
  await expect(row(0).locator('.broadcast-weapon-identity')).toContainText('AK-47');
  await expect(row(0).getByRole('img', { name: 'Flashbang ×2', exact: true })).toBeVisible();
  await expect(hud.locator('.input-forward')).toHaveAttribute('data-state', 'pressed');
  await expect(hud.locator('.input-forward kbd')).toHaveText('Z');
  await expect(hud.locator('.input-left')).toHaveAttribute('data-state', 'released');
  await hud.getByRole('button', { name: 'Input display options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Input details', exact: true }).click();
  await expect(hud.getByText('Network button states', { exact: true })).toBeVisible();
  await expect(
    hud.getByText('Mouse movement is unavailable for this player at this moment.'),
  ).toBeVisible();
  await row(1).getByRole('button', { name: 'Select player echo', exact: true }).click();
  await expect(row(1).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await expect(
    hud.getByText('Input actions were not recorded for this player at this moment.'),
  ).toBeVisible();
  await expect(hud.locator('.input-action-key')).toHaveCount(0);
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await details.locator('summary').click();
  await expect(
    loadout
      .locator('div')
      .filter({ has: page.getByText('Money', { exact: true }) })
      .locator('dd'),
  ).toHaveText('—');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await row(2).getByRole('button', { name: 'Select player sable', exact: true }).click();
  await expect(hud.locator('.input-forward')).toHaveAttribute('data-state', 'unknown');

  await expect(hud.getByLabel('Recorded mouse movement', { exact: true })).toContainText('12');
  await expect(hud.getByLabel('Recorded mouse movement', { exact: true })).toContainText('-4');
  await expect(hud.locator('.input-mouse-primary')).toHaveAttribute('data-state', 'unknown');
  await expect(hud.locator('.review-hud-tools')).toHaveCount(0);
  for (const [width, height] of [
    [320, 740],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    const closeLineups = hud.getByRole('button', { name: 'Close team lineups', exact: true });
    if (await closeLineups.isVisible()) await closeLineups.click();
    await expect(hud.locator('.broadcast-lineups-open')).toBeVisible();
    await hud.getByRole('button', { name: 'Expand team lineups', exact: true }).click();
    await expect(ct).toBeVisible();
    await expect(terrorists).toBeVisible();
    await row(5).getByRole('button', { name: 'Select player vex', exact: true }).click();
    await expect(row(5).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await hud.getByRole('button', { name: 'Close team lineups', exact: true }).click();
    await expect(hud.locator('.review-inputs-panel')).toBeVisible();
    await expect(
      hud.getByText('Input actions were not recorded for this player at this moment.'),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const input = await hud.locator('.review-inputs-panel').boundingBox();
    const dock = await page.locator('.viewer-dock').boundingBox();
    expect(input!.y + input!.height).toBeLessThanOrEqual(dock!.y);
    expect(input!.x + input!.width).toBeLessThan(width / 2);
    await hud.getByRole('button', { name: 'Collapse input display', exact: true }).click();
    await expect(hud.locator('.review-inputs-body')).toHaveCount(0);
    await hud.getByRole('button', { name: 'Expand input display', exact: true }).click();
  }
  await hud.getByRole('button', { name: 'Input display options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide inputs', exact: true }).click();
  await expect(hud.locator('.review-inputs-panel')).toHaveCount(0);
  await expect(hud.locator('.broadcast-lineups-open')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem('viewer-settings') || '{}');
      return value.inputs === false && value.economy === true && value.inputLayout === 'zqsd';
    }),
  ).toBe(true);
  await expect(hud.locator('.observed-player,.broadcast-compact-card')).toHaveCount(0);
});
