import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const catalogs = {
  en: JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8')),
  fr: JSON.parse(readFileSync(new URL('../src/locales/fr.json', import.meta.url), 'utf8')),
} as Record<'en' | 'fr', Record<string, string>>;

for (const language of ['en', 'fr'] as const)
  test(`${language} sample subtitle preview is visibly synthetic, silent and follows the demo clock`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    const t = (key: string) => catalogs[language][key] || key;
    const theme = language === 'en' ? 'dark' : 'light';
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(
      ({ language, theme }) => {
        localStorage.setItem('cswatch.language', language);
        localStorage.setItem('theme', theme);
        localStorage.setItem(
          'viewer-settings',
          JSON.stringify({
            subtitles: false,
            voice: false,
            autoHideControls: false,
            quality: 'low',
          }),
        );
      },
      { language, theme },
    );
    let captionRequests = 0;
    await page.route('**/api/demos/sample/captions', (route) => {
      captionRequests++;
      return route.fulfill({
        status: 500,
        json: { error: 'The local practice example must not request transcription.' },
      });
    });
    await page.goto('/watch/sample');
    await expect(page.locator('.voice-caption')).toHaveCount(0);
    await page.getByRole('button', { name: t('Options'), exact: true }).click();
    await page.getByRole('button', { name: t('Review communications'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: t('Communications'), exact: true });
    await expect(
      dialog.getByText(t('Authored sample captions with no recorded audio.'), { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('switch', { name: new RegExp(t('Recorded voice')) }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: t('Subtitles'), exact: true }).click();
    await expect(
      dialog.getByText(
        t('Synthetic captions for the practice scene. No speech was recorded or transcribed.'),
        { exact: true },
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: t('Preview subtitle example'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const subtitle = page.locator('.voice-caption.is-synthetic');
    await expect(subtitle).toContainText(t('Synthetic example'));
    await expect(subtitle).toContainText(t('Smoke is down. Cross now.'));
    expect(
      await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem('viewer-settings') || '{}');
        return settings.subtitles === true && settings.voice === false;
      }),
    ).toBe(true);
    const timeline = page.getByRole('slider', { name: t('Playback position'), exact: true });
    await expect(timeline).toHaveValue('448');
    for (const [width, height] of [
      [1440, 900],
      [320, 740],
    ]) {
      await page.setViewportSize({ width, height });
      expect(
        await subtitle.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            box.bottom <= innerHeight &&
            element.scrollWidth <= element.clientWidth
          );
        }),
      ).toBe(true);
      if (process.env.CSWATCH_VISUAL_CAPTURE) {
        mkdirSync('../.design/subtitle-example', { recursive: true });
        await page.screenshot({
          path: `../.design/subtitle-example/${language}-${theme}-${width}.png`,
        });
      }
    }
    await timeline.fill('720');
    await expect(subtitle).toContainText('echo');
    await expect(subtitle).toContainText(t('One close right. Flashing over.'));
    await timeline.fill('960');
    await expect(subtitle).toContainText(t('Bomb planted. Hold the crossfire.'));
    await timeline.fill('1216');
    await expect(page.locator('.voice-caption')).toHaveCount(0);
    expect(captionRequests).toBe(0);
  });
