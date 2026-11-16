import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const catalogs = {
  en: JSON.parse(
    readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'),
  ) as Record<string, string>,
  fr: JSON.parse(
    readFileSync(new URL('../src/locales/fr.json', import.meta.url), 'utf8'),
  ) as Record<string, string>,
};
type Language = keyof typeof catalogs;
const message = (language: Language, key: string) => catalogs[language][key] || key;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Explicit UI fixture: recorded-shaped fields and real event identity semantics,
// never presented as a user's match or mixed into the public practice scene.
const firstPlayer = '76561198000000001',
  secondPlayer = '76561198000000002';
const replay = {
  version: 1,
  map: 'de_viewer_space_fixture',
  sample: false,
  tickRate: 64,
  players: [
    { id: firstPlayer, name: 'Fixture reviewer', team: 3 },
    { id: secondPlayer, name: 'Fixture opponent', team: 2 },
  ],
  frames: [0, 1280].map((tick) => ({
    tick,
    players: [firstPlayer, secondPlayer].map((id, index) => ({
      id,
      x: index * 100,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      health: 100,
      alive: true,
      team: index === 0 ? 3 : 2,
      weapon: index === 0 ? 'ak47' : 'awp',
      money: 1200,
      ammo: 30,
      input: {
        source: 'usercmd',
        buttons: '9',
        forward: true,
        back: false,
        left: false,
        right: false,
        jump: false,
        duck: false,
        walk: false,
        attack: true,
        attack2: false,
        reload: false,
        use: false,
        mouseDx: 12,
        mouseDy: -4,
      },
    })),
  })),
  rounds: [{ number: 1, tick: 0, liveTick: 64, endTick: 1270 }],
  events: [
    {
      type: 'player_death',
      tick: 128,
      attacker_steamid: firstPlayer,
      user_steamid: secondPlayer,
      attacker_name: 'Fixture reviewer',
      user_name: 'Fixture opponent',
      weapon: 'ak47',
      headshot: true,
    },
    {
      type: 'player_death',
      tick: 512,
      attacker_steamid: secondPlayer,
      user_steamid: firstPlayer,
      attacker_name: 'Fixture opponent',
      user_name: 'Fixture reviewer',
      weapon: 'awp',
    },
    { type: 'bomb_planted', tick: 896, user_steamid: secondPlayer, user_name: 'Fixture opponent' },
  ],
  capabilities: {
    economy: true,
    equipment: false,
    inventory: false,
    inputButtons: 'usercmd',
    mouseInput: true,
    utilityThrows: false,
  },
};

async function fixture(
  page: Page,
  language: Language = 'en',
  theme: 'light' | 'dark' = 'dark',
  tactical = true,
) {
  await page.addInitScript(
    ({ language, theme }) => {
      localStorage.setItem('cswatch.language', language);
      localStorage.setItem('theme', theme);
      // Preserve saved visibility on reload; only choose low rendering cost for a fresh context.
      if (!localStorage.getItem('viewer-settings'))
        localStorage.setItem('viewer-settings', JSON.stringify({ quality: 'low' }));
    },
    { language, theme },
  );
  await page.route('**/api/demos/viewer-space-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'viewer-space-fixture',
        name: 'Explicit viewer space fixture',
        source: 'synthetic-qa',
        status: 'ready',
        size: 1024,
        created_at: 1700000000,
        public: true,
        owned: false,
        map: replay.map,
        duration: 20,
        rounds: 1,
        error: null,
      },
    }),
  );
  await page.route('**/api/demos/viewer-space-fixture/playback', (route) =>
    route.fulfill({ json: replay }),
  );
  await page.goto('/watch/viewer-space-fixture');
  await expect(
    page.getByRole('heading', { name: replay.map.replace('de_', ''), exact: true }),
  ).toBeVisible();
  if (!tactical) {
    await expect(page.locator('.viewer-stage canvas')).toBeVisible();
    return;
  }
  const camera = page.getByRole('combobox', {
    name: message(language, 'Camera mode'),
    exact: true,
  });
  await camera.click();
  await page
    .getByRole('option', { name: message(language, '2D tactical · low power'), exact: true })
    .click();
  await expect(
    page.getByRole('img', {
      name: message(language, 'Player position plot. No map geometry.'),
      exact: true,
    }),
  ).toBeVisible();
}
const optionSwitch = (page: Page, title: string) =>
  page.getByRole('switch', { name: new RegExp('^' + escape(title)) });
const settings = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('viewer-settings') || '{}'));

test('recorded movement and mouse visualization require separate opt-ins', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  await expect(page.locator('.review-inputs-panel')).toHaveCount(0);
  await expect(page.locator('.input-mouse-device')).toHaveCount(0);
  await expect.poll(async () => (await settings(page)).inputs).toBe(false);
  await expect.poll(async () => (await settings(page)).mouseInput).toBe(false);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(optionSwitch(page, 'Recorded inputs')).not.toBeChecked();
  await optionSwitch(page, 'Recorded inputs').check();
  await expect(optionSwitch(page, 'Mouse buttons and movement')).not.toBeChecked();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await expect(page.locator('.input-forward')).toHaveAttribute('data-state', 'pressed');
  await expect(page.locator('.input-movement-keys')).toBeVisible();
  await expect(page.locator('.input-mouse-device')).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await optionSwitch(page, 'Mouse buttons and movement').check();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await expect(
    page.getByRole('group', { name: 'Mouse action display', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.input-mouse-primary')).toHaveAttribute('data-state', 'pressed');
  await page.reload();
  await expect(
    page.getByRole('group', { name: 'Mouse action display', exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await settings(page)).mouseInput).toBe(true);
});

async function hiddenChrome(page: Page) {
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'false');
  await expect(page.locator('.viewer-titlebar')).toHaveCSS('opacity', '0');
  await expect(page.locator('.viewer-dock')).toHaveCSS('visibility', 'hidden');
  expect(
    await page
      .locator('.viewer-titlebar,.viewer-dock')
      .evaluateAll((elements) => elements.every((element) => Boolean(element.closest('[inert]')))),
  ).toBe(true);
  await expect(page.locator('.viewer-stage')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Show controls', exact: true })).toHaveCount(0);
}

test('whole viewer controls hide without invisible focus targets and remain recoverable after reload', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const frame = page.locator('.viewer-frame');
  const stage = page.locator('.viewer-stage');
  await page.getByRole('button', { name: 'More controls', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide viewer controls', exact: true }).click();
  await hiddenChrome(page);
  await stage.press('Tab');
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeFocused();
  await expect.poll(async () => (await settings(page)).controlsHidden).toBe(false);
  await stage.focus();
  await stage.press('h');
  await hiddenChrome(page);
  await page.reload();
  await expect(frame).toHaveAttribute('data-chrome-visible', 'false');
  await expect(stage).toHaveAttribute('tabindex', '0');
  await expect(stage).toHaveAccessibleName('Demo view · tap or press H to show or hide controls');
  await expect.poll(async () => (await settings(page)).controlsHidden).toBe(true);
  await stage.focus();
  await stage.press('h');
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeFocused();
  await page.keyboard.press('h');
  await hiddenChrome(page);
  await page.keyboard.press('h');
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await expect.poll(async () => (await settings(page)).controlsHidden).toBe(false);
  await page.keyboard.down('h');
  await hiddenChrome(page);
  await page.keyboard.down('h');
  await hiddenChrome(page);
  await page.keyboard.up('h');
  await page.keyboard.press('h');
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
});

test('H keeps its normal typing behavior and does not change visibility inside dialogs', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  const dock = page.locator('.viewer-dock');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  const note = page.getByPlaceholder('What happened here?', { exact: true });
  await note.fill('Review ');
  await note.press('h');
  await expect(note).toHaveValue('Review h');
  await expect(dock).toBeVisible();
  await expect.poll(async () => (await settings(page)).controlsHidden).toBe(false);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Viewer options', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close viewer options', exact: true }).focus();
  await page.keyboard.press('h');
  await expect(dialog).toBeVisible();
  await expect(dock).toBeVisible();
  await expect.poll(async () => (await settings(page)).controlsHidden).toBe(false);
  await dialog.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  const mobilePanel = page.getByRole('dialog', { name: 'Players', exact: true });
  await expect(mobilePanel).toBeVisible();
  const closePanel = mobilePanel.getByRole('button', { name: 'Close panel', exact: true });
  await closePanel.focus();
  await page.keyboard.press('h');
  await expect(mobilePanel).toBeVisible();
  await expect.poll(async () => (await settings(page)).controlsHidden).toBe(false);
  await closePanel.click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await optionSwitch(page, 'Hide viewer controls').check();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await hiddenChrome(page);
  await page.locator('.viewer-stage').press('h');
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
});

test.describe('scene touch gestures', () => {
  test.use({ hasTouch: true });
  test('a real canvas tap fades chrome, while camera gestures and child controls do not', async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() =>
      localStorage.setItem(
        'viewer-settings',
        JSON.stringify({ quality: 'low', inputs: true, economy: true }),
      ),
    );
    await fixture(page, 'en', 'dark', false);
    const frame = page.locator('.viewer-frame');
    const stage = page.locator('.viewer-stage');
    const canvas = page.locator('.viewer-stage canvas');
    const bounds = (await canvas.boundingBox())!;
    const point = {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height * 0.45),
    };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point)).toBe(
      'CANVAS',
    );
    await stage.evaluate((element) =>
      element.addEventListener(
        'pointerdown',
        (event) => {
          (window as any).__scenePointerTarget =
            event.target instanceof Element ? event.target.tagName : '';
        },
        { capture: true },
      ),
    );
    await page.touchscreen.tap(point.x, point.y);
    await hiddenChrome(page);
    expect(await page.evaluate(() => (window as any).__scenePointerTarget)).toBe('CANVAS');
    const hud = page.locator('.viewer-review-hud');
    await expect(hud).toHaveCSS('opacity', '0');
    expect(await hud.evaluate((element) => Boolean(element.closest('[inert]')))).toBe(true);
    await page.touchscreen.tap(point.x, point.y);
    await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
    await page.getByRole('button', { name: 'Options', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: 'Viewer options', exact: true })).toBeVisible();
    await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
    await page.getByRole('button', { name: 'Close viewer options', exact: true }).tap();
    await page
      .locator(`.broadcast-player[data-player-id="${secondPlayer}"] .broadcast-player-select`)
      .tap();
    await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
    const session = await page.context().newCDPSession(page);
    const touch = (id: number, x: number, y: number) => ({
      id,
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [touch(1, point.x, point.y)],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touch(1, point.x + 36, point.y + 12)],
      });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [touch(2, point.x, point.y)],
      });
      await page.waitForTimeout(550);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [touch(3, point.x - 15, point.y), touch(4, point.x + 15, point.y)],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touch(3, point.x - 40, point.y), touch(4, point.x + 40, point.y)],
      });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
    } finally {
      await session.detach();
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  });
});

test('idle fade follows playback but respects paused state, dialogs, focus, menus, gestures and its setting', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  const frame = page.locator('.viewer-frame'),
    stage = page.locator('.viewer-stage');
  await page.getByRole('combobox', { name: 'Playback speed', exact: true }).click();
  await page.getByRole('option', { name: '0.25×', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const box = (await stage.boundingBox())!;
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height * 0.45) };
  await page.mouse.move(point.x, point.y);
  await expect(frame).toHaveAttribute('data-chrome-visible', 'false', { timeout: 6500 });
  // Real desktop movement, rather than a no-op pointer event, reveals idle chrome.
  await page.mouse.move(point.x + 24, point.y);
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForTimeout(3300);
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.waitForTimeout(3300);
  await expect(page.getByRole('dialog', { name: 'Viewer options', exact: true })).toBeVisible();
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await stage.focus();
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() =>
      Boolean(
        document.activeElement?.closest('[data-viewer-chrome]') &&
        document.activeElement?.matches(':focus-visible'),
      ),
    ),
  ).toBe(true);
  await page.waitForTimeout(3300);
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await page.getByRole('button', { name: 'More controls', exact: true }).click();
  await page.waitForTimeout(3300);
  await expect(page.getByRole('menu', { name: 'Viewer controls', exact: true })).toBeVisible();
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await page.keyboard.press('Escape');
  await stage.focus();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(3300);
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await page.mouse.up();
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await optionSwitch(page, 'Hide controls during playback').uncheck();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await stage.focus();
  await page.waitForTimeout(3300);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(frame).toHaveAttribute('data-chrome-visible', 'true');
  await expect.poll(async () => (await settings(page)).autoHideControls).toBe(false);
});

for (const language of ['en', 'fr'] as const)
  for (const theme of ['dark', 'light'] as const) {
    test(`${language}/${theme}: phone playback keeps event markers and touch seeking within a compact footer`, async ({
      page,
    }) => {
      test.skip(Boolean(process.env.E2E_PRIVATE));
      await page.setViewportSize({ width: 390, height: 844 });
      await fixture(page, language, theme);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.timeline-event-marker')).toHaveCount(3);
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 320, height: 740 },
      ]) {
        await page.setViewportSize(viewport);
        await expect
          .poll(async () => (await page.locator('.viewer-dock').boundingBox())!.height)
          .toBeLessThanOrEqual(172);
        const dock = (await page.locator('.viewer-dock').boundingBox())!;
        expect(dock.y + dock.height).toBeLessThanOrEqual(viewport.height + 1);
        expect(viewport.height - dock.y - dock.height).toBeLessThanOrEqual(12);
        const slider = page.getByRole('slider', {
          name: message(language, 'Playback position'),
          exact: true,
        });
        expect((await slider.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await slider.fill('512');
        await expect(slider).toHaveValue('512');
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        ).toBe(true);
      }
      await page
        .getByRole('button', { name: message(language, 'More controls'), exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: message(language, 'Hide viewer controls'), exact: true })
        .click();
      await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'false');
      await page.locator('.viewer-stage').press('h');
      await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
    });
  }
