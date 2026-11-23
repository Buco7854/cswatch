import { memberConfig } from './fixtures/member-workspace';
import { accountStatus, syntheticEmail } from './fixtures/account-status';
import { expect, test, type Page } from '@playwright/test';

async function policy(page: Page, registrations = true, steam = true) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(null) }));
  await page.route('**/api/config', async (route) => {
    return route.fulfill({
      json: {
        ...memberConfig,
        public_access: true,
        registrations_enabled: registrations,
        steam_enabled: steam,
      },
    });
  });
}
test.beforeEach(() =>
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP)),
);

test('dedicated auth routes preserve review intent, share local controls and keep credentials out of navigation', async ({
  page,
}) => {
  await policy(page);
  await page.goto('/login?returnTo=%2Fwatch%2Fprivate-demo%3Ft%3D128');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Continue with Steam', exact: true }),
  ).toBeVisible();
  await page.route('**/api/auth/steam', (route) =>
    route.fulfill({ status: 403, json: { detail: 'Steam sign-in is disabled.' } }),
  );
  const steamRequest = page.waitForRequest('**/api/auth/steam');
  await page.getByRole('button', { name: 'Continue with Steam', exact: true }).click();
  const startSteam = await steamRequest;
  expect(startSteam.method()).toBe('POST');
  expect(startSteam.postDataJSON().return_to).toBe('/watch/private-demo?t=128');

  await page.getByRole('link', { name: 'New here? Create an account', exact: true }).click();
  await expect(page).toHaveURL(/\/register\?returnTo=%2Fwatch%2Fprivate-demo%3Ft%3D128$/);
  await page.getByLabel('Display name', { exact: true }).fill('original_auth_fixture');
  const email = page.getByLabel('Email address', { exact: true });
  await expect(email).toHaveAttribute('type', 'email');
  await expect(email).toHaveAttribute('autocomplete', 'email');
  await expect(email).toHaveAttribute('required', '');
  const address = syntheticEmail();
  await email.fill(address);
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('Synthetic-password-2026');
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Hide password', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(page.url()).not.toContain('Synthetic-password');
  expect(page.url()).not.toContain(address);
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
  await expect(password).toHaveValue('');
  await expect(email).toHaveValue('');
  await page.getByRole('link', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL(/\/watch\/private-demo\?t=128$/);
});

test('direct registration follows instance policy and disallowed return destinations never reach Steam', async ({
  page,
}) => {
  await policy(page, false, true);
  await page.goto('/register?returnTo=https%3A%2F%2Funtrusted.invalid');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Flibrary$/);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'New here? Create an account', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      'New registrations are closed on this instance. Existing members can still sign in.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue with Steam', exact: true }),
  ).toBeVisible();
  await page.route('**/api/auth/steam', (route) =>
    route.fulfill({ status: 403, json: { detail: 'Steam sign-in is disabled.' } }),
  );
  const steamRequest = page.waitForRequest('**/api/auth/steam');
  await page.getByRole('button', { name: 'Continue with Steam', exact: true }).click();
  const startSteam = await steamRequest;
  expect(startSteam.method()).toBe('POST');
  expect(startSteam.postDataJSON().return_to).toBe('/library');

  await policy(page, false, false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue with Steam', exact: true })).toHaveCount(
    0,
  );
});
