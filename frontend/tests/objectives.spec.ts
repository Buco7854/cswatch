import { test, expect } from '@playwright/test';
import { selectOptionsCategory } from './fixtures/viewer-options';

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
  const hud = page.getByRole('group', { name: 'Bomb objective', exact: true });
  const context = page.locator('.objective-context');
  const announcer = page.locator('.viewer-frame > [role="status"]');
  await expect(announcer).toHaveText('');
  const liveRegion = await announcer.elementHandle();
  await expect(hud).toHaveCount(0);
  await slider.fill('640');
  await expect(hud).toHaveAttribute('data-phase', 'planting');
  await expect(hud.locator('.objective-progress')).toHaveClass(/is-unknown/);
  await expect(hud.locator('.objective-progress-value')).toHaveCount(0);
  await expect(hud.locator('.objective-seconds')).toHaveText('Elapsed 0.0 s');
  await expect(announcer).toContainText('Planting');
  expect(await announcer.evaluate((element, original) => element === original, liveRegion)).toBe(
    true,
  );
  await slider.fill('1024');
  await expect(hud).toHaveAttribute('data-phase', 'planting');
  await expect(context).toBeVisible();
  await expect(context).toContainText('planter');
  await expect(hud.locator('.objective-seconds')).toHaveText('2.0 s');
  expect(
    Number(await hud.locator('.objective-progress-value').getAttribute('stroke-dashoffset')),
  ).toBeCloseTo(2 / 3, 5);
  await expect(page.locator('.viewer-match-score .objective-hud-score')).toBeVisible();
  await expect(page.locator('.viewer-objective-layer .objective-hud')).toHaveCount(0);
  await slider.fill('1280');
  await expect(hud).toHaveAttribute('data-phase', 'planted');
  await expect(context).toContainText('Bombsite B');
  await expect(hud.locator('.objective-seconds')).toHaveText('73.0 s');
  await slider.fill('1920');
  const score = page.getByRole('button', { name: 'Open scoreboard', exact: true });
  const description = () =>
    score.evaluate(
      (element) => document.getElementById(element.getAttribute('aria-describedby')!)?.textContent,
    );
  const phaseDescription = await description();
  await expect(score).not.toHaveAttribute('aria-live');
  await expect(hud.locator('.objective-seconds').first()).toHaveText('7.0 s');
  await slider.fill('1984');
  await expect(hud).toHaveAttribute('data-phase', 'defusing');
  await expect(context).toContainText('defuser');
  await expect(context).toContainText('No defuse kit');
  await expect(hud.locator('.objective-emblem .equipment-glyph')).toBeVisible();
  await expect(hud.locator('.objective-seconds').first()).toHaveText('6.0 s');
  expect(await description()).toBe(phaseDescription);
  await slider.fill('1856');
  await expect(hud).toHaveAttribute('data-phase', 'defuse-aborted');
  await slider.fill('2368');
  await expect(hud).toHaveAttribute('data-phase', 'defused');
  await slider.fill('768');
  await expect(hud).toHaveAttribute('data-phase', 'plant-aborted');
  await slider.fill('0');
  await expect(hud).toHaveCount(0);
  await slider.fill('1984');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, 'Visuals');
  const scoreToggle = page.getByRole('switch', { name: /^Match score and clock/ });
  await scoreToggle.uncheck();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  const floating = page.getByRole('complementary', { name: 'Bomb objective', exact: true });
  await expect(floating).toBeVisible();
  await expect(floating.locator('.objective-seconds').first()).toHaveText('6.0 s');
  await expect(floating).toContainText('defuser');
  await expect(hud).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, 'Visuals');
  await scoreToggle.check();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await expect(hud).toBeVisible();
  await expect(floating).toHaveCount(0);
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
            const objective = element.closest('.viewer-match-score')!.getBoundingClientRect();
            const emblem = element.querySelector('.objective-emblem')!.getBoundingClientRect();
            if (Math.abs(emblem.left + emblem.width / 2 - window.innerWidth / 2) > 1) return false;
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

test('opening a replay mid-defuse registers the live region before its first notice', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.addInitScript(() => {
    const notices: string[] = [];
    Object.assign(window, { objectiveStatusObservations: notices });
    const observer = new MutationObserver(() => {
      const status = document.querySelector('.viewer-frame > [role="status"]');
      if (status && (!notices.length || notices.at(-1) !== status.textContent))
        notices.push(status.textContent || '');
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.route('**/api/demos/objective-mid-recording', (route) =>
    route.fulfill({
      json: {
        id: 'objective-mid-recording',
        name: 'Explicit mid-objective UI fixture',
        source: 'upload',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
        duration: 69,
        rounds: 1,
        size: 1024,
        created_at: 1700000000,
      },
    }),
  );
  await page.route('**/api/demos/objective-mid-recording/playback', (route) =>
    route.fulfill({
      json: {
        ...replay,
        frames: replay.frames.map((frame, index) =>
          index === 0 ? { ...frame, tick: 1984 } : frame,
        ),
      },
    }),
  );
  await page.goto('/watch/objective-mid-recording');
  await expect(page.getByRole('group', { name: 'Bomb objective', exact: true })).toHaveAttribute(
    'data-phase',
    'defusing',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { objectiveStatusObservations: string[] })
            .objectiveStatusObservations,
      ),
    )
    .toEqual(['', 'Defusing, defuser, Bombsite B, No defuse kit']);
});
