import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { syntheticEmail } from './fixtures/account-status';

if (!process.env.E2E_EXISTING_SERVER)
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '192.0.2.24' } });

const password = 'Synthetic-virtual-authenticator-2026';
const newPassword = 'Synthetic-virtual-authenticator-2027';
const libraryHeading = 'Demo library';
const passkeySetup = '**/api/auth/factors/passkeys/';
const expiredPasskey = 'Security verification expired. Start again.';
const interruptedConnection = 'Connection lost. Try again.';
const nameRequired = 'Enter a name to create a new passkey.';
const hiddenNameCharacters =
  'Remove hidden formatting or control characters from the passkey name.';
const joinedEmojiName = 'Laptop 👩‍💻 key';
const newPasskeyName = 'Name for a new passkey';

async function signOut(page: Page, username: string) {
  await page.getByRole('button', { name: username, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.goto('/login?returnTo=%2Flibrary');
}

async function passwordFirstFactor(page: Page, username: string) {
  await page.getByLabel('Username or email', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify your sign-in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: libraryHeading, exact: true })).toHaveCount(0);
}

function requiresVirtualPasskey(browserName: string) {
  test.skip(
    browserName !== 'chromium' ||
      Boolean(process.env.E2E_SETUP) ||
      process.env.E2E_REGISTRATIONS === 'false',
    'Requires a Chromium virtual authenticator and open registrations.',
  );
}

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function registerAccount(page: Page) {
  const displayName = 'passkey_' + randomUUID().slice(0, 8);
  await page.goto('/register?returnTo=%2Faccount');
  await page.getByLabel('Display name', { exact: true }).fill(displayName);
  await page.getByLabel('Email address', { exact: true }).fill(syntheticEmail());
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your sign-in name' })).toBeVisible();
  const assigned = page.getByLabel('Username', { exact: true });
  await expect(assigned).toHaveValue(new RegExp('^' + displayName + '-[0-9a-f]{16}$'));
  const username = await assigned.inputValue();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  return username;
}

async function openPasskeyForm(page: Page, name?: string) {
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  if (name) await page.getByLabel(newPasskeyName, { exact: true }).fill(name);
  return page.getByRole('button', { name: 'Continue setup', exact: true });
}

test('a discoverable passkey works for sign-in, second factor and fresh account proof', async ({
  page,
  browserName,
}) => {
  requiresVirtualPasskey(browserName);
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  try {
    const username = await registerAccount(page);
    let optionsRequests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/auth/factors/passkeys/options')) optionsRequests++;
    });
    const create = await openPasskeyForm(page);
    const nameField = page.getByLabel(newPasskeyName, { exact: true });
    await create.click();
    await expect(page.getByRole('alert').filter({ hasText: nameRequired })).toBeVisible();
    expect(optionsRequests).toBe(0);

    await nameField.fill(joinedEmojiName);
    await nameField.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: hiddenNameCharacters })).toBeVisible();
    await expect(nameField).toHaveAttribute('aria-invalid', 'true');
    await expect(nameField).toHaveAccessibleDescription(new RegExp(hiddenNameCharacters));
    expect(optionsRequests).toBe(0);
    expect(
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    ).toHaveLength(0);

    await nameField.fill('Virtual security key');
    await page.evaluate(() => {
      const create = navigator.credentials.create;
      navigator.credentials.create = () => {
        navigator.credentials.create = create;
        return Promise.reject(new DOMException('Cancelled by the test user', 'NotAllowedError'));
      };
    });
    const cancelled = page.waitForResponse(passkeySetup + 'cancel');
    await create.click();
    expect((await cancelled).ok()).toBe(true);
    await expect(
      page.getByText('Passkey setup did not finish. Try again or use another device.'),
    ).toBeVisible();

    let firstChallenge: string | undefined;
    let attempt: string | undefined;
    await page.route(
      passkeySetup + 'options',
      async (route) => {
        attempt = route.request().postDataJSON().attempt;
        const response = await route.fetch();
        if (response.ok()) firstChallenge = (await response.json()).options.challenge;
        await route.abort('failed');
      },
      { times: 1 },
    );
    await create.click();
    await expect(page.getByText(interruptedConnection, { exact: true })).toBeVisible();
    expect(firstChallenge).toBeTruthy();
    expect(attempt).toMatch(/^[a-f0-9]{32}$/);
    // An undelivered cancellation still dismisses the form. The same attempt can be checked on retry.
    await page.route(passkeySetup + 'cancel', (route) => route.abort('failed'), { times: 1 });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add passkey', exact: true })).toBeFocused();
    await expect(page.getByText(interruptedConnection, { exact: true })).toBeVisible();
    expect(
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    ).toHaveLength(0);
    await page.reload();
    const retry = await openPasskeyForm(page);
    const unnamedCreation = page.waitForResponse(passkeySetup + 'options');
    await retry.click();
    const creationOptions = await unnamedCreation;
    expect(creationOptions.request().postDataJSON().attempt).toBe(attempt);
    expect((await creationOptions.json()).phase).toBe('create');
    await expect(page.getByRole('alert').filter({ hasText: nameRequired })).toBeVisible();
    expect(
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    ).toHaveLength(0);
    await nameField.fill('Virtual security key');

    const staged = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    await page.route(
      passkeySetup + 'verify',
      async (route) => {
        const response = await route.fetch();
        staged.resolve(response.status());
        await release.promise;
        await route.abort('failed');
      },
      { times: 1 },
    );
    const resumedCreation = page.waitForResponse(passkeySetup + 'options');
    await retry.click();
    const resumed = await resumedCreation;
    expect(resumed.request().postDataJSON().attempt).toBe(attempt);
    expect((await resumed.json()).options.challenge).toBe(firstChallenge);
    const other = await page.context().newPage();
    try {
      expect(await staged.promise).toBe(200);
      await other.goto('/account');
      await (await openPasskeyForm(other, 'Passkey in another tab')).click();
      await expect(
        other.getByText(
          'A passkey setup is already in progress. Finish it where it started, or try again after it expires.',
        ),
      ).toBeVisible();
    } finally {
      release.resolve();
      await other.close();
    }
    await expect(page.getByText(interruptedConnection, { exact: true })).toBeVisible();
    expect(
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    ).toHaveLength(1);
    await page.reload();
    await openPasskeyForm(page);
    await expect(nameField).toHaveValue('');
    await expect(nameField).toHaveAccessibleDescription(
      'Already created the passkey? Leave this blank. It keeps its original name, and you can rename it after setup.',
    );
    const confirmation = page.waitForRequest(passkeySetup + 'confirm');
    const finishConfirmation = Promise.withResolvers<void>();
    await page.route(
      passkeySetup + 'confirm',
      async (route) => {
        await finishConfirmation.promise;
        await route.continue();
      },
      { times: 1 },
    );
    const resumedPossession = page.waitForResponse(passkeySetup + 'options');
    try {
      await nameField.press('Enter');
      const possession = await resumedPossession;
      expect(possession.request().postDataJSON().attempt).toBe(attempt);
      expect((await possession.json()).phase).toBe('possession');
      await confirmation;
      await expect(nameField).toBeHidden();
      await expect(
        page.getByRole('status').filter({
          hasText: 'Confirm with the passkey you created to finish setup.',
        }),
      ).toBeVisible();
    } finally {
      finishConfirmation.resolve();
    }
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0].isResidentCredential).toBe(true);
    const codes = page.locator('.recovery-code-list li');
    await expect(codes).toHaveCount(10);
    const recoveryCode = await codes.first().textContent();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByText('Virtual security key', { exact: true })).toBeVisible();
    await expect(codes).toHaveCount(0);

    await signOut(page, username);
    await passwordFirstFactor(page, username);
    await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expect(page.getByRole('heading', { name: libraryHeading, exact: true })).toBeVisible();

    await signOut(page, username);
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await expect(page.getByRole('heading', { name: libraryHeading, exact: true })).toBeVisible();

    await signOut(page, username);
    await passwordFirstFactor(page, username);
    await page.getByRole('button', { name: 'Use a recovery code', exact: true }).click();
    await page.getByLabel('Recovery code', { exact: true }).fill(recoveryCode!);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page.getByRole('heading', { name: libraryHeading, exact: true })).toBeVisible();

    await page.goto('/account');
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Update password', exact: true }).click();
    const proof = page.getByRole('dialog', { name: 'Confirm your identity' });
    await expect(proof).toBeVisible();
    await proof.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expect(
      page.getByText('Password updated. Other sessions have been signed out.'),
    ).toBeVisible();
    await expect(proof).toHaveCount(0);

    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(page.getByText('This session', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out session', exact: true })).toHaveCount(
      1,
    );

    // Switch the virtual device to a new credential while keeping the first in cswatch.
    await page.goto('/account');
    await cdp.send('WebAuthn.removeCredential', {
      authenticatorId,
      credentialId: credentials[0].credentialId,
    });
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
    await nameField.fill('Backup security key');
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await expect(page.getByText('Backup security key', { exact: true })).toBeVisible();
    const backup = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(backup.credentials).toHaveLength(1);
    expect(backup.credentials[0].credentialId).not.toBe(credentials[0].credentialId);
    expect(backup.credentials[0].isResidentCredential).toBe(true);

    const firstName = page.getByText('Virtual security key', { exact: true });
    const backupName = page.getByText('Backup security key', { exact: true });
    const firstKey = page.getByRole('listitem').filter({ has: firstName });
    await expect(backupName).toBeVisible();
    await firstKey.getByRole('button', { name: 'Rename', exact: true }).click();
    const renameField = firstKey.getByLabel('Passkey name', { exact: true });
    await renameField.fill(joinedEmojiName);
    await renameField.press('Enter');
    await expect(renameField).toHaveAccessibleDescription(hiddenNameCharacters);
    await firstKey.getByRole('button', { name: 'Cancel', exact: true }).click();
    const rename = firstKey.getByRole('button', { name: 'Rename', exact: true });
    await expect(rename).toBeFocused();
    await expect(firstKey.getByRole('alert')).toHaveCount(0);
    await rename.press('Enter');
    await expect(renameField).toHaveValue('Virtual security key');
    await expect(renameField).toHaveAttribute('aria-invalid', 'false');
    await expect(renameField).toHaveAccessibleDescription('');

    await renameField.fill('Retired security key');
    await firstKey.getByRole('button', { name: 'Save name', exact: true }).click();
    const retiredName = page.getByText('Retired security key', { exact: true });
    const retiredKey = page.getByRole('listitem').filter({ has: retiredName });
    await expect(retiredName).toBeVisible();
    await expect(firstName).toHaveCount(0);
    await expect(backupName).toBeVisible();
    await retiredKey.getByRole('button', { name: 'Remove passkey', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Remove Retired security key?' })
      .getByRole('button', { name: 'Remove passkey', exact: true })
      .click();
    await expect(retiredName).toHaveCount(0);
    await expect(backupName).toBeVisible();

    await signOut(page, username);
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await expect(page.getByRole('heading', { name: libraryHeading, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: username, exact: true })).toBeVisible();
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  }
});

type PasskeyTestWindow = Window & {
  passkeyTest: {
    elapsed: number;
    createHints: number[];
    getHints: number[];
    hold: boolean;
    late: boolean;
    aborts: number;
  };
};

test('passkey prompts spend elapsed request time and discard a late native assertion', async ({
  page,
  browserName,
}) => {
  requiresVirtualPasskey(browserName);
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  try {
    const username = await registerAccount(page);
    const create = await openPasskeyForm(page, 'Bounded virtual key');
    await page.evaluate(() => {
      const state = {
        elapsed: 0,
        createHints: [] as number[],
        getHints: [] as number[],
        hold: false,
        late: false,
        aborts: 0,
      };
      (window as PasskeyTestWindow).passkeyTest = state;
      const monotonic = performance.now.bind(performance);
      performance.now = () => monotonic() + state.elapsed;
      const credentials = navigator.credentials;
      const create = credentials.create.bind(credentials);
      const get = credentials.get.bind(credentials);
      credentials.create = (options) => {
        state.createHints.push(options?.publicKey?.timeout ?? -1);
        return create(options);
      };
      credentials.get = async (options) => {
        state.getHints.push(options?.publicKey?.timeout ?? -1);
        if (state.hold) {
          options?.signal?.addEventListener('abort', () => state.aborts++, { once: true });
          // Model a native UI that does not settle its promise, even on abort.
          return new Promise(() => {});
        }
        const result = await get(options);
        if (state.late) state.elapsed += 10_000;
        return result;
      };
      // A loaded browser must still make progress if tab storage is denied.
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new DOMException('Disabled for this fixture', 'SecurityError');
        },
      });
    });
    const readings = () => page.evaluate(() => (window as PasskeyTestWindow).passkeyTest);
    const delayOptions = (path: string, elapsed: number, hint: number) =>
      page.route(
        path,
        async (route) => {
          const response = await route.fetch();
          const json = await response.json();
          await page.evaluate((offset) => {
            (window as PasskeyTestWindow).passkeyTest.elapsed += offset;
          }, elapsed);
          if (response.ok()) json.options.timeout = hint;
          await route.fulfill({ response, json });
        },
        { times: 1 },
      );
    const expired = page.getByText(expiredPasskey, { exact: true });
    let confirmations = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/auth/factors/passkeys/confirm')) confirmations++;
    });

    await delayOptions(passkeySetup + 'options', 7_000, 5_000);
    await create.click();
    await expect(expired).toBeVisible();
    expect((await readings()).createHints).toHaveLength(0);

    await delayOptions(passkeySetup + 'options', 2_000, 5_000);
    await delayOptions(passkeySetup + 'verify', 7_000, 5_000);
    await create.click();
    await expect(expired).toBeVisible();
    const afterStaging = await readings();
    expect(afterStaging.createHints).toHaveLength(1);
    expect(afterStaging.createHints[0]).toBeGreaterThan(0);
    expect(afterStaging.createHints[0]).toBeLessThanOrEqual(3_000);
    expect(afterStaging.getHints).toHaveLength(0);
    expect(confirmations).toBe(0);
    await expect(page.getByLabel(newPasskeyName, { exact: true })).toBeHidden();

    await page.evaluate(() => ((window as PasskeyTestWindow).passkeyTest.hold = true));
    await delayOptions(passkeySetup + 'options', 0, 500);
    await create.click();
    await expect(expired).toBeVisible();
    const afterNativeTimeout = await readings();
    expect(afterNativeTimeout.getHints).toHaveLength(1);
    expect(afterNativeTimeout.aborts).toBe(1);
    expect(confirmations).toBe(0);

    await page.evaluate(() => {
      const state = (window as PasskeyTestWindow).passkeyTest;
      state.hold = false;
      state.late = true;
    });
    await delayOptions(passkeySetup + 'options', 2_000, 5_000);
    await create.click();
    await expect(expired).toBeVisible();
    const afterLateAssertion = await readings();
    expect(afterLateAssertion.getHints).toHaveLength(2);
    expect(afterLateAssertion.getHints[1]).toBeGreaterThan(0);
    expect(afterLateAssertion.getHints[1]).toBeLessThanOrEqual(3_000);
    expect(confirmations).toBe(0);

    await page.evaluate(() => ((window as PasskeyTestWindow).passkeyTest.late = false));
    await create.click();
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
    expect(confirmations).toBe(1);
    expect(
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    ).toHaveLength(1);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await signOut(page, username);

    await page.evaluate(() => {
      const now = performance.now.bind(performance);
      let elapsed = 0;
      performance.now = () => now() + elapsed;
      window.addEventListener('passkey-options-delay', () => (elapsed += 7_000));
      navigator.credentials.get = () => {
        throw new Error('An expired sign-in must not open a native prompt');
      };
    });
    await page.route(
      '**/api/auth/passkeys/login/options',
      async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        await page.evaluate(() => window.dispatchEvent(new Event('passkey-options-delay')));
        if (response.ok()) json.options.timeout = 5_000;
        await route.fulfill({ response, json });
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await expect(expired).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  }
});
