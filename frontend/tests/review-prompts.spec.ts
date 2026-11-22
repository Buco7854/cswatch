import { chooseCameraControl, expectCameraControl } from './fixtures/viewer-transport';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { installMapFixture } from './fixtures/map-assets';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { selectOptionsForControl } from './fixtures/viewer-options';
import type { Playback } from '../../shared/playback';

const actor = '76561198000000001',
  target = '76561198000000002';
const french = JSON.parse(
  readFileSync(new URL('../src/locales/fr.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const message = (language: 'en' | 'fr', key: string) =>
  language === 'fr' ? french[key] || key : key;

import { recordedReplay } from './fixtures/review-playback';

async function openFixture(page: Page, current: () => Playback, language: 'en' | 'fr' = 'en') {
  await page.addInitScript((language) => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('cswatch.language', language);
    if (
      !localStorage.getItem(
        window.matchMedia(
          '(max-width:760px),(max-width:960px) and (max-height:560px),(pointer:coarse) and (max-height:560px)',
        ).matches
          ? 'viewer-settings-v2-mobile'
          : 'viewer-settings-v2',
      )
    )
      ['viewer-settings-v2', 'viewer-settings-v2-mobile'].forEach((key) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            quality: 'low',
            trajectories: 'off',
            utilities: false,
            radar: false,
            killfeed: false,
            autoHideControls: false,
          }),
        ),
      );
  }, language);
  await page.route('**/api/demos/review-prompts-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'review-prompts-fixture',
        name: 'Explicit review prompt fixture',
        source: 'synthetic-qa',
        status: 'ready',
        public: true,
        owned: false,
        size: 1024,
        created_at: 1700000000,
        map: current().map,
        duration: 24,
        rounds: 1,
        error: null,
      },
    }),
  );
  await page.route('**/api/demos/review-prompts-fixture/playback', (route) =>
    fulfillReplayFixture(route, current()),
  );
  await installMapFixture(page, current().map, 'review-prompts-fixture');
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
  await page.goto('/watch/review-prompts-fixture');
  await expect(page.locator('.viewer-stage canvas')).toBeVisible();
  await expect(page.locator('.viewer-map-status')).toHaveText(message(language, '3D map'));
}
const seek = (page: Page, tick: number) =>
  page.getByRole('slider', { name: 'Playback position', exact: true }).fill(String(tick));
async function show(page: Page) {
  await page.locator('.viewer-frame').waitFor();
  await expect(page.locator('.viewer-map-loading')).toHaveCount(0);
  if ((await page.locator('.viewer-frame').getAttribute('data-chrome-visible')) === 'false')
    await page.locator('.viewer-stage').press('h');
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
}
async function option(page: Page, title: string, enabled: boolean) {
  await show(page);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsForControl(page, title);
  await page.getByRole('switch', { name: new RegExp('^' + title) }).setChecked(enabled);
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
}
async function opaqueSharedCard(page: Page) {
  const color = await page
    .locator('.viewer-context-actions')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(color).not.toBe('rgba(0, 0, 0, 0)');
  const chrome = await page
    .locator('.viewer-global-actions')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(color).toBe(chrome);
  // Floating groups share the card palette; the space between stays clear.
  await expect(page.locator('.viewer-titlebar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}
async function captureScene(page: Page, info: TestInfo, name: string) {
  if ((await page.locator('.viewer-frame').getAttribute('data-chrome-visible')) === 'true')
    await page.locator('.viewer-stage').press('h');
  await expect(page.locator('.viewer-titlebar')).toHaveCSS('opacity', '0');
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
  const canvas = (await page.locator('.viewer-stage canvas').boundingBox())!;
  // Keep the image inside the actual canvas and away from all HTML edge overlays/CTAs.
  const bytes = await page.screenshot({
    clip: {
      x: canvas.x + canvas.width * 0.2,
      y: canvas.y + canvas.height * 0.2,
      width: canvas.width * 0.6,
      height: canvas.height * 0.5,
    },
    path: info.outputPath(name + '.png'),
  });
  await info.attach(name, { body: bytes, contentType: 'image/png' });
  return createHash('sha256').update(bytes).digest('hex');
}

test('low quality renders the first recorded projectile without trails and real utility primitives in 3D and 2D', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  let current = recordedReplay();
  await openFixture(page, () => current);
  await expect(page.locator('.viewer-map-status')).toBeVisible();
  // Both captures use a fixed projection that includes the fixture's throw and
  // detonation, regardless of which pawn supplies the initial free camera.
  await chooseCameraControl(page, 'Overhead');
  const scene = page.locator('.scene');
  await seek(page, 256);
  await expect(scene).toHaveAttribute('data-quality', 'low');
  await expect(scene).toHaveAttribute('data-projectile-count', '1');
  await expect(scene).toHaveAttribute('data-utility-zone-count', '0');
  const projectile = await captureScene(page, info, 'low-quality-recorded-projectile');
  current = { ...current, grenades: [] };
  // Same world bounds, actor positions, camera, theme and tick: only the recorded projectile is absent.
  await page.reload();
  await show(page);
  await chooseCameraControl(page, 'Overhead');
  await seek(page, 256);
  await expect(scene).toHaveAttribute('data-projectile-count', '0');
  const empty = await captureScene(page, info, 'low-quality-no-projectile-control');
  expect(projectile).not.toBe(empty);
  await show(page);
  await seek(page, 576);
  const noZone = await captureScene(page, info, 'low-quality-no-utility-zone-control');
  await option(page, 'Utility zones', true);
  await expect(scene).toHaveAttribute('data-utility-zone-count', '1');
  const smoke = await captureScene(page, info, 'low-quality-recorded-smoke-zone');
  expect(smoke).not.toBe(noZone);
  current = recordedReplay();
  await page.reload();
  await show(page);
  await chooseCameraControl(page, '2D tactical · low power');
  const plot = page.locator('svg.tactical-plot');
  await seek(page, 256);
  await expect(plot.locator('.tactical-projectile')).toHaveCount(1);
  await expect(plot.locator('.tactical-grenade-path')).toHaveCount(0);
  await seek(page, 513);
  await expect(plot.locator('.tactical-projectile')).toHaveCount(0);
  await expect(plot.locator('.tactical-utility-zone[data-kind="smoke"]')).toHaveCount(1);
});

test('automatic quality uses viewport and pointer fallback when the GPU identity is masked', async ({
  page,
  browser,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const autoQuality = async (targetPage: Page) =>
    targetPage.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
      const getExtension = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name: string) {
        return name === 'WEBGL_debug_renderer_info' ? null : getExtension.call(this, name);
      } as typeof getExtension;
      ['viewer-settings-v2', 'viewer-settings-v2-mobile'].forEach((key) =>
        localStorage.setItem(key, JSON.stringify({ quality: 'auto', autoHideControls: false })),
      );
    });
  await page.setViewportSize({ width: 1440, height: 900 });
  await autoQuality(page);
  await openFixture(page, recordedReplay);
  expect(await page.evaluate(() => navigator.hardwareConcurrency)).toBe(8);
  expect(await page.evaluate(() => matchMedia('(pointer:coarse)').matches)).toBe(false);
  await expect(page.locator('.scene')).toHaveAttribute('data-quality', 'high');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.scene')).toHaveAttribute('data-quality', 'low');
  const origin = new URL(page.url()).origin;
  await page.close();
  const coarse = await browser.newContext({
    baseURL: origin,
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    locale: 'en-GB',
  });
  try {
    const phone = await coarse.newPage();
    await autoQuality(phone);
    await openFixture(phone, recordedReplay);
    expect(await phone.evaluate(() => navigator.hardwareConcurrency)).toBe(8);
    expect(await phone.evaluate(() => matchMedia('(pointer:coarse)').matches)).toBe(true);
    await expect(phone.locator('.scene')).toHaveAttribute('data-quality', 'low');
  } finally {
    await coarse.close();
  }
});

test('recorded moment actions seek into ordinary playback without changing speed or creating a clip', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page, recordedReplay);
  const scene = page.locator('.scene');
  const slider = page.getByRole('slider', { name: 'Playback position', exact: true });
  const speed = page
    .getByRole('group', { name: 'Playback speed' })
    .getByRole('button', { name: '2×', exact: true });
  const noReturn = page.getByRole('button', { name: 'Return to playback', exact: true });
  await option(page, 'Economy and loadouts', true);
  const observed = page.locator(
    '.broadcast-player[data-player-id="' + actor + '"] .broadcast-player-select',
  );
  await chooseCameraControl(page, 'Overhead');
  await speed.click();
  await seek(page, 800);
  await opaqueSharedCard(page);
  await page.getByRole('button', { name: 'Replay kill', exact: true }).click();
  await expect(scene).toHaveAttribute('data-camera-mode', 'pov');
  await expect(speed).toHaveAttribute('aria-pressed', 'true');
  await expect(observed).toHaveAttribute('aria-pressed', 'true');
  expect(Number(await slider.inputValue())).toBeGreaterThanOrEqual(576);
  expect(Number(await slider.inputValue())).toBeLessThan(704);
  await expect(noReturn).toHaveCount(0);
  await expect
    .poll(async () => Number(await slider.inputValue()), { timeout: 7000 })
    .toBeGreaterThan(896);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await seek(page, 320);
  const landing = page.getByRole('button', { name: 'View grenade landing', exact: true });
  await page.locator('.viewer-stage').press('h');
  await expect(landing).toBeVisible();
  await landing.click();
  await expect(scene).toHaveAttribute('data-camera-mode', 'orbit');
  await expect(scene).toHaveAttribute('data-focus-x', '320');
  await expect(scene).toHaveAttribute('data-focus-y', '0');
  await expect(scene).toHaveAttribute('data-focus-z', '0');
  await expect(speed).toHaveAttribute('aria-pressed', 'true');
  await expect(observed).toHaveAttribute('aria-pressed', 'true');
  expect(Number(await slider.inputValue())).toBeGreaterThanOrEqual(496);
  expect(Number(await slider.inputValue())).toBeLessThan(640);
  await expect(noReturn).toHaveCount(0);
  await expect
    .poll(async () => Number(await slider.inputValue()), { timeout: 7000 })
    .toBeGreaterThan(640);
  await expect(scene).toHaveAttribute('data-camera-mode', 'orbit');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await seek(page, 700);
  await expect(slider).toHaveValue('700');
  await expect(scene).toHaveAttribute('data-camera-mode', 'orbit');
  await chooseCameraControl(page, '2D tactical · low power');
  await seek(page, 800);
  await page.getByRole('button', { name: 'Replay kill', exact: true }).click();
  await expectCameraControl(page, '2D tactical · low power');
  await expect(speed).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.viewer-stage canvas')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await seek(page, 320);
  await landing.click();
  await expectCameraControl(page, '2D tactical · low power');
  await expect(speed).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.viewer-stage canvas')).toHaveCount(0);
  const recordedTarget = page.locator('.tactical-review-target');
  await expect(recordedTarget).toBeVisible();
  // Original overview: origin(-1024,1024), scale2, reference1024.
  // Recorded landing(320,0) projects to10+(1344/2048)*100,10+(1024/2048)*100.
  await expect(recordedTarget).toHaveAttribute('cx', '75.625');
  await expect(recordedTarget).toHaveAttribute('cy', '60');
  await expect
    .poll(async () => Number(await slider.inputValue()), { timeout: 7000 })
    .toBeGreaterThan(640);
  await expect(recordedTarget).toHaveCount(0);
  await expectCameraControl(page, '2D tactical · low power');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(noReturn).toHaveCount(0);
});

test('shortcut preferences suppress suggestions without removing recorded events or utility rendering', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page, recordedReplay);
  await seek(page, 320);
  await expect(
    page.getByRole('button', { name: 'View grenade landing', exact: true }),
  ).toBeVisible();
  await option(page, 'Utility replay shortcuts', false);
  await expect(page.getByRole('button', { name: 'View grenade landing', exact: true })).toHaveCount(
    0,
  );
  await seek(page, 800);
  await expect(page.getByRole('button', { name: 'Replay kill', exact: true })).toBeVisible();
  await option(page, 'Kill and death replay shortcuts', false);
  await expect(page.getByRole('button', { name: 'Replay kill', exact: true })).toHaveCount(0);
  await expect(page.locator('.timeline-event-marker[data-tick="768"]')).toHaveCount(1);
  await option(page, 'Utility zones', true);
  await seek(page, 513);
  await expect(page.locator('.scene')).toHaveAttribute('data-utility-zone-count', '1');
  await page.reload();
  await show(page);
  await seek(page, 320);
  await expect(page.getByRole('button', { name: 'View grenade landing', exact: true })).toHaveCount(
    0,
  );
  await seek(page, 800);
  await expect(page.getByRole('button', { name: 'Replay kill', exact: true })).toHaveCount(0);
});

test('unrecorded or ambiguous ownership and clipped trajectories cannot invent review actions', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  let current = recordedReplay();
  current.events = current.events.map((event) =>
    event.type === 'player_death'
      ? { ...event, user_steamid: actor }
      : { ...event, user_steamid: undefined },
  );
  await openFixture(page, () => current);
  await seek(page, 320);
  await expect(page.getByRole('button', { name: 'View grenade landing', exact: true })).toHaveCount(
    0,
  );
  await seek(page, 800);
  await expect(page.getByRole('button', { name: 'Replay kill', exact: true })).toHaveCount(0);
  current = recordedReplay();
  current.events = [
    { type: 'grenade_thrown', tick: 256, weapon: 'smokegrenade', user_steamid: actor },
    { type: 'grenade_thrown', tick: 280, weapon: 'smokegrenade', user_steamid: actor },
    { type: 'smokegrenade_detonate', tick: 512, x: 320, y: 0, z: 0, user_steamid: actor },
  ];
  current.grenades = [{ ...current.grenades![0], points: current.grenades![0].points.slice(0, 2) }];
  await page.reload();
  await seek(page, 320);
  await expect(page.getByRole('button', { name: 'View grenade landing', exact: true })).toHaveCount(
    0,
  );
  current = recordedReplay();
  current.events.push({
    type: 'smokegrenade_detonate',
    tick: 520,
    x: 640,
    y: 0,
    z: 0,
    user_steamid: actor,
    entityid: 73,
  });
  await page.reload();
  await seek(page, 320);
  await expect(page.getByRole('button', { name: 'View grenade landing', exact: true })).toHaveCount(
    0,
  );
  current = recordedReplay();
  await page.reload();
  await seek(page, 320);
  await option(page, 'Economy and loadouts', true);
  await page
    .locator(`.broadcast-player[data-player-id="${target}"] .broadcast-player-select`)
    .click();
  await expect(page.getByRole('button', { name: 'View grenade landing', exact: true })).toHaveCount(
    0,
  );
  await seek(page, 800);
  await expect(page.getByRole('button', { name: 'Replay death', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Replay kill', exact: true }).click();
  await expect(
    page.locator(`.broadcast-player[data-player-id="${actor}"] .broadcast-player-select`),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.scene')).toHaveAttribute('data-camera-mode', 'pov');
});

test('French phone review actions remain named, reachable and usable when viewing chrome is hidden', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 320, height: 740 });
  await openFixture(page, recordedReplay, 'fr');
  await page.getByRole('button', { name: message('fr', 'Viewer menu'), exact: true }).click();
  await page
    .getByRole('menuitem', { name: message('fr', 'Switch to light theme'), exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('.timeline-slider').fill('320');
  await page.locator('.viewer-stage').press('h');
  const landing = page.getByRole('button', {
    name: message('fr', 'View grenade landing'),
    exact: true,
  });
  await expect(landing).toBeVisible();
  await opaqueSharedCard(page);
  const box = (await landing.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await landing.click();
  await expect(page.locator('.scene')).toHaveAttribute('data-camera-mode', 'orbit');
  await expect(page.locator('.scene')).toHaveAttribute('data-focus-x', '320');
  expect(Number(await page.locator('.timeline-slider').inputValue())).toBeGreaterThanOrEqual(240);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
});
