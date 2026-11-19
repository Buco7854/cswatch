import { test, expect, type Page } from '@playwright/test';
import { installMemberWorkspace, memberAdminData, memberUser } from './fixtures/member-workspace';

test.use({ reducedMotion: 'reduce' });

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.locator('.app-shell').evaluate((element) => element.scrollWidth <= innerWidth),
  ).toBe(true);
}

test('member lists and settings keep readable controls and metadata in both themes and languages', async ({
  page,
}) => {
  await installMemberWorkspace(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/library');
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['en', 'fr']) {
      for (const theme of ['dark', 'light']) {
        await page.evaluate(
          ({ language, theme }) => {
            localStorage.setItem('cswatch.language', language);
            localStorage.setItem('theme', theme);
          },
          { language, theme },
        );
        await page.goto('/library');
        await expect(page.locator('.demo-row:not(.table-head)')).toHaveCount(4);
        await fits(page);
        const search = page.getByRole('textbox', {
          name: language === 'fr' ? 'Rechercher des démos' : 'Search demos',
        });
        await expect(search).toBeVisible();
        expect(
          await search.evaluate((element) => element.getBoundingClientRect().width),
        ).toBeGreaterThan(150);
        for (const row of await page.locator('.demo-row:not(.table-head)').all()) {
          for (const selector of [
            '.match-name',
            '.source',
            '.rounds-count',
            '.added',
            '.demo-state',
          ]) {
            await expect(row.locator(selector)).toBeVisible();
            expect(
              await row.locator(selector).evaluate((element) => {
                const rect = element.getBoundingClientRect(),
                  parent = element.closest('.demo-row')!.getBoundingClientRect();
                return rect.left >= parent.left - 1 && rect.right <= parent.right + 1;
              }),
            ).toBe(true);
          }
        }
        await page.goto('/admin');
        await expect(page.locator('.admin-policy-panel')).toBeVisible();
        await fits(page);
        for (const toggle of await page.getByRole('switch').all()) {
          const geometry = await toggle.evaluate((element) => {
            const rect = element.getBoundingClientRect(),
              label = element.closest('label')!.getBoundingClientRect();
            return { width: rect.width, height: rect.height, targetHeight: label.height };
          });
          expect(geometry.width).toBeLessThanOrEqual(40);
          expect(geometry.height).toBeLessThanOrEqual(24);
          expect(geometry.targetHeight).toBeGreaterThanOrEqual(44);
        }
        const save = page.locator('.admin-policy-panel .button.primary');
        expect(
          await save.evaluate((element) => {
            const { width, height } = element.getBoundingClientRect();
            const color = getComputedStyle(element).backgroundColor.match(/\d+/g)!.map(Number);
            return (
              height >= 44 &&
              width < 280 &&
              Math.max(...color.slice(0, 3)) - Math.min(...color.slice(0, 3)) < 24
            );
          }),
        ).toBe(true);
        await page.goto('/account');
        await expect(page.locator('input[name="new_password"]')).toBeVisible();
        await fits(page);
        const fields = page.locator('form.settings-panel input');
        for (const field of await fields.all())
          expect(
            await field.evaluate((element) => element.getBoundingClientRect().height),
          ).toBeGreaterThanOrEqual(40);
      }
    }
  }
  expect(errors).toEqual([]);
});

test('administrator status refresh preserves policy edits and save refreshes authoritative readiness', async ({
  page,
}) => {
  await installMemberWorkspace(page);
  const data = memberAdminData();
  let available = false;
  let saved = false;
  await page.route('**/api/admin', async (route) => {
    if (route.request().method() === 'PATCH') {
      expect(route.request().headers()['x-csrf-token']).toBe('synthetic-member-csrf');
      const values = route.request().postDataJSON();
      expect(values.auto_official_maps_enabled).toBe(false);
      expect(values.public_access).toBe(true);
      data.flags.auto_official_maps_enabled.value = false;
      saved = true;
      await route.fulfill({ json: { ok: true } });
    } else {
      await route.fulfill({
        json: {
          ...data,
          mapReadiness: {
            ...data.mapReadiness,
            enabled: data.flags.auto_official_maps_enabled.value,
            worker: { available },
            inventory: {
              status: available ? 'fresh' : 'unavailable',
              mapCount: available ? 42 : 0,
            },
          },
        },
      });
    }
  });
  await page.goto('/admin');
  const automatic = page.getByRole('switch', { name: /Automatic official map preparation/ });
  await expect(automatic).toBeChecked();
  await expect(page.getByRole('switch', { name: /Public access/ })).toBeDisabled();
  await automatic.uncheck();
  const status = page.getByRole('region', { name: 'Map preparation', exact: true });
  await expect(status.getByText('Unavailable', { exact: true }).first()).toBeVisible();
  await expect(status.getByText('Maps listed: 0', { exact: true })).toHaveCount(0);
  await expect(status.locator('code')).toHaveText(
    'docker compose pull assets\ndocker compose up -d assets',
  );
  available = true;
  // A restarted instance may now lock a policy through its environment. Only
  // unlocked edits survive refresh, never obsolete lock metadata or values.
  data.flags.registrations_enabled = { value: true, locked: true };
  await page.getByRole('button', { name: 'Refresh map status' }).click();
  await expect(status.locator('.readiness-details > div').nth(2).locator('dd')).toContainText(
    'Up to date',
  );
  await expect(automatic).not.toBeChecked();
  await expect(page.getByRole('switch', { name: /New registrations/ })).toBeChecked();
  await expect(page.getByRole('switch', { name: /New registrations/ })).toBeDisabled();
  await expect(status.getByText('Maps listed: 42', { exact: true })).toBeVisible();
  await expect(status.locator('.readiness-help')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Instance settings saved.', { exact: true })).toBeVisible();
  expect(saved).toBe(true);
  await expect(status.locator('.readiness-details > div').first().locator('dd')).toHaveText(
    'Disabled',
  );
  await expect(page.locator('.instance-build a')).toHaveAttribute(
    'href',
    'https://github.com/Buco7854/cswatch/commit/' + 'a'.repeat(40),
  );
});

test('inventory diagnostics retain safe causes without promising retries from a stopped worker', async ({
  page,
}) => {
  await installMemberWorkspace(page);
  let running = false;
  let recovered = false;
  await page.route('**/api/admin', (route) =>
    route.fulfill({
      json: {
        ...memberAdminData(),
        mapReadiness: {
          enabled: true,
          catalog: { status: 'empty', entries: 0 },
          inventory: { status: recovered ? 'fresh' : 'unavailable', mapCount: recovered ? 42 : 0 },
          worker: {
            available: running,
            ...(!recovered
              ? {
                  inventoryFailure: {
                    phase: 'downloader',
                    code: 'network_unavailable',
                    at: Math.floor(Date.now() / 1000) - 30,
                    retryAt: Math.floor(Date.now() / 1000) + 900,
                  },
                }
              : {}),
          },
        },
      },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  const status = page.getByRole('region', { name: 'Map preparation', exact: true });
  await expect(
    status.getByText('Check outbound network access and DNS for the assets service.'),
  ).toBeVisible();
  await expect(status.getByText('Diagnostic code: downloader/network_unavailable')).toBeVisible();
  await expect(status.getByText(/Next inventory check:/)).toHaveCount(0);
  await fits(page);
  running = true;
  await page.getByRole('button', { name: 'Refresh map status' }).click();
  await expect(status.getByText(/Next inventory check:/)).toBeVisible();
  recovered = true;
  await page.getByRole('button', { name: 'Refresh map status' }).click();
  await expect(status.locator('.readiness-failure')).toHaveCount(0);
  await expect(status.locator('.readiness-details > div').nth(2).locator('dd')).toContainText(
    'Up to date',
  );
  await expect(status.getByText('Maps listed: 42', { exact: true })).toBeVisible();
  await fits(page);
});

test('admin loading failures retain a local retry and a successful retry restores real settings', async ({
  page,
}) => {
  await installMemberWorkspace(page);
  let fail = true;
  await page.route('**/api/admin', (route) =>
    route.fulfill(
      fail
        ? { status: 503, json: { detail: 'Connection lost. Try again.' } }
        : { json: memberAdminData() },
    ),
  );
  await page.goto('/admin');
  await expect(page.getByRole('alert')).toContainText('Connection lost. Try again.');
  await expect(page.locator('.admin-policy-panel')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.admin-policy-panel')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a password response after leaving the form cannot publish stale CSRF or notify a newer account view', async ({
  page,
}) => {
  await installMemberWorkspace(page);
  let completePassword!: () => void, completeRefresh!: () => void;
  const passwordGate = new Promise<void>((resolve) => (completePassword = resolve));
  const refreshGate = new Promise<void>((resolve) => (completeRefresh = resolve));
  let passwordCompleted = false,
    attempts = 0,
    mutationCsrf = '';
  await page.route('**/api/auth/me', async (route) => {
    if (passwordCompleted) await refreshGate;
    await route.fulfill({ json: { user: memberUser } });
  });
  await page.route('**/api/auth/password', async (route) => {
    attempts++;
    await passwordGate;
    passwordCompleted = true;
    await route.fulfill({ json: { csrf: 'obsolete-password-response-token' } });
  });
  await page.route('**/api/admin', (route) => {
    if (route.request().method() === 'PATCH') {
      mutationCsrf = route.request().headers()['x-csrf-token'];
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: memberAdminData() });
  });
  try {
    await page.goto('/account');
    await page.getByLabel('Current password', { exact: true }).fill('Original-password-2026');
    await page.getByLabel('New password', { exact: true }).fill('Replacement-password-2026');
    await page.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    await page
      .locator('form.settings-panel')
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.evaluate(() => {
      history.pushState({}, '', '/admin');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.admin-policy-panel')).toBeVisible();
    const refreshing = page.waitForRequest('**/api/auth/me');
    completePassword();
    await refreshing;
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect.poll(() => mutationCsrf).not.toBe('');
    expect(mutationCsrf).toBe(memberUser.csrf);
    completeRefresh();
    await expect(page.getByText('Instance settings saved.', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Password updated. Other sessions have been signed out.', { exact: true }),
    ).toHaveCount(0);
    expect(attempts).toBe(1);
  } finally {
    completePassword();
    completeRefresh();
  }
});
