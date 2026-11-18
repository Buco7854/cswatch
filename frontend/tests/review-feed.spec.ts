import { enableViewerOverlay } from './fixtures/viewer-options';
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { recordedReplay, actor, target } from './fixtures/review-playback';
import type { Playback } from '../../shared/playback';
const fr = JSON.parse(
  readFileSync(new URL('../src/locales/fr.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const message = (language: 'en' | 'fr', key: string) => (language === 'fr' ? fr[key] || key : key);
function reviewData(): Playback {
  return {
    ...recordedReplay(),
    eventAvailability: { player_death: true, player_hurt: false },
    matchState: {
      complete: true,
      samples: [
        {
          tick: 0,
          ctScore: 7,
          tScore: 5,
          roundNumber: 13,
          phase: 'live',
          clock: { kind: 'round', startTick: 0, endTick: 1280 },
        },
      ],
    },
    throwInputs: [
      {
        eventIndex: 0,
        tick: 256,
        actorId: actor,
        provenance: 'event-network',
        sampleTick: 256,
        input: {
          source: 'network',
          buttons: '264207',
          attack: true,
          attack2: true,
          jump: true,
          duck: true,
          forward: true,
          walk: true,
        },
      },
    ],
  };
}
async function open(
  page: Page,
  data: Playback,
  language: 'en' | 'fr' = 'en',
  theme: 'dark' | 'light' = 'dark',
) {
  await page.addInitScript(
    ({ language, theme }) => {
      localStorage.setItem('theme', theme);
      localStorage.setItem('cswatch.language', language);
      ['viewer-settings', 'viewer-settings-mobile'].forEach((key) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            quality: 'low',
            autoHideControls: false,
            economy: true,
            inputLayout: 'zqsd',
            radar: true,
          }),
        ),
      );
    },
    { language, theme },
  );
  await page.route('**/api/demos/review-feed-fixture', (r) =>
    r.fulfill({
      json: {
        id: 'review-feed-fixture',
        name: 'Explicit recorded-shaped review test',
        source: 'synthetic-qa',
        status: 'ready',
        public: true,
        owned: false,
        map: data.map,
        duration: 24,
        rounds: 1,
        size: 1024,
        created_at: 1700000000,
        error: null,
      },
    }),
  );
  await page.route('**/api/demos/review-feed-fixture/playback', (r) => r.fulfill({ json: data }));
  await page.goto('/watch/review-feed-fixture');
  await expect(page.locator('.timeline-slider')).toBeVisible();
}
async function showFeed(page: Page, language: 'en' | 'fr' = 'en') {
  await enableViewerOverlay(page, 'Kills and utility review');
  await expect(page.locator('.review-feed')).toBeVisible();
}
const seek = (page: Page, tick: number) => page.locator('.timeline-slider').fill(String(tick));
const pause = async (page: Page, language: 'en' | 'fr' = 'en') => {
  const button = page.getByRole('button', { name: message(language, 'Pause'), exact: true });
  await expect(button).toBeVisible();
  await button.click();
};

test('kill and death replays offer both immutable perspectives and continue normal playback', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, reviewData());
  await seek(page, 800);
  const selected = (id: string) =>
    page.locator(`.broadcast-player[data-player-id="${id}"] .broadcast-player-select`);
  await page.getByRole('button', { name: 'Replay death', exact: true }).click();
  await expect(page.locator('.scene')).toHaveAttribute('data-camera-mode', 'pov');
  await expect(selected(target)).toHaveAttribute('aria-pressed', 'true');
  await pause(page);
  await seek(page, 800);
  await page.getByRole('button', { name: 'Replay kill', exact: true }).click();
  await expect(selected(actor)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.scene')).toHaveAttribute('data-camera-mode', 'pov');
  await expect
    .poll(async () => Number(await page.locator('.timeline-slider').inputValue()), {
      timeout: 7000,
    })
    .toBeGreaterThan(896);
  await expect(page.getByRole('button', { name: 'Return to playback', exact: true })).toHaveCount(
    0,
  );
});

test('utility toast and round list share recorded input marks with separate throw and landing navigation', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, reviewData());
  await seek(page, 320);
  const card = page.getByRole('group', { name: 'Moment shortcuts', exact: true });
  await expect(
    card.getByRole('img', { name: 'Primary and secondary attack', exact: true }),
  ).toBeVisible();
  await expect(card.locator('.throw-input-badges kbd')).toHaveText(['Z', 'Jump', 'Ctrl', 'Shift']);
  await expect(card.locator('.throw-input-badges')).toHaveAttribute(
    'data-input-provenance',
    'event-network',
  );
  await page.getByRole('button', { name: 'Replay throw', exact: true }).click();
  await expect(page.locator('.scene')).toHaveAttribute('data-camera-mode', 'pov');
  await pause(page);
  await seek(page, 320);
  await page.getByRole('button', { name: 'View grenade landing', exact: true }).click();
  await expect(page.locator('.scene')).toHaveAttribute('data-camera-mode', 'orbit');
  await expect(page.locator('.scene')).toHaveAttribute('data-focus-x', '320');
  await expect
    .poll(async () => Number(await page.locator('.timeline-slider').inputValue()))
    .toBeGreaterThanOrEqual(496);
  await pause(page);
  await seek(page, 320);
  await showFeed(page);
  const feed = page.locator('.review-feed');
  await expect(feed.getByRole('tab', { name: /^Kills/ })).toHaveAttribute('aria-selected', 'true');
  await expect(feed.locator('.review-feed-row')).toHaveCount(1);
  await feed.getByRole('tab', { name: /^Utility/ }).click();
  await expect(feed.locator('.review-feed-row')).toHaveCount(1);
  await expect(
    feed.getByRole('img', { name: 'Primary and secondary attack', exact: true }),
  ).toBeVisible();
  await expect(feed.locator('.throw-input-badges kbd')).toHaveText(['Z', 'Jump', 'Ctrl', 'Shift']);
  await expect(feed.getByRole('button', { name: /View .*grenade throw/ })).toBeVisible();
  await expect(
    feed.getByRole('button', { name: 'View grenade landing', exact: true }),
  ).toBeVisible();
});

test('missing landing and input data keep a real throw replay without guessed targets or commands', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const data = reviewData();
  data.events = data.events.filter((e) => e.type !== 'smokegrenade_detonate');
  data.throwInputs = [{ eventIndex: 0, tick: 256, actorId: actor, provenance: 'unavailable' }];
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, data);
  await seek(page, 320);
  await expect(page.getByRole('button', { name: 'Replay throw', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View grenade landing', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.viewer-context-actions .throw-input-unavailable')).toBeVisible();
  await expect(page.locator('.viewer-context-actions .throw-input-mouse')).toHaveCount(0);
  await showFeed(page);
  await page
    .locator('.review-feed')
    .getByRole('tab', { name: /^Utility/ })
    .click();
  await expect(
    page.locator('.review-feed').getByRole('button', { name: 'View grenade landing', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.review-feed').getByRole('button', { name: /View .*grenade throw/ }),
  ).toBeVisible();
  // A missing secondary field must not masquerade as a recorded unheld button.
  data.throwInputs = [
    {
      eventIndex: 0,
      tick: 256,
      actorId: actor,
      provenance: 'event-network',
      sampleTick: 256,
      input: { source: 'network', attack: false },
    },
  ];
  await page.reload();
  await seek(page, 320);
  const mouse = page.locator('.viewer-context-actions .throw-input-mouse');
  await expect(mouse).toHaveAttribute(
    'aria-label',
    'Primary attack: Not held. Secondary attack: Unavailable',
  );
  await expect(mouse.locator('[data-input-side="primary"]')).toHaveAttribute(
    'data-state',
    'not-held',
  );
  await expect(mouse.locator('[data-input-side="secondary"]')).toHaveAttribute(
    'data-state',
    'unknown',
  );
});

for (const language of ['en', 'fr'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${language}/${theme}: requested round review fits phone and short landscape with keyboard recovery`, async ({
      page,
    }) => {
      test.skip(Boolean(process.env.E2E_PRIVATE));
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, reviewData(), language, theme);
      await seek(page, 320);
      for (const size of [
        { width: 390, height: 844 },
        { width: 320, height: 740 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(size);
        await showFeed(page, language);
        const dialog = page.getByRole('dialog', {
          name: message(language, 'Round review'),
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole('tab', { name: new RegExp('^' + message(language, 'Utility')) })
          .click();
        await expect(dialog.locator('.review-feed-row')).toHaveCount(1);
        expect(
          await dialog.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.left >= 0 &&
              r.top >= 0 &&
              r.right <= innerWidth + 1 &&
              r.bottom <= innerHeight + 1 &&
              node.scrollWidth <= node.clientWidth + 1
            );
          }),
        ).toBe(true);
        for (const button of await dialog.getByRole('button').all()) {
          const box = await button.boundingBox();
          if (box) expect(box.height).toBeGreaterThanOrEqual(44);
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: message(language, 'Options'), exact: true }),
        ).toBeFocused();
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        ).toBe(true);
      }
    });
