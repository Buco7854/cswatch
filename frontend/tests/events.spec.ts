import { test, expect } from '@playwright/test';

test('round event markers remain keyboard-reachable in their phone rail and open exact filtered moments', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/watch/sample');
  const markers = page.locator('.round-event-marker');
  await expect(markers).toHaveCount(3);
  await markers.first().focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(markers.last()).toBeFocused();
  expect(
    await markers.last().evaluate((element) => {
      const r = element.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }),
  ).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('1240');
  await page.getByRole('button', { name: /Review round 1 events/ }).click();
  await expect(page.getByRole('dialog', { name: 'Match review' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Event range' }).click();
  await page.getByRole('option', { name: 'All match', exact: true }).click();
  await expect(page.locator('.round-review-row')).toHaveCount(5);
  await page.getByRole('combobox', { name: 'Event players' }).click();
  await page.getByRole('option', { name: 'All players', exact: true }).click();
  await expect(page.locator('.round-review-row')).toHaveCount(6);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByRole('button', { name: /Review round 1 events/ })).toBeFocused();
});
