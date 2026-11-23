import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { chooseSelectOption } from './fixtures/select-control';
import { syntheticEmail } from './fixtures/account-status';

const oldPassword = 'Synthetic-member-credential-2026';
const newPassword = 'Synthetic-recovered-credential-2026';

async function login(page: Page, username: string, password: string) {
  await page.goto('/login?returnTo=%2Flibrary');
  await page.getByLabel('Username or email', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signInAdmin(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await login(page, 'e2e_instance_admin', 'synthetic-instance-password-2026');
  const enrollment = page.getByRole('heading', { name: 'Secure your account', exact: true });
  const library = page.getByRole('heading', { name: 'Demo library', exact: true });
  await expect(enrollment).toBeVisible();
  // Interrupt only the authoritative read after the factor has been saved.
  // The receipt must keep the codes and offer a read retry without a new write.
  let failRefresh = false;
  let writes = 0;
  await page.route('**/api/auth/factors/passkeys/confirm', async (route) => {
    writes++;
    const result = await route.fetch();
    failRefresh = result.ok();
    await route.fulfill({ response: result });
  });
  await page.route('**/api/auth/me', (route) => {
    if (!failRefresh) return route.continue();
    failRefresh = false;
    return route.abort('failed');
  });
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  await page
    .getByLabel('Name for a new passkey', { exact: true })
    .fill('Admin verification device');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  const pending = page.getByRole('region', { name: 'Security method saved' });
  await expect(pending.getByRole('alert')).toBeVisible();
  await expect(page.locator('.recovery-code-list li')).toHaveCount(0);
  await expect(pending.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  await pending.getByRole('button', { name: 'Try again', exact: true }).click();
  const receipt = page.getByRole('region', { name: 'Save your recovery codes' });
  await expect(receipt.locator('.recovery-code-list li')).toHaveCount(10);
  await receipt.getByRole('button', { name: 'Done', exact: true }).click();
  expect(writes).toBe(1);
  await page.unroute('**/api/auth/me');
  await page.unroute('**/api/auth/factors/passkeys/confirm');
  await expect(library).toBeVisible();
}

test('account email and sessions, administrative reset audit, and browser-bound recovery', async ({
  page: admin,
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium' ||
      Boolean(process.env.E2E_SETUP) ||
      Boolean(process.env.E2E_EXISTING_SERVER) ||
      process.env.E2E_REGISTRATIONS === 'false',
    'Uses an isolated Playwright server with a seeded admin and open registrations.',
  );
  const memberContext = await browser.newContext({ baseURL });
  const otherContext = await browser.newContext({ baseURL });
  try {
    const member = await memberContext.newPage();
    const other = await otherContext.newPage();
    const displayName = 'account_' + randomUUID().slice(0, 8);
    const registeredEmail = syntheticEmail();
    const memberEmail = syntheticEmail();
    const adminEmail = syntheticEmail();
    await member.goto('/register?returnTo=%2Flibrary');
    await member.getByLabel('Display name', { exact: true }).fill(displayName);
    await member.getByLabel('Email address', { exact: true }).fill(registeredEmail);
    await member.getByLabel('Password', { exact: true }).fill(oldPassword);
    await member.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(member.getByRole('heading', { name: 'Save your sign-in name' })).toBeVisible();
    const username = await member.getByLabel('Username', { exact: true }).inputValue();
    await member.getByRole('button', { name: 'Continue', exact: true }).click();

    await member.goto('/account');
    await expect(member.getByText(registeredEmail, { exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: 'Send verification email' })).toHaveCount(0);
    await member.getByRole('button', { name: 'Change email address', exact: true }).click();
    const email = member.getByRole('textbox', { name: 'Email address', exact: true });
    await expect(email).toHaveValue(registeredEmail);
    await expect(email).toBeFocused();
    await email.fill(memberEmail);
    await member.getByRole('button', { name: 'Save email address', exact: true }).click();
    await expect
      .poll(async () => (await (await member.request.get('/api/auth/me')).json()).user?.email)
      .toBe(memberEmail);

    await login(other, memberEmail.toUpperCase(), oldPassword);
    await expect(other.getByRole('heading', { name: 'Demo library', exact: true })).toBeVisible();
    await member.goto('/account/sessions');
    const sessions = member.locator('.security-list-row');
    await expect(sessions).toHaveCount(2);
    await sessions
      .filter({ hasNotText: 'This session' })
      .getByRole('button', { name: 'Sign out session', exact: true })
      .click();
    await member
      .getByRole('dialog', { name: 'Sign out this session?' })
      .getByRole('button', { name: 'Sign out session', exact: true })
      .click();
    await expect(sessions).toHaveCount(1);
    await expect(member.getByText('This session', { exact: true })).toBeVisible();
    await other.goto('/account/sessions');
    await expect(other.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();

    await signInAdmin(admin);
    await admin.goto('/admin?section=users');
    await admin.getByLabel('Username or display name').fill(displayName);
    await chooseSelectOption(admin, 'Role', 'Member');
    await admin.getByRole('button', { name: 'Search', exact: true }).click();
    await admin.getByRole('link', { name: new RegExp(username) }).click();
    await expect(admin.getByRole('heading', { name: username, exact: true })).toBeVisible();
    const target = new URL(admin.url()).searchParams.get('user')!;
    const address = admin.getByRole('textbox', { name: 'Email address', exact: true });
    await expect(address).toHaveValue(memberEmail);
    await address.fill(adminEmail);
    await admin.getByRole('button', { name: 'Change email address', exact: true }).click();
    const emailWrite = admin.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/admin/users/${target}/actions`,
    );
    await admin
      .getByRole('dialog', { name: 'Change email address for ' + username + '?' })
      .getByRole('button', { name: 'Change email address', exact: true })
      .click();
    expect((await emailWrite).postDataJSON()).toMatchObject({
      action: 'change-email',
      email: adminEmail,
      expected_email: memberEmail,
    });
    await expect(address).toHaveValue(adminEmail);
    await expect(
      admin.getByRole('button', { name: 'Change email address', exact: true }),
    ).toBeDisabled();
    await member.goto('/account');
    await expect(member.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await login(other, memberEmail, oldPassword);
    await expect(other.getByRole('alert')).toHaveText('Username or password is incorrect.');
    await login(other, adminEmail, oldPassword);
    await expect(other.getByRole('heading', { name: 'Demo library', exact: true })).toBeVisible();

    await admin.getByRole('button', { name: 'Reset password', exact: true }).click();
    await admin
      .getByRole('dialog', { name: 'Reset password for ' + username + '?' })
      .getByRole('button', { name: 'Reset password', exact: true })
      .click();

    const recoveryDialog = admin.getByRole('dialog', { name: 'Recovery link for ' + username });
    await expect(recoveryDialog).toBeVisible();
    const recovery = new URL(
      await recoveryDialog.getByLabel('One-time recovery link').inputValue(),
    );
    expect(recovery.pathname).toBe('/recover');
    expect(recovery.search).toBe('');
    expect(recovery.hash.length).toBe(65);
    await recoveryDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(recoveryDialog).toHaveCount(0);

    await admin.getByRole('link', { name: 'Security events', exact: true }).click();
    await admin.getByLabel('Action', { exact: true }).fill('admin.user.reset-password');
    await chooseSelectOption(admin, 'Outcome', 'Succeeded');
    await admin.getByLabel('Target ID', { exact: true }).fill(target);
    await admin.getByRole('button', { name: 'Apply filters', exact: true }).click();
    const event = admin.locator('.audit-event');
    await expect(event).toHaveCount(1);
    await expect(event.getByText('admin.user.reset-password', { exact: true })).toBeVisible();
    await expect(event.getByText(target, { exact: true })).toBeVisible();

    // Use the link in a browser currently signed in to a different account.
    await admin.goto(recovery.href);
    await expect(admin.getByRole('heading', { name: 'Recover your account' })).toBeVisible();
    await expect.poll(() => new URL(admin.url()).hash.length).toBe(0);
    await admin.getByRole('button', { name: 'Sign out', exact: true }).click();
    await admin.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await admin.reload();
    await expect(admin.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    const claimId = await admin.evaluate(() => window.history.state.recoveryClaim as string);
    const competingTab = await admin.context().newPage();
    await competingTab.goto('/recover');
    await competingTab.evaluate(
      (claim) => window.history.replaceState({ ...window.history.state, recoveryClaim: claim }, ''),
      claimId,
    );
    await competingTab.reload();
    await competingTab.getByLabel('New password', { exact: true }).fill(oldPassword);
    await admin.getByLabel('New password', { exact: true }).fill(newPassword);
    let completions = 0;
    await admin.route('**/api/auth/recover/complete', async (route) => {
      completions++;
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    });
    await admin.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'Password reset', exact: true })).toBeVisible();
    await competingTab.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(competingTab.getByText(/Use the password from the completed reset/)).toBeVisible();
    await competingTab.close();
    await admin.reload();
    await expect(admin.getByLabel('Your sign-in username', { exact: true })).toHaveValue(username);
    expect(completions).toBe(1);
    await login(member, username, newPassword);
    await expect(member.getByRole('heading', { name: 'Demo library', exact: true })).toBeVisible();
  } finally {
    await memberContext.close();
    await otherContext.close();
  }
});
