import { test, expect } from '@playwright/test';

// Explicit protocol/UI fixture, separate from personal history and the practice scene.
const planter = '76561198000000001',
  defuser = '76561198000000002';
const replay = {
  version: 1,
  map: 'de_objective_fixture',
  sample: false,
  tickRate: 64,
  players: [
    { id: planter, name: 'planter', team: 2 },
    { id: defuser, name: 'defuser', team: 3 },
  ],
  frames: [0, 6400].map((tick) => ({
    tick,
    players: [
      {
        id: planter,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        health: 100,
        alive: true,
        team: 2,
        weapon: 'ak47',
      },
      {
        id: defuser,
        x: 100,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        health: 100,
        alive: true,
        team: 3,
        weapon: 'm4a1',
      },
    ],
  })),
  rounds: [{ number: 1, tick: 0 }],
  events: [
    { type: 'bomb_beginplant', tick: 640, user_steamid: planter, user_name: 'planter' },
    { type: 'bomb_abortplant', tick: 768, user_steamid: planter, user_name: 'planter' },
    { type: 'bomb_beginplant', tick: 960, user_steamid: planter, user_name: 'planter' },
    { type: 'bomb_planted', tick: 1152, user_steamid: planter, user_name: 'planter' },
    {
      type: 'bomb_begindefuse',
      tick: 1792,
      user_steamid: defuser,
      user_name: 'defuser',
      haskit: false,
    },
    { type: 'bomb_abortdefuse', tick: 1856, user_steamid: defuser, user_name: 'defuser' },
    {
      type: 'bomb_begindefuse',
      tick: 1920,
      user_steamid: defuser,
      user_name: 'defuser',
      haskit: false,
    },
    { type: 'bomb_defused', tick: 2368, user_steamid: defuser, user_name: 'defuser' },
  ],
  objectives: {
    complete: true,
    samples: [
      {
        kind: 'plant',
        entity: 'plant1',
        tick: 960,
        present: true,
        arming: true,
        actor: planter,
        endTick: 1152,
      },
      { kind: 'plant', entity: 'plant1', tick: 1152, present: true, arming: false, actor: planter },
      {
        kind: 'bomb',
        entity: 'bomb1',
        tick: 1152,
        present: true,
        ticking: true,
        endTick: 5952,
        duration: 75,
        site: 1,
      },
      {
        kind: 'bomb',
        entity: 'bomb1',
        tick: 1792,
        present: true,
        ticking: true,
        beingDefused: true,
        actor: defuser,
        endTick: 5952,
        duration: 75,
        defuseEndTick: 2240,
        defuseDuration: 7,
        site: 1,
      },
      {
        kind: 'bomb',
        entity: 'bomb1',
        tick: 1856,
        present: true,
        ticking: true,
        beingDefused: false,
        endTick: 5952,
        duration: 75,
        site: 1,
      },
      {
        kind: 'bomb',
        entity: 'bomb1',
        tick: 1920,
        present: true,
        ticking: true,
        beingDefused: true,
        actor: defuser,
        endTick: 5952,
        duration: 75,
        defuseEndTick: 2368,
        defuseDuration: 7,
        site: 1,
      },
      {
        kind: 'bomb',
        entity: 'bomb1',
        tick: 2368,
        present: true,
        ticking: false,
        beingDefused: false,
        defused: true,
        actor: defuser,
        site: 1,
      },
    ],
  },
};

test('broadcast objective HUD follows recorded custom timers, interruptions and backwards seeks', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.route('**/api/demos/objective-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'objective-fixture',
        name: 'Explicit objective UI fixture',
        source: 'upload',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
        duration: 100,
        rounds: 1,
        size: 1024,
        created_at: 1700000000,
      },
    }),
  );
  await page.route('**/api/demos/objective-fixture/playback', (route) =>
    route.fulfill({ json: replay }),
  );
  await page.goto('/watch/objective-fixture');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  const hud = page.getByRole('complementary', { name: 'Bomb objective' });
  await expect(hud).toHaveCount(0);
  await slider.fill('1024');
  await expect(hud).toHaveAttribute('data-phase', 'planting');
  await expect(hud).toContainText('planter');
  await expect(hud.locator('.objective-seconds')).toHaveText('2.0 s');
  await slider.fill('1280');
  await expect(hud).toHaveAttribute('data-phase', 'planted');
  await expect(hud).toContainText('Bombsite B');
  await expect(hud.locator('.objective-seconds')).toHaveText('73.0 s');
  await slider.fill('1984');
  await expect(hud).toHaveAttribute('data-phase', 'defusing');
  await expect(hud).toContainText('defuser');
  await expect(hud).toContainText('No defuse kit');
  await expect(hud.locator('.objective-seconds').first()).toHaveText('6.0 s');
  await slider.fill('1856');
  await expect(hud).toHaveAttribute('data-phase', 'defuse-aborted');
  await slider.fill('2368');
  await expect(hud).toHaveAttribute('data-phase', 'defused');
  await slider.fill('768');
  await expect(hud).toHaveAttribute('data-phase', 'plant-aborted');
  await slider.fill('0');
  await expect(hud).toHaveCount(0);
  await slider.fill('1984');
  for (const language of ['en', 'fr']) {
    if (language === 'fr') {
      await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Français', exact: true }).click();
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const [width, height] of [
        [768, 1024],
        [844, 390],
      ]) {
        await page.setViewportSize({ width, height });
        expect(
          await page.locator('.objective-hud').evaluate((element) => {
            const objective = element.getBoundingClientRect();
            return ['.viewer-context', '.viewer-camera-tools'].every((selector) => {
              const other = document.querySelector(selector)!.getBoundingClientRect();
              return (
                other.right <= objective.left ||
                other.left >= objective.right ||
                other.bottom <= objective.top ||
                other.top >= objective.bottom
              );
            });
          }),
        ).toBe(true);
      }
    }
  }
});
