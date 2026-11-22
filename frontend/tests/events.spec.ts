import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { installDemoMapDescriptor } from './fixtures/map-assets';
import { test, expect } from '@playwright/test';

test('timeline markers use recorded time positions, clustered events seek exactly and round zoom retains review filters', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/watch/sample');
  const plot = page.locator('.replay-timeline-plot');
  const marker = page.locator('.timeline-event-marker[data-tick="620"]');
  await expect(marker).toBeVisible();
  const fraction = await marker.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parent = element.closest('.replay-timeline-plot')!.getBoundingClientRect();
    return (box.left + box.width / 2 - parent.left) / parent.width;
  });
  expect(fraction).toBeCloseTo(620 / 3840, 2);
  // The marker owns its compact hit target above the clear scrubbing strip.
  // A range input painted across it would scrub past 620 instead of seeking it.
  const markerBox = (await marker.boundingBox())!;
  await page.mouse.click(markerBox.x + markerBox.width - 2, markerBox.y + markerBox.height - 2);
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(slider).toHaveValue('620');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  const cluster = plot.locator('.is-cluster[data-tick="620"]');
  await expect(cluster).toBeVisible();
  await cluster.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Bomb planted at 0:15/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Bomb planted at 0:15/ }).click();
  await expect(slider).toHaveValue('960');
  await page.getByRole('combobox', { name: 'Timeline range' }).click();
  await page.getByRole('option', { name: 'Current round', exact: true }).click();
  await expect(slider).toHaveAttribute('min', '0');
  await expect(slider).toHaveAttribute('max', '1279');
  await page.getByRole('button', { name: 'Replay tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Timeline options', exact: true }).click();
  await page.getByRole('button', { name: /Review round 1 events/ }).click();
  await expect(page.getByRole('dialog', { name: 'Match review' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Event range' }).click();
  await page.getByRole('option', { name: 'All match', exact: true }).click();
  await expect(page.locator('.round-review-row')).toHaveCount(6);
  await expect(page.locator('.round-review-row.event-throw')).toHaveText(
    /marlow threw Smoke grenade/,
  );
  await page.getByRole('combobox', { name: 'Event players' }).click();
  await page.getByRole('option', { name: 'All players', exact: true }).click();
  await expect(page.locator('.round-review-row')).toHaveCount(7);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByRole('button', { name: 'Replay tools', exact: true })).toBeFocused();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('961');
});

test('event stems and native scrubber share endpoint and midpoint coordinates', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const replay = {
    map: 'de_timeline_fixture',
    sample: false,
    tickRate: 64,
    players: [],
    frames: [
      { tick: 0, players: [] },
      { tick: 1000, players: [] },
    ],
    rounds: [{ number: 1, tick: 0 }],
    events: [
      { type: 'bomb_planted', tick: 0 },
      { type: 'bomb_defused', tick: 500 },
      { type: 'round_end', tick: 1000, winner: 3 },
    ],
  };
  await page.route('**/api/demos/timeline-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'timeline-fixture',
        name: 'Explicit timeline geometry fixture',
        source: 'upload',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
        duration: 16,
        rounds: 1,
        size: 100,
        created_at: 1700000000,
      },
    }),
  );
  await page.route('**/api/demos/timeline-fixture/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await page.setViewportSize({ width: 768, height: 1024 });
  await installDemoMapDescriptor(page, 'timeline-fixture');
  await page.goto('/watch/timeline-fixture');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(page.locator('.timeline-event-marker')).toHaveCount(3);
  for (const tick of [0, 500, 1000]) {
    const marker = page.locator(`.timeline-event-marker[data-tick="${tick}"]`);
    const center = await marker.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const expected = await slider.evaluate((element, tick) => {
      const r = element.getBoundingClientRect();
      return r.left + 8 + (r.width - 16) * (tick / 1000);
    }, tick);
    expect(Math.abs(center - expected)).toBeLessThan(1);
    expect(
      await marker.evaluate((element) => {
        const marker = element.getBoundingClientRect();
        const slider = element
          .closest('.replay-timeline-plot')!
          .querySelector('input')!
          .getBoundingClientRect();
        const hit = document.elementFromPoint(
          marker.left + marker.width / 2,
          marker.top + marker.height / 2,
        );
        const clearScrub = document.elementFromPoint(
          marker.left + marker.width / 2,
          slider.bottom - 3,
        );
        return (
          marker.width >= 32 &&
          marker.height >= 24 &&
          slider.height >= 44 &&
          slider.bottom - marker.bottom >= 20 &&
          element.contains(hit) &&
          clearScrub?.tagName === 'INPUT'
        );
      }),
    ).toBe(true);
    const box = await slider.boundingBox();
    await page.mouse.click(expected, box!.y + box!.height - 3);
    await expect(slider).toHaveValue(String(tick));
  }
  replay.events = [];
  await page.reload();
  const emptyPlot = page.locator('.replay-timeline-plot');
  await expect(emptyPlot).toHaveClass(/is-empty/);
  await expect(emptyPlot).toHaveCSS('height', '44px');
  await expect(
    page.getByText('No key events recorded in this range.', { exact: true }),
  ).toBeVisible();
  const emptySlider = (await slider.boundingBox())!;
  await page.mouse.click(
    emptySlider.x + emptySlider.width / 2,
    emptySlider.y + emptySlider.height / 2,
  );
  await expect(slider).toHaveValue('500');
});
