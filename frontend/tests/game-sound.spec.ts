import { choosePlaybackSpeed } from './fixtures/viewer-transport';
import { expect, test } from '@playwright/test';
import { installGameSoundFixture, observeActualAudio } from './fixtures/game-sound';

test.beforeEach(() =>
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP)),
);

test('gameplay and voice share real decoded audio under CSP, flush on pause/seek/mute and close on identity change', async ({
  page,
}) => {
  await installGameSoundFixture(page);
  await observeActualAudio(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/watch/game-sound-a');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(slider).toBeVisible();
  expect(await page.evaluate(() => (window as any).__audioQA.contexts)).toBe(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Playback', exact: true }).click();
  await page.getByRole('switch', { name: 'Recorded voice', exact: true }).check();
  expect(await page.evaluate(() => (window as any).__audioQA.contexts)).toBe(1);
  expect(
    await page.evaluate(
      () => (window as any).__audioQA.game.length + (window as any).__audioQA.voice,
    ),
  ).toBe(0);
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioQA.game.length))
    .toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__audioQA.voice)).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioQA.peakRMS))
    .toBeGreaterThan(0.0001);
  expect(await page.evaluate(() => (window as any).__audioQA.contexts)).toBe(1);
  expect(await page.evaluate(() => (window as any).__audioQA.game[0].sampleRate)).toBe(48000);
  expect(await page.evaluate(() => (window as any).__audioQA.panners)).toBeGreaterThan(0);
  const stopsBeforePause = await page.evaluate(() => (window as any).__audioQA.stops);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const beforeSeek = await page.evaluate(() => ({
    starts: (window as any).__audioQA.game.length,
    stops: (window as any).__audioQA.stops,
  }));
  expect(beforeSeek.stops).toBeGreaterThan(stopsBeforePause);
  await slider.fill('200');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioQA.game.length))
    .toBe(beforeSeek.starts + 1);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__audioQA.game.length)).toBe(
    beforeSeek.starts + 1,
  );
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await slider.fill('400');
  await choosePlaybackSpeed(page, '2×');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__audioQA.game.at(-1)?.rate)).toBe(2);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Playback', exact: true }).click();
  await page.getByText('Sound settings', { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioRMS()), { intervals: [16] })
    .toBeGreaterThan(0.0001);
  await page.getByRole('switch', { name: /Mute all audio/ }).check();
  await expect.poll(() => page.evaluate(() => (window as any).__audioRMS())).toBeLessThan(0.0001);
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.evaluate(() => {
    history.pushState({}, '', '/watch/game-sound-b');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__audioQA.closed)).toBe(1);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__audioQA.contexts)).toBe(1);
  expect(await page.evaluate(() => (window as any).__audioQA.violations)).toEqual([]);
  expect(errors).toEqual([]);
});

test('an initially empty sound bank is rediscovered without reload and unsupported source data never reaches a decoder', async ({
  page,
}) => {
  const fixture = await installGameSoundFixture(page);
  await observeActualAudio(page);
  let catalogs = 0;
  await page.route('**/api/sound-assets', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        items: ++catalogs === 1 ? {} : { 'ak47-fire': fixture.descriptor },
      },
    }),
  );
  await page.goto('/watch/game-sound-a');
  await expect.poll(() => catalogs).toBe(2);
  expect(await page.evaluate(() => (window as any).__audioQA.contexts)).toBe(0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__audioQA.game.length))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const starts = await page.evaluate(() => (window as any).__audioQA.game.length);
  const bad = Buffer.from(fixture.wave);
  bad.writeUInt16LE(85, 20);
  await page.route('**/api/sound-assets/*.wav', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: bad }),
  );
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Playback', exact: true }).click();
  await page.getByText('Sound settings', { exact: true }).click();
  // Retry recreates the private failed/decoded cache without another context.
  await page.getByRole('switch', { name: /Game sounds/ }).uncheck();
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.evaluate(() => {
    history.pushState({}, '', '/watch/game-sound-b');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Playback', exact: true }).click();
  await page.getByRole('switch', { name: /Game sounds/ }).check();
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Playback', exact: true }).click();
  await page.getByText('Sound settings', { exact: true }).click();
  await expect(
    page.getByText('Some game sounds could not be decoded or verified.', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__audioQA.game.length)).toBe(starts);
});

test.describe('phone audio', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('a touch playback gesture unlocks one context and French progressive audio controls fit both themes', async ({
    page,
  }) => {
    await installGameSoundFixture(page);
    await observeActualAudio(page);
    await page.addInitScript(() => localStorage.setItem('cswatch.language', 'fr'));
    await page.goto('/watch/game-sound-a');
    expect(await page.evaluate(() => (window as any).__audioQA.contexts)).toBe(0);
    await page.getByRole('button', { name: 'Lire', exact: true }).tap();
    await expect
      .poll(() => page.evaluate(() => (window as any).__audioQA.game.length))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__audioQA.contexts)).toBe(1);
    await page.getByRole('button', { name: 'Pause', exact: true }).tap();
    await page.getByRole('button', { name: 'Options', exact: true }).tap();
    await page.getByRole('tab', { name: 'Lecture', exact: true }).tap();
    await page.getByText('Réglages audio', { exact: true }).tap();
    await expect(page.getByText('Couverture enregistrée partielle', { exact: true })).toBeVisible();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        const panel = page.locator('.viewer-game-sounds');
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await page.getByRole('switch', { name: /Signaux de manche/ }).scrollIntoViewIfNeeded();
        await expect(page.getByRole('switch', { name: /Signaux de manche/ })).toBeInViewport({
          ratio: 1,
        });
      }
    }
    expect(await page.evaluate(() => (window as any).__audioQA.violations)).toEqual([]);
  });
});
