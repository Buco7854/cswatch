import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  managedSnapshot as snapshot,
  installMapManagement as install,
} from './fixtures/map-management';

test('map deletion names its snapshot in the reusable confirmation, queues exactly that reviewed version and preserves operator maps', async ({
  page,
}) => {
  const state = await install(page);
  await page.goto('/admin');
  const button = page.getByRole('button', { name: 'Delete de_ancient', exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Delete de_ancient?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  expect(state.requests).toEqual([]);
  await button.click();
  await dialog.getByRole('button', { name: 'Delete map', exact: true }).click();
  await expect(page.getByText('Waiting for the assets service to delete this map.')).toBeVisible();
  await expect(button).toBeDisabled();
  expect(state.requests).toEqual([
    { path: `/api/admin/maps/${snapshot.packId}`, body: { version: snapshot.version } },
  ]);
  state.maps = [];
  await page.getByRole('button', { name: 'Refresh installed maps', exact: true }).click();
  await expect(page.locator('.managed-map-list > li')).toHaveCount(0);
  await expect(
    page.locator('.operator-map-list').getByText('de_cache', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No managed maps installed yet.')).toHaveCount(0);
});

test('shared asset retry preserves unsaved policy edits and displays the authoritative preparation state', async ({
  page,
}) => {
  const state = await install(page);
  await page.goto('/admin');
  const registrations = page.getByRole('switch', { name: 'New registrations' });
  await registrations.check();
  await page.getByRole('button', { name: 'Retry Player models', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry Player models', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.locator('.shared-artwork-status').getByText('ct', { exact: true }),
  ).toBeVisible();
  await expect(registrations).toBeChecked();
  expect(state.requests).toEqual([
    { path: '/api/admin/assets/presentation/agents/retry', body: {} },
  ]);
});

test('leaving the admin page cancels an open deletion confirmation without submitting a late destructive action', async ({
  page,
}) => {
  const state = await install(page);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Delete de_ancient', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, '', '/account');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.requests).toEqual([]);
});

test('asset retry cooldown enables at its recorded deadline and integrity failures remain terminal', async ({
  page,
}) => {
  const clock = new Date('2026-11-19T16:00:00Z');
  await page.clock.install({ time: clock });
  const state = await install(page);
  state.retryAt = clock.getTime() / 1000 + 300;
  await page.goto('/admin');
  const retry = page.getByRole('button', { name: 'Retry Player models', exact: true });
  await expect(retry).toBeDisabled();
  await page.clock.fastForward(300001);
  await expect(retry).toBeEnabled();
  expect(state.requests).toEqual([]);
  state.terminal = true;
  await page.getByRole('button', { name: 'Refresh map status', exact: true }).click();
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByText('Integrity failed. Review the source.', { exact: true }),
  ).toBeVisible();
});

test('map actions, pending failures and shared asset diagnostics fit EN/FR at desktop, tablet and phone sizes in both themes', async ({
  page,
}) => {
  await install(page, [
    snapshot,
    { ...snapshot, packId: 'c'.repeat(64), map: 'de_dust2', removal: 'queued' },
    { ...snapshot, packId: 'd'.repeat(64), map: 'de_mirage', removal: 'failed' },
  ]);
  const capture = process.env.CSWATCH_ADMIN_MAP_CAPTURE_DIR;
  if (capture) await mkdir(capture, { recursive: true });
  for (const [width, height] of [
    [1440, 1000],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const language of ['en', 'fr'])
      for (const theme of ['dark', 'light']) {
        await page.goto('/admin');
        await page.evaluate(
          ({ language, theme }) => {
            localStorage.setItem('cswatch.language', language);
            localStorage.setItem('theme', theme);
          },
          { language, theme },
        );
        await page.reload();
        const section = page.locator('.managed-maps-section');
        await expect(section.getByText('de_ancient', { exact: true })).toBeVisible();
        await section.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        for (const button of await section.getByRole('button').all()) {
          const bounds = await button.boundingBox();
          expect(bounds?.height).toBeGreaterThanOrEqual(44);
        }
        if (capture)
          await section.screenshot({
            path: join(capture, `${width}-${language}-${theme}-maps.png`),
          });
        const artwork = page.locator('.shared-artwork-status');
        await artwork.scrollIntoViewIfNeeded();
        await expect(artwork.getByText('67 / 67', { exact: false })).toBeVisible();
        if (capture)
          await artwork.screenshot({
            path: join(capture, `${width}-${language}-${theme}-assets.png`),
          });
        await page
          .getByRole('button', {
            name: language === 'fr' ? 'Supprimer de_ancient' : 'Delete de_ancient',
            exact: true,
          })
          .click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const bounds = await dialog.boundingBox();
        expect(bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        if (capture)
          await page.screenshot({
            path: join(capture, `${width}-${language}-${theme}-confirmation.png`),
          });
        await page.keyboard.press('Escape');
      }
  }
});
