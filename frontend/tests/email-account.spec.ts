import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { accountStatus, syntheticEmail } from './fixtures/account-status';
import { installMemberWorkspace, memberConfig, memberUser } from './fixtures/member-workspace';

const password = 'Synthetic-registration-credential-2026';
const newPassword = 'Synthetic-recovered-credential-2026';
const library = 'Demo library';
const emailLabel = 'Email address';

test.use({ serviceWorkers: 'block' });

const connections = '/account/connections';
const verificationCode = 'a'.repeat(64);

for (const scenario of [
  { name: 'with email delivery off', delivery: false, destination: connections },
  { name: 'after verification in the same tab', delivery: true, destination: connections },
  { name: 'after the return path expires', delivery: true, expired: true, destination: '/library' },
  {
    name: 'after a different account signs in',
    delivery: true,
    otherAccount: true,
    destination: '/library',
  },
]) {
  test(`Steam profile completion handles the connected accounts return path ${scenario.name}`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_SETUP));
    if (scenario.expired) await page.clock.install();
    await installMemberWorkspace(page);
    let user = {
      ...memberUser,
      role: 'member',
      display_name: 'Steam Fixture',
      has_password: false,
      email: null as string | null,
      email_verified_at: null as number | null,
      profile_required: true,
      email_verification_required: false,
    };
    await page.route('**/api/config', (route) =>
      route.fulfill({ json: { ...memberConfig, email_delivery_enabled: scenario.delivery } }),
    );
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(user) }));
    const address = syntheticEmail();
    await page.route('**/api/auth/profile', (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe(user.csrf);
      expect(route.request().postDataJSON()).toEqual({
        email: address,
        display_name: 'Steam Reviewer',
      });
      user = {
        ...user,
        csrf: 'synthetic-profile-csrf',
        display_name: 'Steam Reviewer',
        email: address,
        profile_required: false,
        email_verification_required: scenario.delivery,
      };
      return route.fulfill({ json: accountStatus(user) });
    });
    const connected = page.getByRole('heading', { name: 'Connected accounts', exact: true });
    const shell = await page.goto('/account?' + new URLSearchParams({ returnTo: connections }));
    expect(shell?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Complete your profile' })).toBeFocused();
    await expect(connected).toHaveCount(0);
    const displayName = page.getByLabel('Display name', { exact: true });
    await expect(displayName).toHaveValue('Steam Fixture');
    await displayName.fill('Steam Reviewer');
    await page.getByLabel(emailLabel, { exact: true }).fill(address);
    await page.getByRole('button', { name: 'Save profile', exact: true }).press('Enter');

    if (scenario.delivery) {
      await expect(
        page.getByRole('heading', { name: 'Verify your email', exact: true }),
      ).toBeFocused();
      await expect(connected).toHaveCount(0);
      if (scenario.expired) await page.clock.fastForward(31 * 60 * 1000);
      if (scenario.otherAccount) {
        user = {
          ...user,
          id: 'other-email-profile',
          username: 'other_email_profile',
          csrf: 'other-profile-csrf',
          email: syntheticEmail(),
        };
      }
      await page.route('**/api/auth/email/verify', (route) => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-csrf-token']).toBe(user.csrf);
        expect(route.request().postDataJSON()).toEqual({ code: verificationCode });
        user = { ...user, email_verified_at: 1_795_000_000, email_verification_required: false };
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto('/verify-email#' + verificationCode);
      await page.getByRole('button', { name: 'Confirm email', exact: true }).press('Enter');
      await expect(
        page.getByRole('heading', { name: 'Email verified', exact: true }),
      ).toBeFocused();
      const next = page.getByRole('link', { name: 'Continue', exact: true });
      await expect(next).toHaveAttribute('href', scenario.destination);
      await next.click();
    }
    await expect(page).toHaveURL(new RegExp(scenario.destination + '$'));
    await expect(
      scenario.destination === connections
        ? connected
        : page.getByRole('heading', { name: library, exact: true }),
    ).toBeVisible();
  });
}

test('opening a verification link while signed in to a verified account asks for an account choice', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  const user = {
    ...memberUser,
    id: 'unrelated-verified-user',
    email: syntheticEmail(),
    email_verified_at: 1_795_000_000,
  };
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...memberConfig, email_delivery_enabled: true } }),
  );
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(user) }));
  let verificationWrites = 0;
  await page.route('**/api/auth/email/verify', (route) => {
    verificationWrites++;
    return route.fulfill({
      status: 400,
      json: { detail: 'This verification link has expired or was already used.' },
    });
  });
  await page.goto('/verify-email#' + verificationCode);
  await expect(page.getByRole('heading', { name: 'Verify your email', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Email verified', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm email', exact: true })).toHaveCount(0);
  await expect(page.getByText(user.email)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sign out to switch accounts', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(verificationWrites).toBe(0);
});

test('mail-disabled sign-in keeps manual reset available', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_SETUP || process.env.E2E_EXISTING_SERVER));
  const config = await (await page.request.get('/api/config')).json();
  expect(config.email_delivery_enabled).toBe(false);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Recover your account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recover your account' })).toBeVisible();
  await expect(page.getByLabel('Password reset code', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email a reset link', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText(/Enter the one-time reset code supplied by your operator/),
  ).toBeVisible();
});

async function signIn(page: Page, address: string, credential: string) {
  await page.goto('/login?returnTo=%2Flibrary');
  await page.getByLabel('Username or email', { exact: true }).fill(address);
  await page.getByLabel('Password', { exact: true }).fill(credential);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function mailboxLink(mailbox: string, address: string, path: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const data = await readFile(mailbox, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        for (const row of data.trim().split('\n').filter(Boolean)) {
          const { recipient, message } = JSON.parse(row) as { recipient: string; message: string };
          if (recipient !== address) continue;
          const candidate = /https?:\/\/[^\s]+#[a-f0-9]{64}/.exec(message)?.[0];
          if (candidate && new URL(candidate).pathname === path) link = candidate;
        }
        return Boolean(link);
      },
      { message: `The loopback SMTP sink received a ${path} link.` },
    )
    .toBe(true);
  return link!;
}

test('configured SMTP verifies sign-up and delivers a browser-bound reset link', async ({
  page,
  context,
  baseURL,
}) => {
  const mailbox = process.env.E2E_SMTP_MAILBOX;
  test.skip(!mailbox, 'Uses the isolated TLS loopback SMTP fixture.');
  const origin = new URL(baseURL!).origin;
  expect(origin).toBe('http://127.0.0.1:4493');
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.fallback() : route.abort(),
  );
  expect((await (await page.request.get('/api/config')).json()).email_delivery_enabled).toBe(true);

  const address = syntheticEmail();
  await page.goto('/register?returnTo=%2Flibrary');
  await page.getByLabel('Display name', { exact: true }).fill('Email reviewer');
  await page.getByLabel(emailLabel, { exact: true }).fill(address);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByRole('heading', { name: library })).toHaveCount(0);

  const verify = new URL(await mailboxLink(mailbox!, address, '/verify-email'));
  expect(verify.origin).toBe(origin);
  expect(verify.search).toBe('');
  await page.getByRole('button', { name: 'Send verification email' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Verification requested. Check your inbox for the link.',
  );
  await page.goto(verify.href);
  const confirm = page.getByRole('button', { name: 'Confirm email', exact: true });
  await expect(confirm).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash.length).toBe(0);
  expect((await (await page.request.get('/api/auth/me')).json()).user.email_verified_at).toBeNull();
  await confirm.press('Enter');
  await expect
    .poll(async () => {
      const status = await (await page.request.get('/api/auth/me')).json();
      return typeof status.user?.email_verified_at === 'number';
    })
    .toBe(true);
  await expect(page.getByRole('heading', { name: 'Email verified', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: library })).toBeVisible();

  await page.goto('/account');
  const username = await page.getByLabel('Your sign-in username', { exact: true }).inputValue();
  await page.getByRole('button', { name: username, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const recovery = page;
  await recovery.getByRole('link', { name: 'Recover your account', exact: true }).click();
  await expect(recovery.getByLabel('Password reset code', { exact: true })).toBeVisible();
  await recovery.getByLabel(emailLabel, { exact: true }).fill(address.toUpperCase());
  await recovery.getByRole('button', { name: 'Email a reset link', exact: true }).click();
  await expect(recovery.getByRole('status')).toHaveText(/check its inbox for a reset link/);
  const reset = new URL(await mailboxLink(mailbox!, address, '/recover'));
  expect(reset.origin).toBe(origin);
  expect(reset.search).toBe('');
  await recovery.goto(reset.href);
  await expect.poll(() => new URL(recovery.url()).hash.length).toBe(0);
  await recovery.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(recovery.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await recovery.getByLabel('New password', { exact: true }).fill(newPassword);
  await recovery.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(recovery.getByRole('heading', { name: 'Password reset' })).toBeVisible();
  await signIn(recovery, address, newPassword);
  await expect(recovery.getByRole('heading', { name: library })).toBeVisible();
});
