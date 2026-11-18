import { installDemoMapDescriptor } from './fixtures/map-assets';
import { test, expect } from '@playwright/test';
import { sample } from '../src/sample';

test('demo deletion uses an accessible reusable modal with safe cancellation and keyboard focus', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'confirm-fixture',
          username: 'fixture',
          is_admin: false,
          csrf: 'synthetic-csrf',
          identities: [],
        },
      },
    }),
  );
  let deletes = 0;
  await page.route('**/api/demos/confirm-fixture', (route) => {
    if (route.request().method() === 'DELETE') {
      deletes++;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      json: {
        id: 'confirm-fixture',
        name: 'Fixture match',
        source: 'upload',
        status: 'ready',
        owned: true,
        public: false,
        map: sample.map,
        duration: 60,
        rounds: 3,
        size: 100,
        created_at: 0,
      },
    });
  });
  await page.route('**/api/demos/confirm-fixture/playback', (route) =>
    route.fulfill({ json: { ...sample, sample: false } }),
  );
  await page.route('**/api/demos?*', (route) => route.fulfill({ json: { demos: [], total: 0 } }));
  page.on('dialog', () => {
    throw new Error('Browser confirmation must not be used.');
  });
  await installDemoMapDescriptor(page, 'confirm-fixture');
  await page.goto('/watch/confirm-fixture');
  await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage', exact: true }).click();
  const management = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Manage demo', exact: true }) });
  const remove = management.getByRole('button', { name: 'Delete permanently', exact: true });
  await remove.click();
  const confirmation = page.getByRole('dialog', { name: 'Delete demo', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  expect(deletes).toBe(0);
  await expect(remove).toBeFocused();
  await remove.click();
  await confirmation.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect.poll(() => deletes).toBe(1);
  await expect(page).toHaveURL(/\/library$/);
});

test('a late rename cannot overwrite a different demo after its manager closes', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'confirm-fixture',
          username: 'fixture',
          is_admin: false,
          csrf: 'synthetic-csrf',
          identities: [],
        },
      },
    }),
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let renamed = false;
  await page.route(/\/api\/demos\/rename-[^/]+(?:\/playback)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'PATCH') {
      renamed = true;
      await pending;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/playback')) return route.fulfill({ json: { ...sample, sample: false } });
    const id = path.split('/').at(-1)!;
    return route.fulfill({
      json: {
        id,
        name: id === 'rename-a' ? 'Fixture A' : 'Fixture B',
        source: 'upload',
        status: 'ready',
        owned: true,
        public: false,
        map: sample.map,
        duration: 60,
        rounds: 3,
        size: 100,
        created_at: 0,
      },
    });
  });
  await installDemoMapDescriptor(page, 'rename-a');
  await installDemoMapDescriptor(page, 'rename-b');
  await page.goto('/watch/rename-a');
  await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage', exact: true }).click();
  await page.getByLabel('Demo name', { exact: true }).fill('Old response must not become B');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect.poll(() => renamed).toBe(true);
  await page.getByRole('button', { name: 'Close demo management', exact: true }).click();
  await page.evaluate(() => {
    history.pushState({}, '', '/watch/rename-b');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('slider', { name: 'Playback position' })).toBeVisible();
  const complete = page.waitForResponse(
    (response) => response.url().endsWith('/rename-a') && response.request().method() === 'PATCH',
  );
  release();
  await complete;
  await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage', exact: true }).click();
  await expect(page.getByLabel('Demo name', { exact: true })).toHaveValue('Fixture B');
});
