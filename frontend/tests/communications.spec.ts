import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { test, expect } from '@playwright/test';
import { sample } from '../src/sample';
import { mkdirSync } from 'node:fs';

test('recorded voice decodes under the production CSP, subtitles/chat follow seek and remain optional', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Controlled synthetic media fixture is public.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    (window as any).__voiceStarts = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: any[]) {
      (window as any).__voiceStarts++;
      return start.apply(this, args as [number?, number?, number?]);
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const data = {
    ...sample,
    voice: Array.from({ length: 200 }, (_, i) => ({
      id: `voice-${i}`,
      speaker: '0',
      tick: i * 1.28,
      opus: '+P/+',
      sampleRate: 48000,
      channels: 1,
      durationMs: 20,
    })),
    chat: [
      {
        id: 'chat-0',
        tick: 40,
        speaker: '0',
        name: 'marlow',
        text: '<script>plain recorded text</script>',
        channel: 'team',
      },
    ],
    communications: {
      voice: 'available',
      chat: 'available',
      captions: 'disabled',
      unsupportedPackets: 0,
    },
  };
  await page.route('**/api/demos/voice-fixture**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/captions'))
      await route.fulfill({
        json: {
          status: 'ready',
          cues: [
            {
              id: 'cue-0',
              startTick: 64,
              endTick: 192,
              speaker: '0',
              text: 'Explicit synthetic subtitle fixture.',
              source: 'local-transcription',
            },
          ],
        },
      });
    else if (path.endsWith('/playback')) await fulfillReplayFixture(route, data);
    else
      await route.fulfill({
        json: {
          id: 'voice-fixture',
          name: 'Synthetic communications fixture',
          public: true,
          owned: false,
          status: 'ready',
          source: 'upload',
        },
      });
  });
  await page.goto('/watch/voice-fixture');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(slider).toBeVisible();
  await expect(page.locator('.communication-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('button', { name: 'Review communications', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Communications' })).toBeVisible();
  await page.getByRole('switch', { name: /Recorded voice/ }).check();
  await page.getByRole('button', { name: 'Subtitles', exact: true }).click();
  await page.getByRole('switch', { name: /Communication subtitles/ }).check();
  await expect(page.locator('.communication-list .event-row')).toContainText(
    'Explicit synthetic subtitle fixture.',
  );
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('switch', { name: /Chat overlay/ }).check();
  await page.getByRole('button', { name: 'Close communications', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeFocused();
  await slider.fill('100');
  await expect(page.locator('.voice-caption')).toContainText(
    'Explicit synthetic subtitle fixture.',
  );
  await expect(page.locator('.chat-caption')).toContainText('<script>plain recorded text</script>');
  await expect(page.locator('.communication-overlay script')).toHaveCount(0);
  const scene = page.locator('.viewer-stage');
  const bounds = (await scene.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.45);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'false');
  await expect(page.locator('.voice-caption')).toContainText(
    'Explicit synthetic subtitle fixture.',
  );
  await expect(page.locator('.voice-caption')).toBeVisible();
  await expect(page.locator('.chat-caption')).toBeVisible();
  await scene.press('h');
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
  await slider.fill('0');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__voiceStarts), { timeout: 15000 })
    .toBeGreaterThan(0);
  await page.route('**/api/auth/me', (route) => route.abort('failed'));
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  const starts = await page.evaluate(() => (window as any).__voiceStarts);
  await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(retry).toBeFocused();
  // The viewer stays mounted behind the connection error, with its audio queue stopped.
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__voiceStarts)).toBe(starts);
  await page.unroute('**/api/auth/me');
  await retry.click();
  await expect(slider).toBeVisible();
  if ((await page.locator('.viewer-frame').getAttribute('data-chrome-visible')) === 'false')
    await page.locator('.viewer-stage').press('h');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.route('**/api/demos/voice-fixture', (route) =>
    route.fulfill({ status: 404, json: { detail: 'Demo not found.' } }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(page.getByRole('heading', { name: 'Demo unavailable' })).toBeVisible();
  await expect(slider).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('French communications controls and fullscreen-aware lists fit phone, tablet and desktop in both themes', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  test.setTimeout(90000);
  await page.addInitScript(() => localStorage.setItem('cswatch.language', 'fr'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const theme of ['dark', 'light'])
    for (const [width, height] of [
      [320, 740],
      [390, 844],
      [768, 1024],
      [1440, 900],
      [1920, 1080],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto('/watch/sample?theme=' + theme);
      await page.getByRole('button', { name: 'Options', exact: true }).click();
      await page.getByRole('button', { name: 'Consulter les communications', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Communications' });
      await expect(dialog).toContainText(
        'Voix enregistrées, sous-titres locaux et discussion de la démo.',
      );
      await page.getByRole('combobox', { name: 'Perspective vocale' }).click();
      await page
        .getByRole('option', { name: 'Tous les intervenants enregistrés', exact: true })
        .click();
      await page.getByRole('button', { name: 'Sous-titres', exact: true }).click();
      await expect(
        page.getByRole('switch', { name: /Sous-titres des communications/ }),
      ).toBeVisible();
      expect(
        await dialog.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return (
            element.scrollWidth <= element.clientWidth + 1 &&
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            box.bottom <= innerHeight
          );
        }),
      ).toBe(true);
      if (process.env.CSWATCH_VISUAL_CAPTURE && [320, 1440].includes(width)) {
        mkdirSync('../.design/release-communications', { recursive: true });
        await page.screenshot({
          path: `../.design/release-communications/fr-${theme}-${width}.png`,
        });
      }
      await page.getByRole('button', { name: 'Fermer les communications' }).click();
      await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeFocused();
    }
  // The persistent action menu remains the focus return target across responsive layouts.
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/watch/sample?theme=light');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('button', { name: 'Consulter les communications', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Communications' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Fermer les communications' }).click();
  await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});
