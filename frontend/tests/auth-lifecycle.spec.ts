import { chooseSelectOption } from './fixtures/select-control';
import {
  accountStatus,
  configForSyntheticAccount,
  syntheticEmail,
} from './fixtures/account-status';
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  installMemberWorkspace,
  memberAdminData,
  memberConfig,
  memberUser,
} from './fixtures/member-workspace';
import { createHash, randomUUID } from 'node:crypto';

test.beforeEach(async ({ page }) => {
  test.skip(Boolean(process.env.E2E_SETUP));
  await configForSyntheticAccount(page);
  await page.route('**/api/auth/security', (r) =>
    r.fulfill({ json: { passkeys: [], totp: null, recovery_codes_remaining: 0 } }),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function changeRoute(page: Page, path: string) {
  await page.evaluate((destination) => {
    history.pushState({}, '', destination);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

if (!process.env.E2E_EXISTING_SERVER)
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '192.0.2.23' } });

const fixtureUser = {
  id: 'auth-lifecycle-fixture',
  username: 'fixture',
  role: 'member',
  csrf: 'synthetic-auth-lifecycle-csrf',
  identities: [],
};

test('leaving sign-in still refreshes its session without replacing a newer sign-in page or redirecting', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  const response = deferred();
  let authenticated = false,
    attempts = 0;
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: accountStatus(authenticated ? fixtureUser : null) }),
  );
  await page.route('**/api/auth/login', async (route) => {
    attempts++;
    await response.promise;
    authenticated = true;
    await route.fulfill({ json: accountStatus(fixtureUser) });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const form = page.getByRole('form', { name: 'Sign in', exact: true });
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByText('Sign in to your review room.', { exact: true })).toBeVisible();
    await form.getByLabel('Username or email', { exact: true }).fill('fixture');
    await form.getByLabel('Password', { exact: true }).fill('Disposable-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    // An explicit second submit must not create a competing authentication request.
    await form.evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.getByRole('link', { name: 'Go back', exact: true }).click();
    await expect(form).toHaveCount(0);
    await changeRoute(page, '/account');
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await form.getByLabel('Username or email', { exact: true }).fill('new_attempt');
    await expect(form.getByLabel('Username or email', { exact: true })).toHaveCSS(
      'outline-style',
      'solid',
    );
    await expect(form.getByLabel('Username or email', { exact: true })).toHaveCSS(
      'outline-offset',
      '-1px',
    );

    const refreshed = page.waitForResponse(
      async (response) =>
        response.url().endsWith('/api/auth/me') &&
        (await response.json()).user?.id === fixtureUser.id,
    );
    response.resolve();
    await (await refreshed).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await expect(page.getByRole('heading', { name: 'Signed in as fixture' })).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Signed in as fixture' })).toHaveCSS(
      'outline-style',
      'none',
    );
    await expect(form).toHaveCount(0);
    expect(attempts).toBe(1);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Your sign-in username', { exact: true })).toHaveValue('fixture');
  } finally {
    response.resolve();
  }
});

test('an obsolete login cannot overwrite an active attempt after route navigation', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  const first = deferred(),
    second = deferred();
  let authenticated = false,
    attempts = 0;
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: accountStatus(authenticated ? fixtureUser : null) }),
  );
  await page.route('**/api/auth/login', async (route) => {
    attempts++;
    if (attempts === 1) {
      await first.promise;
      authenticated = true;
      await route.fulfill({ json: accountStatus(fixtureUser) });
    } else {
      await second.promise;
      await route.fulfill({ status: 401, json: { detail: 'Invalid username or password.' } });
    }
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const form = page.getByRole('form', { name: 'Sign in', exact: true });
    await form.getByLabel('Username or email', { exact: true }).fill('fixture');
    await form.getByLabel('Password', { exact: true }).fill('Disposable-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);

    await changeRoute(page, '/account');
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await form.getByLabel('Username or email', { exact: true }).fill('new_attempt');
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue('');
    await form.getByLabel('Password', { exact: true }).fill('Disposable-new-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => attempts).toBe(2);
    const refreshed = page.waitForResponse(
      async (response) =>
        response.url().endsWith('/api/auth/me') &&
        (await response.json()).user?.id === fixtureUser.id,
    );
    first.resolve();
    await (await refreshed).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'One moment…', exact: true })).toBeDisabled();
    await expect(form.getByLabel('Username or email', { exact: true })).toHaveValue('new_attempt');

    second.resolve();
    await expect(page.getByRole('alert')).toHaveText('Invalid username or password.');
    await expect(page.getByRole('heading', { name: 'Signed in as fixture' })).toBeFocused();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await page.getByRole('button', { name: 'Continue', exact: true }).press('Enter');
    await expect(page.getByLabel('Your sign-in username', { exact: true })).toHaveValue('fixture');
  } finally {
    first.resolve();
    second.resolve();
  }
});

test('an older session response cannot replace the latest authenticated identity or CSRF', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  const oldRefresh = deferred(),
    oldRefreshStarted = deferred();
  const firstUser = { ...fixtureUser, id: 'auth-first-fixture', username: 'first_fixture' };
  const latestUser = {
    ...fixtureUser,
    id: 'auth-latest-fixture',
    username: 'latest_fixture',
    csrf: 'synthetic-latest-session-csrf',
  };
  let session: typeof fixtureUser | null = null,
    attempts = 0,
    passwordCsrf: string | undefined;
  await page.route('**/api/auth/me', async (route) => {
    const snapshot = session;
    if (snapshot?.id === firstUser.id) {
      oldRefreshStarted.resolve();
      await oldRefresh.promise;
    }
    await route.fulfill({ json: accountStatus(snapshot) });
  });
  await page.route('**/api/auth/login', (route) => {
    session = ++attempts === 1 ? firstUser : latestUser;
    return route.fulfill({ json: accountStatus(session) });
  });
  await page.route('**/api/auth/password', (route) => {
    passwordCsrf = route.request().headers()['x-csrf-token'];
    return route.fulfill({ json: { csrf: latestUser.csrf } });
  });
  await page.route('**/api/demos?*', (route) => route.fulfill({ json: { demos: [], total: 0 } }));
  try {
    await page.goto('/account');
    const form = page.getByRole('form', { name: 'Sign in', exact: true });
    await form.getByLabel('Username or email', { exact: true }).fill(firstUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-first-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await oldRefreshStarted.promise;
    await page.getByRole('link', { name: 'Go back', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await form.getByLabel('Username or email', { exact: true }).fill(latestUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-latest-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(form).toHaveCount(0);
    const account = page.getByRole('button', { name: latestUser.username, exact: true });
    await expect(account).toBeVisible();
    await account.click();
    await page.getByRole('menuitem', { name: 'Account settings', exact: true }).click();
    await expect(page.getByLabel('Your sign-in username', { exact: true })).toHaveValue(
      'latest_fixture',
    );

    const staleResponse = page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/api/auth/me')) return false;
      return (await response.json()).user?.id === firstUser.id;
    });
    oldRefresh.resolve();
    await (await staleResponse).finished();
    // Let the settled fetch continuation commit before checking the next real
    // account action, whose CSRF must still belong to the latest session.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(
      page.getByRole('button', { name: latestUser.username, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: firstUser.username, exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByLabel('Your sign-in username', { exact: true })).toHaveValue(
      'latest_fixture',
    );
    await page.getByLabel('New password', { exact: true }).fill('Disposable-updated-password-2026');
    await page.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect.poll(() => passwordCsrf).toBe(latestUser.csrf);
    await expect(page.getByLabel('Your sign-in username', { exact: true })).toHaveValue(
      'latest_fixture',
    );
  } finally {
    oldRefresh.resolve();
  }
});

test('a late successful login cannot authorize another session while its identity refresh fails', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  const lateLogin = deferred(),
    lateRefresh = deferred();
  const lateUser = {
    ...fixtureUser,
    id: 'auth-late-session',
    username: 'late_fixture',
    csrf: 'synthetic-late-csrf',
  };
  const displayedUser = {
    ...fixtureUser,
    id: 'auth-displayed-session',
    username: 'displayed_fixture',
    csrf: 'synthetic-displayed-csrf',
  };
  let session: typeof fixtureUser | null = null,
    attempts = 0,
    mutationCsrf: string | undefined,
    authorizedMutations = 0;
  await page.route('**/api/auth/me', async (route) => {
    if (session?.id === lateUser.id) {
      await route.abort('failed');
      lateRefresh.resolve();
      return;
    }
    return route.fulfill({ json: accountStatus(session) });
  });
  await page.route('**/api/auth/login', async (route) => {
    if (++attempts === 1) {
      await lateLogin.promise;
      session = lateUser;
    } else session = displayedUser;
    await route.fulfill({ json: accountStatus(session) });
  });
  await page.route('**/api/auth/password', (route) => {
    mutationCsrf = route.request().headers()['x-csrf-token'];
    if (mutationCsrf === session?.csrf) {
      authorizedMutations++;
      return route.fulfill({ json: { csrf: session.csrf } });
    }
    return route.fulfill({ status: 403, json: { detail: 'Invalid CSRF token.' } });
  });
  try {
    await page.goto('/account');
    const form = page.getByRole('form', { name: 'Sign in', exact: true });
    await form.getByLabel('Username or email', { exact: true }).fill(lateUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-late-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    await page.getByRole('link', { name: 'Go back', exact: true }).click();
    await expect(form).toHaveCount(0);
    await changeRoute(page, '/account');
    await form.getByLabel('Username or email', { exact: true }).fill(displayedUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-displayed-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByLabel('Your sign-in username', { exact: true })).toHaveValue(
      'displayed_fixture',
    );
    await expect(form).toHaveCount(0);
    lateLogin.resolve();
    await lateRefresh.promise;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await page.getByLabel('New password', { exact: true }).fill('Disposable-updated-password-2026');
    await page.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect(
      page
        .locator('form')
        .filter({ has: page.getByLabel('New password', { exact: true }) })
        .getByRole('alert'),
    ).toHaveText('Connection lost. Try again.');
    expect(mutationCsrf).toBeUndefined();
    expect(authorizedMutations).toBe(0);
  } finally {
    lateLogin.resolve();
  }
});

const differentUser = {
  ...fixtureUser,
  id: 'auth-lifecycle-different-fixture',
  username: 'other_fixture',
  csrf: 'synthetic-different-session-csrf',
};
const sessionChanged = {
  status: 409,
  headers: { 'X-Session-Changed': '1' },
  json: { detail: 'Session expired. Refresh the page and try again.' },
};

test('configuration stays paired with the session status when the browser changes accounts between requests', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) => {
    expect(route.request().headers()['x-session-context']).toBeUndefined();
    return route.fulfill({ json: accountStatus(session) });
  });
  const contexts: string[] = [];
  let session = fixtureUser;
  await page.route('**/api/config', (route) => {
    const context = route.request().headers()['x-session-context'];
    contexts.push(context);
    if (context === fixtureUser.csrf) {
      session = differentUser;
      return route.fulfill(sessionChanged);
    }
    expect(context).toBe(differentUser.csrf);
    return route.fulfill({ json: memberConfig });
  });
  await page.goto('/account');
  await expect(page.getByLabel('Your sign-in username')).toHaveValue(differentUser.username);
  expect(contexts.slice(0, 2)).toEqual([fixtureUser.csrf, differentUser.csrf]);
  await expect(page.getByRole('button', { name: fixtureUser.username, exact: true })).toHaveCount(
    0,
  );
});

test('a private account read rejects its old browser context and reopens under the current account', async ({
  page,
}) => {
  let session = fixtureUser;
  const contexts: string[] = [];
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(session) }));
  await page.route('**/api/config', (route) =>
    route.fulfill(
      route.request().headers()['x-session-context'] === session.csrf
        ? { json: memberConfig }
        : sessionChanged,
    ),
  );
  await page.route('**/api/auth/sessions', (route) => {
    const context = route.request().headers()['x-session-context'];
    contexts.push(context);
    return route.fulfill(context === session.csrf ? { json: { sessions: [] } } : sessionChanged);
  });
  await page.goto('/account');
  await expect(page.getByLabel('Your sign-in username')).toHaveValue(fixtureUser.username);
  session = differentUser;
  await page.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(
    page.getByRole('button', { name: differentUser.username, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: fixtureUser.username, exact: true })).toHaveCount(
    0,
  );
  await expect.poll(() => contexts).toContain(differentUser.csrf);
  expect(contexts[0]).toBe(fixtureUser.csrf);
});

test('an unbound Steam callback reports the failure and shows which account can continue', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: accountStatus(fixtureUser) }),
  );
  await page.goto('/login?steam=verification-failed');
  await expect(page.getByRole('heading', { name: 'Signed in as fixture' })).toBeVisible();
  await expect(
    page.getByText('Steam could not verify your identity. Try the action again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Sign out to switch accounts', exact: true }),
  ).toBeEnabled();

  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: 'Français', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Connecté avec le compte fixture' }),
  ).toBeVisible();
  const actions = ['Continuer', 'Se déconnecter pour changer de compte'];
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.locator('.auth-utilities .icon-button').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      for (const name of actions) {
        const control = page.getByRole('button', { name, exact: true });
        await expect(control).toBeInViewport();
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
  }
});

test('two tabs share sign-in changes and retire the previous registration receipt', async ({
  page,
  context,
}) => {
  test.skip(
    Boolean(process.env.E2E_SETUP) ||
      Boolean(process.env.E2E_EXISTING_SERVER) ||
      process.env.E2E_REGISTRATIONS === 'false',
    'Uses a fresh Playwright instance with open registrations.',
  );
  const displayName = 'tab_' + randomUUID().slice(0, 8);
  async function register(target: Page) {
    await target.getByLabel('Display name', { exact: true }).fill(displayName);
    await target.getByLabel('Email address', { exact: true }).fill(syntheticEmail());
    await target.getByLabel('Password', { exact: true }).fill('Disposable-tab-password-2026');
    await target.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(
      target.getByRole('heading', { name: 'Save your sign-in name', exact: true }),
    ).toBeVisible();
    return target.getByLabel('Username', { exact: true }).inputValue();
  }
  // Use the actual server and account cookie for both tabs.
  await page.unroute('**/api/config');
  await page.unroute('**/api/auth/security');
  await page.goto('/register?returnTo=%2Faccount');
  await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/login?returnTo=%2Faccount');
  await expect(other.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();

  const previous = await register(page);
  await expect(other.getByRole('heading', { name: 'Signed in as ' + previous })).toBeVisible();
  await other.getByRole('button', { name: 'Sign out to switch accounts' }).click();
  await expect(other.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);

  await other.getByRole('link', { name: 'New here? Create an account', exact: true }).click();
  const current = await register(other);
  expect(current).not.toBe(previous);
  await expect(page.getByRole('heading', { name: 'Signed in as ' + current })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Save your sign-in name' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).press('Enter');
  await expect(page.getByLabel('Your sign-in username')).toHaveValue(current);
});

test('refocusing a private library conceals its rows while the browser identity is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined }),
  );
  await installMemberWorkspace(page);
  await page.goto('/library');
  const row = page.locator('.demo-row:not(.table-head)').first();
  await expect(row).toBeVisible();
  const unavailable = (route: Route) => route.abort('failed');
  await page.route('**/api/auth/me', unavailable);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
  await expect(row).toBeHidden();
  await page.unroute('**/api/auth/me', unavailable);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(row).toBeVisible();
});

test('a library refresh cannot combine rows with the next signed-in account', async ({ page }) => {
  let user = fixtureUser;
  const seen: string[] = [];
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(user) }));
  await page.route('**/api/demos?*', (route) => {
    const context = route.request().headers()['x-session-context'];
    seen.push(context);
    return route.fulfill(
      context === user.csrf ? { json: { demos: [], total: 0 } } : sessionChanged,
    );
  });
  await page.goto('/library');
  await expect(page.getByRole('button', { name: 'Refresh demos' })).toBeEnabled();
  await expect.poll(() => seen).toContain(fixtureUser.csrf);
  user = differentUser;
  await page.getByRole('button', { name: 'Refresh demos' }).click();
  await expect(
    page.getByRole('button', { name: differentUser.username, exact: true }),
  ).toBeVisible();
  await expect.poll(() => seen).toContain(differentUser.csrf);
});

test('logout clears both tabs before follow-up requests finish and can retry failed session reads', async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  const localRead = deferred();
  const peerRead = deferred();
  const release = deferred();
  let signedOut = false;
  let failReads = true;
  let writes = 0;
  for (const tab of [page, other]) {
    await tab.route('**/api/auth/me', async (route) => {
      if (tab === page && signedOut && failReads) {
        localRead.resolve();
        await release.promise;
        return route.abort('failed');
      }
      await route.fulfill({ json: accountStatus(signedOut ? null : fixtureUser) });
    });
    await tab.route('**/api/config', async (route) => {
      if (tab === other && signedOut && failReads) {
        peerRead.resolve();
        await release.promise;
        return route.abort('failed');
      }
      await route.fulfill({ json: memberConfig });
    });
    await tab.route('**/api/auth/security', (route) =>
      route.fulfill({ json: { passkeys: [], totp: null, recovery_codes_remaining: 0 } }),
    );
  }
  await page.route('**/api/auth/logout', (route) => {
    writes++;
    expect(route.request().headers()['x-csrf-token']).toBe(fixtureUser.csrf);
    signedOut = true;
    return route.fulfill({ json: accountStatus(null) });
  });
  try {
    await other.goto('/account');
    await expect(other.getByLabel('Your sign-in username')).toHaveValue(fixtureUser.username);
    await page.goto('/account');
    await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await Promise.all([localRead.promise, peerRead.promise]);
    await expect(page.getByLabel('Your sign-in username')).toHaveCount(0);
    await expect(other.getByLabel('Your sign-in username')).toBeHidden();
    release.resolve();
    for (const tab of [page, other])
      await expect(tab.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
    failReads = false;
    for (const tab of [page, other]) {
      await tab.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(tab.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    }
    expect(writes).toBe(1);
  } finally {
    release.resolve();
    await other.close();
  }
});

test('a logout request rejected for a revoked cookie cannot restore the old account', async ({
  page,
}) => {
  let signedOut = false;
  let configFails = true;
  const writes: string[] = [];
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: accountStatus(signedOut ? null : fixtureUser) }),
  );
  await page.route('**/api/config', (route) =>
    signedOut && configFails ? route.abort('failed') : route.fulfill({ json: memberConfig }),
  );
  await page.route('**/api/auth/logout', (route) => {
    const csrf = route.request().headers()['x-csrf-token'];
    writes.push(csrf);
    if (csrf === accountStatus(null).session.csrf)
      return route.fulfill({ json: accountStatus(null) });
    signedOut = true;
    return route.fulfill({ status: 403, json: { detail: 'Invalid CSRF token.' } });
  });
  await page.goto('/account');
  await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
  expect(writes).toEqual([fixtureUser.csrf, accountStatus(null).session.csrf]);
  await expect(page.getByLabel('Your sign-in username')).toHaveCount(0);
  configFails = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});

test('foreground and peer refreshes wait for the same browser sign-out confirmation', async ({
  page,
}) => {
  const bootstrap = accountStatus<typeof fixtureUser>(null);
  const signedOut = {
    ...bootstrap,
    session: { ...bootstrap.session, csrf: 'synthetic-verified-sign-out' },
  };
  const proofStarted = deferred();
  const release = deferred();
  const writes: string[] = [];
  const configReads: string[] = [];
  let status = accountStatus(fixtureUser);
  let followUpReads = 0;
  await page.route('**/api/auth/me', (route) => {
    if (writes.length) followUpReads++;
    return route.fulfill({ json: status });
  });
  await page.route('**/api/config', (route) => {
    configReads.push(route.request().headers()['x-session-context']);
    return route.fulfill({ json: memberConfig });
  });
  await page.route('**/api/auth/logout', async (route) => {
    const csrf = route.request().headers()['x-csrf-token'];
    writes.push(csrf);
    if (csrf === fixtureUser.csrf) {
      status = bootstrap;
      return route.abort('failed');
    }
    proofStarted.resolve();
    await release.promise;
    status = signedOut;
    return route.fulfill({ json: status });
  });
  try {
    await page.goto('/account');
    await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await proofStarted.promise;
    const readsBeforeRestore = followUpReads;
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await expect.poll(() => followUpReads).toBeGreaterThan(readsBeforeRestore);
    const readsBeforePeer = followUpReads;
    await page.evaluate(() => {
      const peer = new BroadcastChannel('cswatch-session');
      peer.postMessage({ stage: 'anonymous', id: null, enrollment: null });
      peer.close();
    });
    await expect.poll(() => followUpReads).toBeGreaterThan(readsBeforePeer);
    await expect(page.getByLabel('Your sign-in username')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toHaveCount(0);
    expect(configReads).not.toContain(bootstrap.session.csrf);
    expect(writes).toEqual([fixtureUser.csrf, bootstrap.session.csrf]);

    release.resolve();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    expect(configReads).toContain(signedOut.session.csrf);
    expect(writes).toEqual([fixtureUser.csrf, bootstrap.session.csrf]);
  } finally {
    release.resolve();
  }
});

test('an admitted authenticator proof can finish after the ordinary request deadline', async ({
  page,
}) => {
  const pending = accountStatus(null);
  pending.session.stage = 'challenge';
  pending.session.factors = { totp: true, passkey: false, recovery: false };
  const verified = accountStatus(fixtureUser);
  const entered = deferred();
  const deliver = deferred();
  let complete = false;

  await page.clock.install();
  await page.addInitScript(() => {
    AbortSignal.timeout = (ms) => {
      const controller = new AbortController();
      window.setTimeout(() => controller.abort(new DOMException('', 'TimeoutError')), ms);
      return controller.signal;
    };
  });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: complete ? verified : pending }),
  );
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/mfa/totp', async (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe(pending.session.csrf);
    expect(route.request().postDataJSON()).toEqual({ code: '012345' });
    entered.resolve();
    await deliver.promise;
    complete = true;
    await route.fulfill({ json: verified });
  });

  try {
    await page.goto('/login?returnTo=%2Faccount');
    await page.getByLabel('Authenticator code', { exact: true }).fill('012345');
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await entered.promise;
    await page.clock.runFor(25_000);
    await expect(page.getByRole('button', { name: 'Verifying…' })).toBeDisabled();
    deliver.resolve();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByLabel('Your sign-in username')).toHaveValue(fixtureUser.username);
  } finally {
    deliver.resolve();
  }
});

test('authenticator setup conceals its key when activation commits without a response body', async ({
  page,
}) => {
  const initial = accountStatus(fixtureUser);
  initial.session.proof_fresh = false;
  const proven = accountStatus({ ...fixtureUser, csrf: 'synthetic-totp-setup-grant' });
  const enrolled = accountStatus({ ...fixtureUser, csrf: 'synthetic-totp-enrolled-grant' });
  enrolled.session.factors = { totp: true, passkey: false, recovery: true };
  const key = 'JBSWY3DPEHPK3PXP';
  let status = initial;
  let blockRead = false;
  let attempts = 0;
  await page.route('**/api/auth/me', (route) =>
    blockRead ? route.abort('failed') : route.fulfill({ json: status }),
  );
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/security', (route) =>
    route.fulfill({
      json: {
        passkeys: [],
        totp: status === enrolled ? { created_at: 1 } : null,
        recovery_codes_remaining: 0,
      },
    }),
  );
  await page.route('**/api/auth/step-up/password', (route) => {
    status = proven;
    return route.fulfill({ json: status });
  });
  await page.route('**/api/auth/factors/totp/options', (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe(proven.session.csrf);
    return route.fulfill({
      json: {
        enrollment: 'synthetic-totp-enrollment',
        secret: key,
        uri: `otpauth://totp/Fixture?secret=${key}`,
        expires_in_ms: 599_000,
      },
    });
  });
  await page.route('**/api/auth/factors/totp/verify', (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe(proven.session.csrf);
    attempts++;
    if (attempts === 1)
      return route.fulfill({ status: 400, json: { detail: 'Incorrect authenticator code.' } });
    status = enrolled;
    blockRead = true;
    return route.abort('failed');
  });
  await page.goto('/account');
  const authenticator = page.getByRole('region', { name: 'Authenticator app' });
  await authenticator.getByRole('button', { name: 'Set up authenticator' }).click();
  const proof = page.getByRole('dialog', { name: 'Confirm your identity' });
  await proof.getByLabel('Current password').fill('Synthetic-step-up-password');
  await proof.getByRole('button', { name: 'Verify', exact: true }).click();
  const secret = authenticator.getByLabel('Setup key');
  const qr = authenticator.getByRole('img', { name: 'Authenticator setup QR code' });
  const code = authenticator.getByLabel('Authenticator code', { exact: true });
  const activate = authenticator.getByRole('button', { name: 'Activate authenticator' });
  await expect(secret).toHaveValue(key);
  await expect(qr).toBeVisible();
  await code.fill('012345');
  await activate.click();
  await expect(authenticator.getByRole('alert')).toHaveText('Incorrect authenticator code.');
  await expect(secret).toHaveValue(key);
  await code.fill('098765');
  await activate.click();
  const retry = authenticator.getByRole('button', { name: 'Try again', exact: true });
  await expect(retry).toBeEnabled();
  await expect(secret).toHaveCount(0);
  await expect(qr).toHaveCount(0);
  await expect(authenticator.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
  blockRead = false;
  await retry.click();
  await expect(authenticator.getByRole('button', { name: 'Remove authenticator' })).toBeVisible();
  await expect(secret).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('recovery codes stay private until both step-up and issuance rotations verify', async ({
  page,
}) => {
  const initial = accountStatus(fixtureUser);
  initial.session.proof_fresh = false;
  initial.session.factors = { totp: true, passkey: false, recovery: true };
  const proven = accountStatus({ ...fixtureUser, csrf: 'synthetic-recovery-step-up' });
  const issued = accountStatus({ ...fixtureUser, csrf: 'synthetic-recovery-issued' });
  const code = 'synthetic-rotation-backup-code';
  const validating = deferred();
  const resume = deferred();
  let status = initial;
  let writes = 0;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.copiedRecovery = value;
        },
      },
    });
  });
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
  await page.route('**/api/config', async (route) => {
    if (route.request().headers()['x-session-context'] === issued.session.csrf) {
      validating.resolve();
      await resume.promise;
    }
    await route.fulfill({ json: memberConfig });
  });
  await page.route('**/api/auth/security', (route) =>
    route.fulfill({ json: { passkeys: [], totp: { created_at: 1 }, recovery_codes_remaining: 0 } }),
  );
  await page.route('**/api/auth/step-up/totp', (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe(initial.session.csrf);
    status = proven;
    return route.fulfill({ json: status });
  });
  await page.route('**/api/auth/factors/recovery/regenerate', (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe(proven.session.csrf);
    status = issued;
    writes++;
    return route.fulfill({ json: { ...status, recovery_codes: [code] } });
  });
  try {
    await page.goto('/account');
    await page.getByRole('button', { name: 'Generate recovery codes' }).click();
    const proof = page.getByRole('dialog', { name: 'Confirm your identity' });
    await proof.getByLabel('Authenticator code', { exact: true }).fill('012345');
    await proof.getByRole('button', { name: 'Verify', exact: true }).click();
    await validating.promise;
    await expect(page.getByText(code, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Recovery codes', { exact: true })).toHaveCount(0);
    resume.resolve();
    const backup = page.getByRole('region', { name: 'Save your recovery codes' });
    await expect(backup.getByText(code, { exact: true })).toBeVisible();
    await backup.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-copied-recovery', code);
    expect(writes).toBe(1);
  } finally {
    resume.resolve();
  }
});

for (const olderCodes of [['synthetic-older-backup-code'], undefined]) {
  test(`a delayed factor response ${olderCodes ? 'with' : 'without'} codes preserves a newer backup code receipt`, async ({
    page,
  }) => {
    const initial = accountStatus(fixtureUser);
    initial.session.factors = { passkey: !olderCodes, totp: false, recovery: !olderCodes };
    if (!olderCodes) initial.session.proof_kind = 'passkey';
    const added = accountStatus({ ...fixtureUser, csrf: 'synthetic-delayed-factor-grant' });
    const issued = accountStatus({ ...fixtureUser, csrf: 'synthetic-newer-code-grant' });
    const factors = { passkey: !olderCodes, totp: true, recovery: true };
    added.session.factors = factors;
    issued.session.factors = factors;
    const newerCode = 'synthetic-newer-backup-code';
    const key = 'JBSWY3DPEHPK3PXP';
    const activated = deferred();
    const deliver = deferred();
    let status = initial;
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
    await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
    await page.route('**/api/auth/security', (route) =>
      route.fulfill({
        json: {
          passkeys: olderCodes
            ? []
            : [
                {
                  id: 'synthetic-passkey',
                  name: 'Saved device',
                  created_at: 1,
                  last_used_at: null,
                  device_type: 'singleDevice',
                  backed_up: false,
                },
              ],
          totp: status === initial ? null : { created_at: 1 },
          recovery_codes_remaining: status === initial && olderCodes ? 0 : 10,
        },
      }),
    );
    await page.route('**/api/auth/factors/totp/options', (route) =>
      route.fulfill({
        json: {
          enrollment: 'synthetic-delayed-enrollment',
          secret: key,
          uri: `otpauth://totp/Fixture?secret=${key}`,
          expires_in_ms: 299_000,
        },
      }),
    );
    await page.route('**/api/auth/factors/totp/verify', async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(initial.session.csrf);
      status = added;
      activated.resolve();
      await deliver.promise;
      await route.fulfill({ json: { ...added, recovery_codes: olderCodes } });
    });
    await page.route('**/api/auth/factors/recovery/regenerate', (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(added.session.csrf);
      status = issued;
      return route.fulfill({ json: { ...issued, recovery_codes: [newerCode] } });
    });
    try {
      await page.goto('/account');
      const authenticator = page.getByRole('region', { name: 'Authenticator app' });
      await authenticator.getByRole('button', { name: 'Set up authenticator' }).click();
      await authenticator.getByLabel('Authenticator code').fill('012345');
      await authenticator.getByRole('button', { name: 'Activate authenticator' }).click();
      await activated.promise;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(
        authenticator.getByRole('button', { name: 'Remove authenticator' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Generate recovery codes' }).click();
      await page
        .getByRole('dialog', { name: 'Replace your recovery codes?' })
        .getByRole('button', { name: 'Generate recovery codes' })
        .click();
      const receipt = page.getByRole('region', { name: 'Save your recovery codes' });
      await expect(receipt.getByLabel('Recovery codes')).toHaveValue(newerCode);
      const reconciled = page.waitForResponse((response) =>
        response.url().endsWith('/api/auth/me'),
      );
      deliver.resolve();
      await reconciled;
      await expect(receipt.getByLabel('Recovery codes')).toHaveValue(newerCode);
      await expect(receipt.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
    } finally {
      deliver.resolve();
    }
  });
}

test('a verified same-account rotation retires a recovery code receipt', async ({ page }) => {
  let status = accountStatus(fixtureUser);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
  let blockConfig = false;
  await page.route('**/api/config', (route) =>
    blockConfig ? route.abort('failed') : route.fulfill({ json: memberConfig }),
  );
  await page.route('**/api/auth/security', (route) =>
    route.fulfill({ json: { passkeys: [], totp: { created_at: 1 }, recovery_codes_remaining: 0 } }),
  );
  await page.route('**/api/auth/factors/recovery/regenerate', (route) => {
    status = accountStatus({ ...fixtureUser, csrf: 'synthetic-issued-scope' });
    return route.fulfill({ json: { ...status, recovery_codes: ['synthetic-backup-code'] } });
  });
  await page.goto('/account');
  await changeRoute(page, '/%61ccount');
  await page.getByRole('button', { name: 'Generate recovery codes' }).click();
  await expect(page.getByText('synthetic-backup-code', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  status = accountStatus({ ...fixtureUser, csrf: 'synthetic-replaced-scope' });
  blockConfig = true;
  await page.evaluate(() => {
    const peer = new BroadcastChannel('cswatch-session');
    peer.postMessage({
      id: 'auth-lifecycle-fixture',
      role: 'member',
      enrollment: null,
      stage: 'full',
    });
    peer.close();
  });
  await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
  await expect(page.getByText('synthetic-backup-code', { exact: true })).toBeHidden();
  blockConfig = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText(/Your security session changed/)).toBeVisible();
  await expect(page.getByText('synthetic-backup-code', { exact: true })).toHaveCount(0);
});

test('a sign-out response installs its browser grant before a peer allocates recovery context', async ({
  page,
  context,
}) => {
  const peer = await context.newPage();
  const entered = deferred();
  const release = deferred();
  let closing = false;
  let delivered = false;
  let allocations = 0;
  await context.route('**/api/auth/me', (route) => {
    if (closing && !delivered && route.request().headers()['x-browser-session-probe'] === '1')
      return route.fulfill({ status: 204, headers: { 'X-Browser-Bootstrap-Required': '1' } });
    if (!route.request().headers()['x-browser-session-probe']) allocations++;
    return route.fulfill({ json: closing ? accountStatus(null) : accountStatus(fixtureUser) });
  });
  await context.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await context.route('**/api/auth/recover/status', (route) =>
    route.fulfill({ json: { claim_id: null } }),
  );
  await page.route('**/api/auth/logout', async (route) => {
    closing = true;
    entered.resolve();
    await release.promise;
    delivered = true;
    await route.fulfill({ json: accountStatus(null) });
  });
  await peer.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === 'cswatch-browser-session' && args[1] === 'readwrite')
        document.documentElement.dataset.waitingForSessionWriter = 'true';
      return transaction.apply(this, args);
    };
  });
  try {
    await page.goto('/account');
    await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await entered.promise;
    await peer.goto('/recover');
    await expect(peer.locator('html')).toHaveAttribute('data-waiting-for-session-writer', 'true');
    expect(allocations).toBe(0);
    release.resolve();
    await expect(peer.getByLabel('Password reset code')).toBeVisible();
    expect(allocations).toBe(1);
  } finally {
    release.resolve();
    await peer.close();
  }
});

test('a browser without IndexedDB can revoke its account without publishing an unordered cookie', async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  let signedOut = false;
  const status = () => (signedOut ? accountStatus(null) : accountStatus(fixtureUser));
  await page.route('**/api/auth/me', (route) =>
    signedOut
      ? route.fulfill({ status: 204, headers: { 'X-Browser-Bootstrap-Required': '1' } })
      : route.fulfill({ json: status() }),
  );
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/logout', (route) => {
    expect(route.request().headers()['x-omit-anonymous-cookie']).toBe('1');
    signedOut = true;
    return route.fulfill({ json: status() });
  });
  await page.goto('/account');
  await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Browser storage unavailable', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: fixtureUser.username, exact: true })).toHaveCount(
    0,
  );
  expect(signedOut).toBe(true);
});

test('a stalled sign-out write releases a verified replacement account at its deadline', async ({
  page,
}) => {
  let status = accountStatus(fixtureUser);
  let writes = 0;
  const entered = deferred();
  const release = deferred();
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/logout', async (route) => {
    writes++;
    entered.resolve();
    await release.promise;
    await route.abort('failed');
  });
  try {
    await page.goto('/account');
    await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
    await page.evaluate(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (ms) => timeout(Math.min(ms, 750));
    });
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await entered.promise;
    status = accountStatus(differentUser);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await expect(page.getByLabel('Your sign-in username')).toHaveValue(differentUser.username);
    expect(writes).toBe(1);
  } finally {
    release.resolve();
  }
});

test('verifying an ambiguous logout leaves a newly signed-in account intact', async ({ page }) => {
  const bootstrap = accountStatus<typeof fixtureUser>(null);
  const proofStarted = deferred();
  const release = deferred();
  let status = accountStatus(fixtureUser);
  const writes: string[] = [];
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
  await page.route('**/api/config', (route) =>
    route.fulfill(
      route.request().headers()['x-session-context'] === status.session.csrf
        ? { json: memberConfig }
        : sessionChanged,
    ),
  );
  await page.route('**/api/auth/logout', async (route) => {
    const csrf = route.request().headers()['x-csrf-token'];
    writes.push(csrf);
    if (csrf === fixtureUser.csrf) {
      status = bootstrap;
      return route.abort('failed');
    }
    if (csrf === differentUser.csrf) {
      status = bootstrap;
      return route.fulfill({ json: status });
    }
    proofStarted.resolve();
    await release.promise;
    return route.fulfill({ status: 403, json: { detail: 'Invalid CSRF token.' } });
  });
  try {
    await page.goto('/account');
    await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await proofStarted.promise;
    const cancelled = page.waitForEvent(
      'requestfailed',
      (request) =>
        request.url().endsWith('/api/auth/logout') &&
        request.headers()['x-csrf-token'] === bootstrap.session.csrf,
    );
    status = accountStatus(differentUser);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    const username = page.getByLabel('Your sign-in username');
    await expect(username).toHaveValue(differentUser.username);
    await cancelled;
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toHaveCount(0);
    await expect(page.getByText('Connection lost. Try again.')).toHaveCount(0);

    // The replacement session can act while the stale proof response is held.
    await page.getByRole('button', { name: differentUser.username, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    expect(writes).toEqual([fixtureUser.csrf, bootstrap.session.csrf, differentUser.csrf]);
  } finally {
    release.resolve();
  }
});

for (const stage of ['challenge', 'enroll'] as const)
  test(
    'recovery link offers sign-out and scrubs its fragment during ' + stage,
    async ({ page }) => {
      const session = accountStatus(null);
      await page.route('**/api/auth/me', (route) =>
        route.fulfill({
          json: {
            ...session,
            session: { ...session.session, stage, username: fixtureUser.username },
          },
        }),
      );
      await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
      await page.goto('/recover#' + 'b'.repeat(64));
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/recover$/);
    },
  );

test('a recovery fragment is discarded when the user leaves before using its sign-out button', async ({
  page,
}) => {
  const fixtureCode = 'a'.repeat(64);
  let session: typeof fixtureUser | null = fixtureUser;
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(session) }));
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/logout', (route) => {
    session = null;
    return route.fulfill({ json: accountStatus(session) });
  });
  await page.route('**/api/auth/recover/status', (route) =>
    route.fulfill({ json: { claim_id: null } }),
  );
  await page.goto('/recover#' + fixtureCode);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/recover$/);
  await changeRoute(page, '/account');
  await expect(page.getByLabel('Your sign-in username')).toHaveValue(fixtureUser.username);
  await changeRoute(page, '/recover');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Password reset code')).toHaveValue('');
});

test('a lost recovery sign-out response discards the code before showing another anonymous session', async ({
  page,
}) => {
  let signedIn = true;
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: accountStatus(signedIn ? fixtureUser : null) }),
  );
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/logout', (route) => {
    if (!signedIn) return route.fulfill({ json: accountStatus(null) });
    signedIn = false;
    return route.abort('failed');
  });
  await page.route('**/api/auth/recover/status', (route) =>
    route.fulfill({ json: { claim_id: null } }),
  );
  await page.goto('/recover#' + 'c'.repeat(64));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Password reset code')).toHaveValue('');
});

for (const outcome of ['replacement', 'lost claim response', 'same-grant renewal'] as const) {
  test(`recovery retains its submitted grant through ${outcome}`, async ({ page }) => {
    const code = 'd'.repeat(64);
    const anonymous = accountStatus(null);
    const first = {
      ...anonymous,
      session: { ...anonymous.session, anonymous_id: 'recovery-grant-a', csrf: 'recovery-csrf-a' },
    };
    const next = {
      ...anonymous,
      session: {
        ...anonymous.session,
        anonymous_id:
          outcome === 'same-grant renewal' ? first.session.anonymous_id : 'recovery-grant-b',
        csrf: 'recovery-csrf-b',
      },
    };
    let status: ReturnType<typeof accountStatus> = accountStatus(fixtureUser);
    let committed = false;
    const claimId = 'f'.repeat(32);
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    const receipt = sha256('cswatch/recovery-attempt/v1:' + sha256(code));
    const writes: string[] = [];
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
    await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
    await page.route('**/api/auth/logout', (route) => {
      status = first;
      return route.fulfill({ json: status });
    });
    await page.route('**/api/auth/recover/status', (route) => {
      const headers = route.request().headers();
      const matches =
        committed &&
        headers['x-session-context'] === next.session.csrf &&
        (headers['x-recovery-attempt'] === receipt || headers['x-recovery-claim'] === claimId);
      return route.fulfill({
        json: matches ? { claim_id: claimId, recovery_expires_in_ms: 599_000 } : { claim_id: null },
      });
    });
    await page.route('**/api/auth/recover/claim', (route) => {
      const csrf = route.request().headers()['x-csrf-token'];
      writes.push(csrf);
      expect(route.request().postDataJSON()).toEqual({ code });
      status = next;
      if (outcome === 'same-grant renewal' && csrf === next.session.csrf) {
        committed = true;
        return route.fulfill({ json: { claim_id: claimId, recovery_expires_in_ms: 599_000 } });
      }
      if (outcome !== 'lost claim response') return route.fulfill({ status: 403, json: {} });
      committed = true;
      return route.abort('failed');
    });
    await page.goto('/recover#' + code);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    const input = page.getByLabel('Password reset code');
    await expect(input).toHaveValue(code);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    if (outcome === 'replacement') {
      await expect(input).toHaveValue('');
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toHaveCount(0);
    } else {
      if (outcome === 'same-grant renewal') {
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(input).toHaveValue(code);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      }
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    }
    expect(writes).toEqual(
      outcome === 'same-grant renewal'
        ? [first.session.csrf, next.session.csrf]
        : [first.session.csrf],
    );
  });
}

async function openSavedRecovery(page: Page, claimId: string) {
  await page.goto('/recover');
  await expect(page.getByLabel('Password reset code', { exact: true })).toBeVisible();
  await page.evaluate(
    (id) => history.replaceState({ ...history.state, recoveryClaim: id }, ''),
    claimId,
  );
  await page.reload();
}

for (const [outcome, description] of [
  [
    'verified',
    'successful recovery verifies the saved completion receipt after an interrupted status read',
  ],
  [
    'replacement',
    'late recovery completion does not disclose the username after an account replacement',
  ],
  ['lost', 'a lost reset completion retries a timed-out receipt read without resetting again'],
] as const) {
  test(description, async ({ page }) => {
    const replaceAccount = outcome === 'replacement';
    const lostCompletion = outcome === 'lost';
    await page.addInitScript(() =>
      Object.defineProperty(window, 'BroadcastChannel', { value: undefined }),
    );
    const anonymous = accountStatus(null);
    const replacement = accountStatus(differentUser);
    const claimId = 'f'.repeat(32);
    const username = 'recovery_completion_fixture';
    const completionStarted = deferred();
    const releaseCompletion = deferred();
    const releaseReceipt = deferred();
    let committed = false;
    let unavailable = false;
    let status: ReturnType<typeof accountStatus> = anonymous;
    let receiptReads = 0;
    let completions = 0;
    await page.route('**/api/auth/me', (route) =>
      unavailable ? route.abort('failed') : route.fulfill({ json: status }),
    );
    await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
    await page.route('**/api/auth/recover/status', async (route) => {
      const headers = route.request().headers();
      const matches =
        status.session.stage === 'anonymous' &&
        headers['x-session-context'] === status.session.csrf &&
        headers['x-recovery-claim'] === claimId;
      if (committed && ++receiptReads === 1 && lostCompletion) {
        await releaseReceipt.promise;
        return route.abort('failed').catch(() => {});
      }
      return route.fulfill({
        json:
          matches && committed
            ? { claim_id: null, username, recovery_expires_in_ms: 599_000 }
            : matches
              ? { claim_id: claimId, recovery_expires_in_ms: 599_000 }
              : { claim_id: null },
      });
    });
    await page.route('**/api/auth/recover/complete', async (route) => {
      completions++;
      expect(route.request().postDataJSON().claim_id).toBe(claimId);
      committed = true;
      completionStarted.resolve();
      await releaseCompletion.promise;
      if (lostCompletion) return route.abort('failed');
      await route.fulfill({ json: { ok: true, username } });
    });
    try {
      await openSavedRecovery(page, claimId);
      await page
        .getByLabel('New password', { exact: true })
        .fill('Disposable-recovery-password-2026');
      if (lostCompletion)
        await page.evaluate(() => {
          const timeout = AbortSignal.timeout.bind(AbortSignal);
          AbortSignal.timeout = (ms) => timeout(ms === 15_000 ? 1_500 : ms);
        });
      await page.getByRole('button', { name: 'Reset password', exact: true }).click();
      await completionStarted.promise;
      status = replaceAccount ? replacement : anonymous;
      unavailable = !lostCompletion;
      releaseCompletion.resolve();
      const assigned = page.getByLabel('Your sign-in username', { exact: true });
      if (lostCompletion)
        await expect(
          page.getByText('Checking for a password reset…', { exact: true }),
        ).toBeVisible();
      await expect(page.getByRole('alert')).toHaveText('Connection lost. Try again.');
      await expect(assigned).toHaveCount(0);
      const interruptedReads = lostCompletion ? 1 : 0;
      expect(receiptReads).toBe(interruptedReads);

      unavailable = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      if (replaceAccount) {
        await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
        await expect(assigned).toHaveCount(0);
        expect(receiptReads).toBe(0);
      } else {
        await expect(assigned).toHaveValue(username);
        expect(receiptReads).toBe(interruptedReads + 1);
        await page.reload();
        await expect(assigned).toHaveValue(username);
        expect(receiptReads).toBe(interruptedReads + 2);
      }
      expect(completions).toBe(1);
    } finally {
      releaseCompletion.resolve();
      releaseReceipt.resolve();
    }
  });
}

test('a pending recovery form expires from the claim request start', async ({ page }) => {
  const claimId = 'a'.repeat(32);
  const code = 'b'.repeat(64);
  const submitted = deferred();
  const releaseClaim = deferred();
  const future = Date.now() + 15 * 60_000;
  await page.clock.install({ time: future });
  await page.clock.pauseAt(future + 60_000);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(null) }));
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/recover/claim', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ code });
    submitted.resolve();
    await releaseClaim.promise;
    await route.fulfill({ json: { claim_id: claimId, recovery_expires_in_ms: 5_000 } });
  });
  let receiptReads = 0;
  await page.route('**/api/auth/recover/status', (route) => {
    if (route.request().headers()['x-recovery-claim'] !== claimId)
      return route.fulfill({ json: { claim_id: null } });
    receiptReads++;
    return route.fulfill({ json: { claim_id: claimId, recovery_expires_in_ms: 5_000 } });
  });
  try {
    await page.goto('/recover#' + code);
    const resetCode = page.getByLabel('Password reset code', { exact: true });
    const password = page.getByLabel('New password', { exact: true });
    await expect(resetCode).toHaveValue(code);
    await resetCode.press('Enter');
    await submitted.promise;
    await page.clock.runFor(3_000);
    releaseClaim.resolve();
    await expect(password).toBeVisible();
    await password.fill('Disposable-recovery-password-2026');
    await page.clock.runFor(2_001);
    await expect(password).toHaveCount(0);
    await expect(resetCode).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveText(
      'This password reset is no longer available. Enter a new reset code.',
    );
    expect(receiptReads).toBe(1);
  } finally {
    releaseClaim.resolve();
  }
});

for (const reissued of [false, true]) {
  test(`foreground checking ${reissued ? 'retires a reissued' : 'restores the same'} recovery form`, async ({
    page,
  }) => {
    const claimId = 'c'.repeat(32);
    const password = 'Disposable-recovery-password-2026';
    const anonymous = accountStatus(null);
    const configurationRead = deferred();
    const releaseConfiguration = deferred();
    const receiptRead = deferred();
    const releaseReceipt = deferred();
    let rechecking = false;
    let receiptReads = 0;
    let completions = 0;
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: anonymous }));
    await page.route('**/api/config', async (route) => {
      if (rechecking) {
        configurationRead.resolve();
        await releaseConfiguration.promise;
      }
      await route.fulfill({ json: memberConfig });
    });
    await page.route('**/api/auth/recover/status', async (route) => {
      const headers = route.request().headers();
      if (headers['x-recovery-claim'] !== claimId)
        return route.fulfill({ json: { claim_id: null } });
      expect(headers['x-session-context']).toBe(anonymous.session.csrf);
      receiptReads++;
      if (rechecking) {
        receiptRead.resolve();
        await releaseReceipt.promise;
      }
      await route.fulfill({
        json:
          rechecking && reissued
            ? { claim_id: null }
            : { claim_id: claimId, recovery_expires_in_ms: 599_000 },
      });
    });
    await page.route('**/api/auth/recover/complete', (route) => {
      completions++;
      return route.abort('failed');
    });
    try {
      await openSavedRecovery(page, claimId);
      const field = page.getByLabel('New password', { exact: true });
      await field.fill(password);
      rechecking = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await configurationRead.promise;
      await expect(field).toBeHidden();
      expect(receiptReads).toBe(1);
      releaseConfiguration.resolve();
      await receiptRead.promise;
      await expect(page.getByText('Checking for a password reset…', { exact: true })).toBeVisible();
      await expect(field).toBeHidden();
      releaseReceipt.resolve();
      if (reissued) {
        await expect(field).toHaveCount(0);
        await expect(page.getByLabel('Password reset code', { exact: true })).toHaveValue('');
        await expect(page.getByRole('alert')).toHaveText(
          'This password reset is no longer available. Enter a new reset code.',
        );
      } else {
        await expect(field).toBeVisible();
        await expect(field).toHaveValue(password);
      }
      expect(receiptReads).toBe(2);
      expect(completions).toBe(0);
    } finally {
      releaseConfiguration.resolve();
      releaseReceipt.resolve();
    }
  });
}

test('the completed recovery username expires from the receipt request start', async ({ page }) => {
  const claimId = 'e'.repeat(32);
  const username = 'expiring_recovery_fixture';
  const receiptRead = deferred();
  const release = deferred();
  const future = Date.now() + 15 * 60_000;
  await page.clock.install({ time: future });
  await page.clock.pauseAt(future + 60_000);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(null) }));
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/recover/status', async (route) => {
    if (route.request().headers()['x-recovery-claim'] !== claimId)
      return route.fulfill({ json: { claim_id: null } });
    receiptRead.resolve();
    await release.promise;
    await route.fulfill({ json: { claim_id: null, username, recovery_expires_in_ms: 5_000 } });
  });
  try {
    await openSavedRecovery(page, claimId);
    await receiptRead.promise;
    await page.clock.runFor(3_000);
    release.resolve();
    const assigned = page.getByLabel('Your sign-in username', { exact: true });
    await expect(assigned).toHaveValue(username);
    await page.clock.runFor(2_001);
    await expect(assigned).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Password reset code', { exact: true })).toBeVisible();
  } finally {
    release.resolve();
  }
});

test('refocusing the same anonymous grant retires a reissued recovery receipt', async ({
  page,
}) => {
  const claimId = 'e'.repeat(32);
  const username = 'reissued_recovery_fixture';
  const configurationRead = deferred();
  const releaseConfiguration = deferred();
  const receiptRead = deferred();
  const releaseReceipt = deferred();
  const anonymous = accountStatus(null);
  let reissued = false;
  let receiptReads = 0;
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: anonymous }));
  await page.route('**/api/config', async (route) => {
    if (reissued) {
      configurationRead.resolve();
      await releaseConfiguration.promise;
    }
    await route.fulfill({ json: memberConfig });
  });
  await page.route('**/api/auth/recover/status', async (route) => {
    const headers = route.request().headers();
    if (headers['x-recovery-claim'] !== claimId) return route.fulfill({ json: { claim_id: null } });
    expect(headers['x-session-context']).toBe(anonymous.session.csrf);
    receiptReads++;
    if (reissued) {
      receiptRead.resolve();
      await releaseReceipt.promise;
      return route.fulfill({ json: { claim_id: null } });
    }
    await route.fulfill({ json: { claim_id: null, username, recovery_expires_in_ms: 599_000 } });
  });
  try {
    await openSavedRecovery(page, claimId);
    const assigned = page.getByLabel('Your sign-in username', { exact: true });
    await expect(assigned).toHaveValue(username);
    reissued = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await configurationRead.promise;
    await expect(assigned).toHaveCount(0);
    expect(receiptReads).toBe(1);
    releaseConfiguration.resolve();
    await receiptRead.promise;
    await expect(page.getByText('Checking for a password reset…', { exact: true })).toBeVisible();
    await expect(assigned).toHaveCount(0);
    releaseReceipt.resolve();
    await expect(page.getByLabel('Password reset code', { exact: true })).toBeVisible();
    await expect(assigned).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
    expect(receiptReads).toBe(2);
  } finally {
    releaseConfiguration.resolve();
    releaseReceipt.resolve();
  }
});

test('restored tabs without a broadcast channel conceal the workspace and preserve a same-account form', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined }),
  );
  const sessionRead = deferred();
  const release = deferred();
  let user: typeof fixtureUser | null = fixtureUser;
  let mode: 'available' | 'failed' = 'available';
  await page.route('**/api/auth/me', async (route) => {
    if (mode === 'failed') {
      sessionRead.resolve();
      await release.promise;
      return route.abort('failed');
    }
    await route.fulfill({ json: accountStatus(user) });
  });
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  try {
    await page.goto('/account');
    const password = page.getByLabel('New password', { exact: true });
    await password.fill('Disposable-edited-credential-2026');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(password).toHaveValue('Disposable-edited-credential-2026');

    mode = 'failed';
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', {
          persisted: true,
        }),
      ),
    );
    await sessionRead.promise;
    await expect(password).toBeHidden();
    release.resolve();
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
    await expect(password).toBeHidden();

    mode = 'available';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(password).toBeVisible();
    await expect(password).toHaveValue('Disposable-edited-credential-2026');

    user = null;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(password).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

const currentDevice = {
  id: 'c'.repeat(32),
  device: 'Fixture browser',
  address: null,
  created_at: 1_700_000_000,
  last_used_at: 1_700_000_000,
  expires_at: 1_900_000_000,
  current: true,
};

test('restored tabs close private confirmation and floating menu layers so Retry can receive focus', async ({
  page,
}) => {
  let fail = false;
  await page.route('**/api/auth/me', (route) =>
    fail ? route.abort('failed') : route.fulfill({ json: accountStatus(fixtureUser) }),
  );
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/sessions', (route) =>
    route.fulfill({ json: { sessions: [currentDevice] } }),
  );
  await page.goto('/account/sessions');
  const revoke = page.getByRole('button', { name: 'Sign out session', exact: true });
  await revoke.click();
  await expect(page.getByRole('dialog', { name: 'Sign out this session?' })).toBeVisible();

  async function failRestoration() {
    fail = true;
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('.member-floating')).toHaveCount(0);
    fail = false;
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(revoke).toBeVisible();
  }
  await failRestoration();

  await page.getByRole('button', { name: fixtureUser.username, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
  await failRestoration();

  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Français', exact: true })).toBeVisible();
  await failRestoration();
});

for (const everywhere of [false, true]) {
  test(`the device action ${everywhere ? 'for all sessions' : 'for this session'} retires both tabs even if status is unavailable`, async ({
    page,
    context,
  }) => {
    const other = await context.newPage();
    let ended = false;
    let unavailable = true;
    let writes = 0;
    try {
      for (const tab of [page, other]) {
        await tab.route('**/api/auth/me', (route) =>
          ended && unavailable
            ? route.abort('failed')
            : route.fulfill({ json: accountStatus(ended ? null : fixtureUser) }),
        );
        await tab.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
        await tab.route('**/api/auth/sessions', (route) =>
          route.fulfill({ json: { sessions: [currentDevice] } }),
        );
      }
      const path = everywhere ? 'revoke-all' : currentDevice.id;
      await page.route('**/api/auth/sessions/' + path, (route) => {
        expect(route.request().method()).toBe(everywhere ? 'POST' : 'DELETE');
        expect(route.request().headers()['x-csrf-token']).toBe(fixtureUser.csrf);
        writes++;
        ended = true;
        return route.fulfill({ json: accountStatus(null) });
      });
      await other.goto('/account/sessions');
      const device = other.getByText(currentDevice.device, { exact: true });
      await expect(device).toBeVisible();
      await page.goto('/account/sessions');
      const action = everywhere ? 'Sign out everywhere' : 'Sign out session';
      await page.getByRole('button', { name: action, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
      for (const tab of [page, other])
        await expect(tab.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
      await expect(page.getByText(currentDevice.device, { exact: true })).toHaveCount(0);
      await expect(device).toBeHidden();
      expect(writes).toBe(1);

      unavailable = false;
      for (const tab of [page, other]) {
        await tab.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(tab.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      }
    } finally {
      await other.close();
    }
  });

  test(`an ambiguous ${everywhere ? 'all-device' : 'current-device'} request confirms only the browser sign-out across retries`, async ({
    page,
  }) => {
    const bootstrap = accountStatus<typeof fixtureUser>(null);
    const signedOut = {
      ...bootstrap,
      session: { ...bootstrap.session, csrf: 'synthetic-verified-device-sign-out' },
    };
    let status = accountStatus(fixtureUser);
    let proofAvailable = false;
    let configAvailable = false;
    let mutations = 0;
    const proofContexts: string[] = [];
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
    await page.route('**/api/config', (route) => {
      expect(route.request().headers()['x-session-context']).toBe(status.session.csrf);
      return status === signedOut && !configAvailable
        ? route.abort('failed')
        : route.fulfill({ json: memberConfig });
    });
    await page.route('**/api/auth/sessions', (route) =>
      route.fulfill({ json: { sessions: [currentDevice] } }),
    );
    const path = everywhere ? 'revoke-all' : currentDevice.id;
    await page.route('**/api/auth/sessions/' + path, (route) => {
      mutations++;
      expect(route.request().method()).toBe(everywhere ? 'POST' : 'DELETE');
      expect(route.request().headers()['x-csrf-token']).toBe(fixtureUser.csrf);
      status = bootstrap;
      return route.abort('failed');
    });
    await page.route('**/api/auth/logout', (route) => {
      proofContexts.push(route.request().headers()['x-csrf-token']);
      if (!proofAvailable) return route.abort('failed');
      status = signedOut;
      return route.fulfill({ json: status });
    });
    await page.goto('/account/sessions');
    const device = page.getByText(currentDevice.device, { exact: true });
    await expect(device).toBeVisible();
    const action = everywhere ? 'Sign out everywhere' : 'Sign out session';
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
    const unavailable = page.getByRole('heading', { name: 'Connection unavailable' });
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    const signIn = page.getByRole('heading', { name: 'Sign in', exact: true });
    await expect(unavailable).toBeVisible();
    await expect(device).toBeHidden();
    await expect(signIn).toHaveCount(0);
    expect(proofContexts).toEqual([bootstrap.session.csrf]);
    expect(mutations).toBe(1);

    proofAvailable = true;
    const configFailed = page.waitForEvent(
      'requestfailed',
      (request) =>
        request.url().endsWith('/api/config') &&
        request.headers()['x-session-context'] === signedOut.session.csrf,
    );
    await retry.click();
    await configFailed;
    await expect(unavailable).toBeVisible();
    await expect(device).toHaveCount(0);
    await expect(signIn).toHaveCount(0);

    configAvailable = true;
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(signIn).toBeVisible();
    await expect(
      page.getByText('Signed out of this browser. The requested change could not be confirmed.'),
    ).toBeVisible();
    expect(proofContexts).toEqual([bootstrap.session.csrf, bootstrap.session.csrf]);
    expect(mutations).toBe(1);
  });
}

test('a delayed logout message revalidates a newer active session without retiring it', async ({
  page,
}) => {
  const latest = { ...fixtureUser, csrf: 'synthetic-current-same-account-csrf' };
  const read = deferred();
  const release = deferred();
  let delayed = false;
  await page.route('**/api/auth/me', async (route) => {
    if (delayed) {
      read.resolve();
      await release.promise;
    }
    await route.fulfill({ json: accountStatus(latest) });
  });
  await page.route('**/api/config', (route) => {
    expect(route.request().headers()['x-session-context']).toBe(latest.csrf);
    return route.fulfill({ json: memberConfig });
  });
  try {
    await page.goto('/account');
    const password = page.getByLabel('New password', { exact: true });
    await password.fill('Disposable-unsaved-credential-2026');
    delayed = true;
    await page.evaluate(() => {
      const previousTab = new BroadcastChannel('cswatch-session');
      previousTab.postMessage({ stage: 'anonymous', id: null, enrollment: null, signedOut: true });
      previousTab.close();
    });
    await read.promise;
    await expect(password).toBeHidden();
    release.resolve();
    await expect(password).toBeVisible();
    await expect(password).toHaveValue('Disposable-unsaved-credential-2026');
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

const selfAccountPath = '/admin?section=users&user=' + memberUser.id;
async function installAdminDetail(
  page: Page,
  target = memberUser,
  identities: typeof memberUser.identities = [],
) {
  await installMemberWorkspace(page);
  const apiPath = '**/api/admin/users/' + target.id;
  await page.route(apiPath, (route) =>
    route.fulfill({
      json: {
        user: { ...target, created_at: 1_700_000_000, last_active: null },
        identities,
        factors: { totp: false, passkeys: 0, recovery_codes: 0 },
        sessions: [currentDevice],
        storage: { demos: 0, bytes: 0 },
      },
    }),
  );
  return apiPath;
}

test('administrator email edits show verification status for the saved address only', async ({
  page,
}) => {
  const target = {
    ...memberUser,
    id: 'admin-email-draft-fixture',
    role: 'member',
    username: 'reviewer_email_fixture',
    email: syntheticEmail(),
    email_verified_at: 1_795_000_000,
  };
  await installAdminDetail(page, target);
  await page.goto('/admin?section=users&user=' + target.id);
  const address = page.getByRole('textbox', { name: 'Email address', exact: true });
  const edit = page.locator('form').filter({ has: address });
  const verified = edit.getByText('Verified email address', { exact: true });
  await expect(address).toHaveValue(target.email);
  await expect(verified).toBeVisible();

  await address.fill(syntheticEmail());
  await expect(verified).toHaveCount(0);
  const change = edit.getByRole('button', { name: 'Change email address', exact: true });
  await expect(change).toBeEnabled();

  await address.fill(target.email);
  await expect(verified).toBeVisible();
  await expect(change).toBeDisabled();
});

test('administrator Steam unlink names the account and explains the effects before consent', async ({
  page,
}) => {
  const target = {
    ...memberUser,
    id: 'steam-unlink-fixture',
    role: 'member',
    username: 'reviewer_with_a_long_name',
  };
  const steam = '76561190000000001';
  const faceit = 'faceit-fixture';
  const apiPath = await installAdminDetail(page, target, [
    { provider: 'steam', subject: steam },
    { provider: 'faceit', subject: faceit },
  ]);
  let writes = 0;
  await page.route(apiPath + '/actions', (route) => {
    writes++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const path = '/admin?section=users&user=' + target.id;
  await page.goto(path);
  for (const language of ['en', 'fr']) {
    const french = language === 'fr';
    const label = french ? 'Dissocier Steam' : 'Unlink Steam';
    const title = french
      ? `${label} pour ${target.username} ?`
      : `${label} for ${target.username}?`;
    const effects = french
      ? /connexion avec Steam.*FACEIT associé est dissocié.*codes de synchronisation Steam.*matchs synchronisés sont effacés.*démos importées restent.*sessions sont fermées.*lien de réinitialisation précédent est désactivé.*plus de moyen de connexion.*lien de récupération à usage unique en privé/
      : /Steam sign-in stops.*FACEIT profile is disconnected.*Steam sync codes and synced matches are cleared.*Imported demos stay.*All sessions end.*earlier password reset link stops working.*no sign-in method left.*one-time recovery link privately/;
    for (const theme of ['dark', 'light']) {
      await page.evaluate(
        ({ language, theme }) => {
          localStorage.setItem('cswatch.language', language);
          localStorage.setItem('theme', theme);
        },
        { language, theme },
      );
      await page.goto(path);
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ]) {
        await page.setViewportSize({ width, height });
        const unlink = page.getByRole('button', { name: label, exact: true });
        await unlink.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: title, exact: true });
        await expect(dialog).toHaveAccessibleDescription(effects);
        expect(
          await dialog.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth &&
              element.scrollHeight <= element.clientHeight,
          ),
        ).toBe(true);
        const cancel = dialog.getByRole('button', {
          name: french ? 'Annuler' : 'Cancel',
          exact: true,
        });
        await expect(cancel).toBeFocused();
        if (width === 390) await cancel.click();
        else await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(unlink).toBeFocused();
        await expect(page.getByText(steam, { exact: true })).toBeAttached();
        await expect(page.getByText(faceit, { exact: true })).toBeAttached();
        if (width === 390 && theme === 'light') {
          await chooseSelectOption(page, french ? 'Rôle' : 'Role', 'Admin');
          const changeRole = french ? 'Modifier le rôle' : 'Change role';
          await page.getByRole('button', { name: changeRole, exact: true }).click();
          const promotion = page.getByRole('dialog', {
            name: french
              ? `${changeRole} pour ${target.username} ?`
              : `${changeRole} for ${target.username}?`,
            exact: true,
          });
          await expect(promotion).toHaveAccessibleDescription(
            french
              ? /Admin.*lien de réinitialisation précédent est désactivé.*en privé/
              : /Admin.*earlier password reset link stops working.*privately/,
          );
          await promotion
            .getByRole('button', { name: french ? 'Annuler' : 'Cancel', exact: true })
            .click();
          await expect(promotion).toHaveCount(0);
        }
        expect(writes).toBe(0);
      }
    }
  }
});

for (const delayed of [false, true]) {
  test(`an administrator reset receipt stays in its issuing session (delayed=${delayed})`, async ({
    page,
  }) => {
    const target = { ...memberUser, id: 'reset-target-fixture', username: 'reset fixture' };
    const apiPath = await installAdminDetail(page, target);
    const initial = accountStatus(memberUser);
    const proven = accountStatus({ ...memberUser, csrf: 'synthetic-reset-after-step-up' });
    const next = accountStatus({ ...memberUser, csrf: 'synthetic-reset-next-sign-in' });
    next.session.proof_fresh = false;
    initial.session.proof_fresh = delayed;
    let status = initial;
    const requested = deferred();
    const release = deferred();
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
    await page.route('**/api/auth/step-up/password', (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(initial.session.csrf);
      status = proven;
      return route.fulfill({ json: proven });
    });
    await page.route(apiPath + '/actions', async (route) => {
      const csrf = delayed ? initial.session.csrf : proven.session.csrf;
      expect(route.request().headers()['x-session-context']).toBe(csrf);
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      requested.resolve();
      if (delayed) await release.promise;
      return route.fulfill({
        json: {
          ok: true,
          recovery_code: 'e'.repeat(64),
          recovery_expires_in_ms: 599_000,
        },
      });
    });
    try {
      await page.goto('/admin?section=users&user=' + target.id);
      const reset = page.getByRole('button', { name: 'Reset password', exact: true });
      await reset.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Reset password' }).click();
      if (!delayed) {
        await page.getByLabel('Current password').fill('Synthetic-step-up-password');
        await page.getByRole('button', { name: 'Verify', exact: true }).click();
        await expect(page.getByLabel('One-time recovery link')).toBeVisible();
      }
      await requested.promise;
      status = next;
      const observed = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/config') &&
          response.request().headers()['x-session-context'] === next.session.csrf,
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await observed;
      release.resolve();
      await expect(reset).toBeEnabled();
      await expect(page.getByLabel('One-time recovery link')).toHaveCount(0);
    } finally {
      release.resolve();
    }
  });
}

for (const outcome of ['lost response', 'superseded response', 'stalled response'] as const) {
  test(`step-up closes the retired prompt after a ${outcome}`, async ({ page }) => {
    const target = { ...memberUser, id: 'proof-reset-fixture', username: 'step-up fixture' };
    const apiPath = await installAdminDetail(page, target);
    const initial = accountStatus(memberUser);
    initial.session.proof_fresh = false;
    const proven = accountStatus({ ...memberUser, csrf: 'synthetic-proof-grant' });
    const replacement = accountStatus({ ...memberUser, csrf: 'synthetic-proof-replacement' });
    let status = initial;
    const writes: string[] = [];
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
    await page.route('**/api/auth/step-up/password', async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(initial.session.csrf);
      if (outcome === 'stalled response') {
        status = proven;
        await new Promise((resolve) => setTimeout(resolve, 1800));
        return route.fulfill({ json: proven }).catch(() => {});
      }
      if (outcome === 'lost response') {
        status = proven;
        return route.abort('failed');
      }
      status = replacement;
      return route.fulfill({ json: proven });
    });
    await page.route(apiPath + '/actions', (route) => {
      writes.push(route.request().headers()['x-session-context']);
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/admin?section=users&user=' + target.id);
    const reset = page.getByRole('button', { name: 'Reset password', exact: true });
    const confirm = () => page.getByRole('dialog').getByRole('button', { name: 'Reset password' });
    await reset.click();
    await confirm().click();
    const proof = page.getByRole('dialog', { name: 'Confirm your identity' });
    await proof.getByLabel('Current password').fill('Synthetic-step-up-password');
    if (outcome === 'stalled response') {
      await page.evaluate(() => {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = (ms) => timeout(ms === 15_000 ? 600 : ms);
      });
    }
    await proof.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(proof).toHaveCount(0);
    await expect(
      page.getByText('Identity verification did not finish. Start the action again.'),
    ).toBeVisible();
    expect(writes).toEqual([]);
    await reset.click();
    await confirm().click();
    await expect.poll(() => writes).toEqual([status.session.csrf]);
  });
}

test('a pending MFA policy confirmation stays with its initiating administrator session', async ({
  page,
}) => {
  await installAdminDetail(page);
  let status = accountStatus(memberUser);
  let writes = 0;
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));
  await page.route('**/api/admin/mfa-policy', (route) => {
    writes++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/admin');
  const policy = page.getByRole('region', { name: 'Required second factor' });
  await policy.getByLabel('Member', { exact: true }).check();
  await policy.getByRole('button', { name: 'Save policy' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Change second-factor policy?' });
  await expect(confirmation).toBeVisible();
  status = accountStatus({ ...memberUser, csrf: 'synthetic-policy-replacement' });
  await confirmation.getByRole('button', { name: 'Save policy' }).click();
  await expect(policy.getByText('Session expired. Refresh the page and try again.')).toBeVisible();
  expect(writes).toBe(0);
});

for (const committed of [true, false]) {
  test(`an interrupted MFA policy response checks the ${committed ? 'committed' : 'unchanged'} policy without replaying the save`, async ({
    page,
  }) => {
    await installMemberWorkspace(page);
    const status = accountStatus(memberUser);
    status.session.factors!.totp = true;
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));

    const data = memberAdminData();
    const settingWrites: Record<string, boolean>[] = [];
    const writes: string[][] = [];
    const reads: string[] = [];
    const release = deferred();
    await page.route('**/api/admin/mfa-policy', async (route) => {
      expect(route.request().method()).toBe('PUT');
      expect(route.request().headers()['x-session-context']).toBe(status.session.csrf);
      const { roles, expected_roles } = route.request().postDataJSON();
      expect(expected_roles).toEqual(data.mfa_required_roles.value);
      writes.push(roles);
      if (writes.length === 1) {
        if (committed) data.mfa_required_roles.value = roles;
        await release.promise;
        await route.abort('failed').catch(() => {});
        return;
      }
      data.mfa_required_roles.value = roles;
      await route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/admin', async (route) => {
      if (route.request().method() === 'PATCH') {
        const changes = route.request().postDataJSON();
        settingWrites.push(changes);
        data.flags.registrations_enabled.value = changes.registrations_enabled;
        await route.fulfill({ json: { ok: true } });
        return;
      }
      expect(route.request().method()).toBe('GET');
      if (writes.length) {
        reads.push(route.request().headers()['x-session-context']);
        if (reads.length === 1) {
          await release.promise;
          await route.abort('failed').catch(() => {});
          return;
        }
      }
      await route.fulfill({ json: data });
    });
    try {
      await page.goto('/admin');
      const policy = page.getByRole('region', { name: 'Required second factor' });
      const member = policy.getByLabel('Member', { exact: true });
      const save = policy.getByRole('button', { name: 'Save policy', exact: true });
      const check = policy.getByRole('button', { name: 'Check current policy', exact: true });
      const draft = page.getByRole('switch', { name: 'New registrations', exact: true });
      const guest = page.getByRole('switch', { name: 'Guest demo uploads', exact: true });
      const saveSettings = page.getByRole('button', { name: 'Save settings', exact: true });
      async function submit() {
        await save.click();
        await page
          .getByRole('dialog', { name: 'Change second-factor policy?' })
          .getByRole('button', { name: 'Save policy', exact: true })
          .click();
      }
      await expect(guest).toBeChecked();
      await expect(saveSettings).toBeDisabled();
      await draft.check();
      await expect(member).not.toBeChecked();
      await member.check();
      await page.evaluate(() => {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = (ms) => timeout(ms === 15_000 ? 1_200 : ms);
      });
      await submit();
      await expect.poll(() => writes.length).toBe(1);
      data.flags.guest_uploads_enabled.value = false;
      await expect(member).toBeDisabled();
      await expect.poll(() => reads.length).toBe(1);
      await expect(check).toBeEnabled();
      await expect(policy.getByRole('status')).toHaveText(
        'The save response was interrupted. The current policy could not be checked.',
      );
      await expect(member).toBeDisabled();
      await expect(save).toBeDisabled();
      expect(writes).toEqual([['admin', 'member']]);

      await check.focus();
      await page.keyboard.press('Enter');
      await expect(policy.getByRole('status')).toHaveText(
        `The save response was interrupted. The current policy ${committed ? 'matches' : 'differs from'} your selection.`,
      );
      await expect(member).toBeChecked({ checked: committed });
      await expect(member).toBeEnabled();
      await expect(save).toBeDisabled();
      await expect(draft).toBeChecked();
      await expect(guest).not.toBeChecked();
      expect(writes).toEqual([['admin', 'member']]);
      expect(reads).toEqual([status.session.csrf, status.session.csrf]);

      if (!committed) {
        await member.check();
        await submit();
        await expect(page.getByText('Second-factor policy saved.', { exact: true })).toBeVisible();
        await expect(member).toBeChecked();
        await expect(save).toBeDisabled();
        await expect(draft).toBeChecked();
        expect(writes).toEqual([
          ['admin', 'member'],
          ['admin', 'member'],
        ]);
      }
      await saveSettings.click();
      await expect(page.getByText('Instance settings saved.', { exact: true })).toBeVisible();
      expect(settingWrites).toEqual([{ registrations_enabled: true }]);
      await expect(draft).toBeChecked();
      await expect(guest).not.toBeChecked();
      await expect(saveSettings).toBeDisabled();
    } finally {
      release.resolve();
    }
  });
}

for (const mode of [
  'reviewed before submission',
  'reviewed during confirmation',
  'conflict',
  'self-retiring conflict',
] as const) {
  test(`MFA policy preserves another administrator's change (${mode})`, async ({ page }) => {
    await installMemberWorkspace(page);
    const retiresSession = mode === 'self-retiring conflict';
    const observedChange =
      mode === 'reviewed before submission' || mode === 'reviewed during confirmation';
    const status = accountStatus(memberUser);
    status.session.factors!.totp = !retiresSession;
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: status }));

    const data = memberAdminData();
    data.mfa_required_roles.value = ['member'];
    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    let holdRead = false;
    let rejectRead = false;
    let failSessionCheck = false;
    const writes: { roles: string[]; expected_roles: string[] }[] = [];
    await page.route('**/api/config', (route) => {
      if (failSessionCheck) {
        failSessionCheck = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: memberConfig });
    });
    await page.route('**/api/admin', async (route) => {
      if (holdRead) {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      if (rejectRead) {
        rejectRead = false;
        return route.fulfill({ status: 503, json: { detail: 'Connection lost. Try again.' } });
      }
      return route.fulfill({ json: data });
    });
    await page.route('**/api/admin/mfa-policy', (route) => {
      expect(route.request().headers()['x-session-context']).toBe(status.session.csrf);
      const write = route.request().postDataJSON();
      writes.push(write);
      if (writes.length === 1) {
        rejectRead = true;
        failSessionCheck = retiresSession;
        return route.fulfill({
          status: 409,
          json: {
            code: 'mfa_policy_conflict',
            detail: 'The second-factor policy changed while you were editing.',
          },
        });
      }
      data.mfa_required_roles.value = write.roles;
      return route.fulfill({ json: { ok: true } });
    });

    try {
      await page.goto('/admin');
      const policy = page.getByRole('region', { name: 'Required second factor' });
      const member = policy.getByLabel('Member', { exact: true });
      const admin = policy.getByLabel('Admin', { exact: true });
      const save = policy.getByRole('button', { name: 'Save policy', exact: true });
      const confirmation = page.getByRole('dialog', { name: 'Change second-factor policy?' });
      const confirmSave = confirmation.getByRole('button', { name: 'Save policy', exact: true });
      const draft = page.getByRole('switch', { name: 'New registrations', exact: true });
      await draft.check();
      if (observedChange) {
        holdRead = true;
        await page.getByRole('button', { name: 'Refresh map status' }).click();
        await refreshStarted.promise;
      }
      await member.uncheck();
      if (retiresSession) await admin.check();
      if (mode !== 'reviewed before submission') {
        await save.click();
        await expect(confirmation).toBeVisible();
      }
      data.mfa_required_roles.value = retiresSession ? [] : ['member', 'admin'];

      const alert = policy.getByRole('alert');
      if (observedChange) {
        releaseRefresh.resolve();
        await expect(page.getByLabel('Admin', { exact: true })).toBeChecked();
        if (mode === 'reviewed during confirmation') await confirmSave.click();
        expect(writes).toEqual([]);
      } else {
        await confirmSave.click();
        const check = policy.getByRole('button', { name: 'Check current policy' });
        await expect(check).toBeEnabled();
        await expect(alert).toHaveText(
          'The second-factor policy changed while you were editing. The current policy could not be checked.',
        );
        await expect(save).toBeDisabled();
        await expect(member).toBeDisabled();
        expect(writes).toEqual([
          { roles: retiresSession ? ['admin'] : [], expected_roles: ['member'] },
        ]);
        await check.click();
      }
      await expect(alert).toHaveText(
        'The second-factor policy changed while you were editing. Review the current policy before saving again.',
      );
      await expect(member).toBeChecked({ checked: !retiresSession });
      await expect(admin).toBeChecked({ checked: !retiresSession });
      await expect(save).toBeDisabled();
      await expect(draft).toBeChecked();
      expect(writes).toHaveLength(observedChange ? 0 : 1);

      if (mode === 'conflict') {
        await member.uncheck();
        await save.click();
        await confirmSave.click();
        await expect(page.getByText('Second-factor policy saved.', { exact: true })).toBeVisible();
        expect(writes[1]).toEqual({ roles: ['admin'], expected_roles: ['member', 'admin'] });
      }
    } finally {
      releaseRefresh.resolve();
    }
  });
}

for (const response of [
  'policy conflict',
  'changed session',
  'network denied',
  'incomplete reply',
  'lost reply',
] as const) {
  test(`MFA policy reconciliation preserves a peer grant after a ${response}`, async ({ page }) => {
    await installMemberWorkspace(page);
    const original = accountStatus(memberUser);
    const replacement = accountStatus({ ...memberUser, csrf: 'replacement-after-password-change' });
    const anonymous = accountStatus(null);
    let current = original as typeof original | typeof anonymous;
    let logouts = 0;
    let saves = 0;
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: current }));
    await page.route('**/api/config', (route) =>
      route.fulfill({ json: { ...memberConfig, admin_access: current.user !== null } }),
    );
    await page.route('**/api/admin', (route) =>
      route.fulfill({
        json: { ...memberAdminData(), mfa_required_roles: { value: ['member'], locked: false } },
      }),
    );
    await page.route('**/api/admin/mfa-policy', (route) => {
      saves++;
      current = anonymous;
      if (response === 'lost reply') return route.abort('failed');
      if (response === 'incomplete reply') return route.fulfill({ status: 409, body: '' });
      if (response === 'changed session')
        return route.fulfill({ status: 409, headers: { 'X-Session-Changed': '1' }, json: {} });
      if (response === 'network denied')
        return route.fulfill({
          status: 403,
          json: {
            code: 'admin_network_denied',
            detail: 'Administration is unavailable from this network.',
          },
        });
      return route.fulfill({
        status: 409,
        json: {
          code: 'mfa_policy_conflict',
          detail: 'The second-factor policy changed while you were editing.',
        },
      });
    });
    await page.route('**/api/auth/logout', (route) => {
      logouts++;
      return route.fulfill({ json: anonymous });
    });
    await page.goto('/admin');
    const policy = page.getByRole('region', { name: 'Required second factor' });
    await policy.getByLabel('Admin', { exact: true }).check();
    await policy.getByRole('button', { name: 'Save policy', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save policy', exact: true })
      .click();
    await expect.poll(() => saves).toBe(1);
    await expect(policy).toHaveCount(0);
    current = replacement;
    await page.goto('/account');
    await expect(page.getByLabel('Your sign-in username', { exact: true })).toHaveValue(
      memberUser.username,
    );
    expect(logouts).toBe(0);
    expect(saves).toBe(1);
  });
}

test('an administrator can recover a returned reset link after an interrupted session check', async ({
  page,
}) => {
  const target = { ...memberUser, id: 'pending-reset-fixture', username: 'pending reset fixture' };
  const apiPath = await installAdminDetail(page, target);
  const code = 'f'.repeat(64);
  let blockConfig = false;
  let writes = 0;
  await page.clock.setFixedTime(Date.now() + 15 * 60_000);
  await page.route('**/api/config', (route) =>
    blockConfig ? route.abort('failed') : route.fulfill({ json: memberConfig }),
  );
  await page.route(apiPath + '/actions', (route) => {
    writes++;
    blockConfig = true;
    return route.fulfill({
      json: { ok: true, recovery_code: code, recovery_expires_in_ms: 599_000 },
    });
  });
  await page.goto('/admin?section=users&user=' + target.id);
  const reset = page.getByRole('button', { name: 'Reset password', exact: true });
  await reset.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset password' }).click();
  const retry = page.getByRole('button', { name: 'Try again', exact: true });
  await expect(retry).toBeVisible();
  await expect(reset).toBeDisabled();
  await expect(page.getByLabel('One-time recovery link')).toHaveCount(0);
  blockConfig = false;
  await retry.click();
  await expect(page.getByLabel('One-time recovery link')).toHaveValue(
    new URL('/recover#' + code, page.url()).href,
  );
  expect(writes).toBe(1);
});

test('a successful administrator self-reset retires the admin view and saves only the recovery receipt', async ({
  page,
}) => {
  const apiPath = await installAdminDetail(page);
  let ended = false;
  let failed = true;
  await page.route('**/api/auth/me', (route) =>
    ended && failed
      ? route.abort('failed')
      : route.fulfill({ json: accountStatus(ended ? null : memberUser) }),
  );
  const fixtureCode = 'b'.repeat(64);
  await page.route(apiPath + '/actions', (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: 'reset-password' });
    ended = true;
    return route.fulfill({
      json: {
        ...accountStatus(null),
        ok: true,
        recovery_code: fixtureCode,
        recovery_expires_in_ms: 599_000,
      },
    });
  });
  await page.goto(selfAccountPath);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Reset password', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
  await expect(page.locator('.admin-user-detail')).toHaveCount(0);
  await expect(page.getByLabel('One-time recovery link')).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Recovery link for ' + memberUser.username }),
  ).toBeVisible();
  await expect(page.getByLabel('One-time recovery link')).toHaveValue(
    new URL('/recover#' + fixtureCode, page.url()).href,
  );
  await expect(page.locator('.admin-user-detail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('One-time recovery link')).toHaveCount(0);
});

test('the same account losing its administrator role retires private details before configuration returns', async ({
  page,
}) => {
  await installAdminDetail(page);
  const configRead = deferred();
  const release = deferred();
  let downgraded = false;
  let fail = true;
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: accountStatus(downgraded ? { ...memberUser, role: 'member' } : memberUser),
    }),
  );
  await page.route('**/api/config', async (route) => {
    if (downgraded && fail) {
      configRead.resolve();
      await release.promise;
      return route.abort('failed');
    }
    return route.fulfill({ json: { ...memberConfig, admin_access: !downgraded } });
  });
  try {
    await page.goto(selfAccountPath);
    const detail = page.locator('.admin-user-detail');
    await expect(detail.getByRole('heading', { name: memberUser.username })).toBeVisible();
    downgraded = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await configRead.promise;
    await expect(detail).toHaveCount(0);
    release.resolve();
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Administrator access required.', { exact: true })).toBeVisible();
    await expect(detail).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

test('a guest viewer retains its view for the same capability and retires it for a replaced or revoked capability', async ({
  page,
}) => {
  const initialGuest = 'synthetic-first-guest-csrf';
  const secondGuest = 'synthetic-second-guest-csrf';
  let guest: string | null = initialGuest;
  let gate: ReturnType<typeof deferred> | undefined;
  let read: ReturnType<typeof deferred> | undefined;
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        ...accountStatus(null),
        guest_session: guest ? { csrf: guest, expires_at: 2_000_000_000 } : null,
      },
    }),
  );
  await page.route('**/api/config', async (route) => {
    read?.resolve();
    await gate?.promise;
    await route.fulfill({ json: memberConfig });
  });
  await page.route('**/api/demos/guest-scope-fixture', (route) =>
    route.fulfill(
      guest
        ? {
            json: {
              id: 'guest-scope-fixture',
              name: 'Private guest view',
              source: 'guest',
              status: guest === initialGuest ? 'processing' : 'queued',
              owned: false,
              guest_owned: true,
              public: false,
              size: 100,
              map: null,
              duration: null,
              rounds: null,
              created_at: 0,
              expires_at: 2_000_000_000,
            },
          }
        : { status: 404, json: { detail: 'Demo not found.' } },
    ),
  );
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.goto('/watch/guest-scope-fixture');
  await expect(page.getByRole('heading', { name: 'Reading the match…' })).toBeVisible();
  const firstViewer = await page.locator('.viewer-shell').elementHandle();
  const sameConfig = page.waitForResponse('**/api/config');
  await focus();
  await sameConfig;
  await expect(page.getByRole('heading', { name: 'Reading the match…' })).toBeVisible();
  expect(await firstViewer!.evaluate((element) => element.isConnected)).toBe(true);

  try {
    for (const next of [secondGuest, null]) {
      guest = next;
      gate = deferred();
      read = deferred();
      await focus();
      await read.promise;
      await expect(page.locator('.viewer-shell')).toHaveCount(0);
      gate.resolve();
      if (next)
        await expect(
          page.getByRole('heading', { name: 'Your demo is in the queue' }),
        ).toBeVisible();
      else await expect(page.getByText('Demo not found.', { exact: true })).toBeVisible();
    }
  } finally {
    gate?.resolve();
  }
});

test('a tab started hidden requires a fresh identity check on its first foreground', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
  });
  const requested = deferred();
  const release = deferred();
  let firstForeground = false;
  await page.route('**/api/auth/me', async (route) => {
    if (firstForeground) {
      requested.resolve();
      await release.promise;
      return route.abort('failed');
    }
    await route.fulfill({ json: accountStatus(fixtureUser) });
  });
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  try {
    await page.goto('/account');
    const password = page.getByLabel('New password', { exact: true });
    await expect(password).toHaveCount(1);
    await expect(password).toBeHidden();
    firstForeground = true;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await requested.promise;
    await expect(password).toBeHidden();
    release.resolve();
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
    firstForeground = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(password).toBeVisible();
  } finally {
    release.resolve();
  }
});

test('an administrator self-recovery receipt survives its issued anonymous session and is removed before a different one commits', async ({
  page,
}) => {
  const apiPath = await installAdminDetail(page);
  const boot = accountStatus<typeof memberUser>(null);
  const first = {
    ...boot,
    session: {
      ...boot.session,
      csrf: 'synthetic-self-recovery-scope-a',
      anonymous_id: 'synthetic-grant-a',
    },
  };
  const replacement = {
    ...boot,
    session: {
      ...boot.session,
      csrf: 'synthetic-self-recovery-scope-b',
      anonymous_id: 'synthetic-grant-b',
    },
  };
  const fixtureCode = 'd'.repeat(64);
  const configB = deferred();
  const release = deferred();
  let current = accountStatus(memberUser);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: current }));
  await page.route('**/api/config', async (route) => {
    if (route.request().headers()['x-session-context'] === replacement.session.csrf) {
      configB.resolve();
      await release.promise;
    }
    return route.fulfill({ json: memberConfig });
  });
  await page.route(apiPath + '/actions', (route) => {
    current = first;
    return route.fulfill({
      json: { ...first, ok: true, recovery_code: fixtureCode, recovery_expires_in_ms: 599_000 },
    });
  });
  const restore = () =>
    page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
  try {
    await page.goto(selfAccountPath);
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Reset password', exact: true })
      .click();
    const code = page.getByLabel('One-time recovery link');
    const link = new URL('/recover#' + fixtureCode, page.url()).href;
    await expect(code).toHaveValue(link);
    const verified = page.waitForResponse('**/api/config');
    await restore();
    await verified;
    await expect(code).toBeVisible();
    await expect(code).toHaveValue(link);

    current = { ...first, session: { ...first.session, csrf: 'synthetic-rotated-csrf' } };
    const sameGrant = page.waitForResponse('**/api/config');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sameGrant;
    await expect(page.getByLabel('One-time recovery link')).toHaveValue(
      new RegExp(fixtureCode + '$'),
    );
    current = replacement;
    await restore();
    await configB.promise;
    await expect(code).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Recovery link for ' + memberUser.username }),
    ).toHaveCount(0);
    release.resolve();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    release.resolve();
  }
});

test('an in-page network denial conceals cached diagnostics and keeps the signed-in account', async ({
  page,
}) => {
  await installMemberWorkspace(page);
  const release = deferred();
  let deniedReads = 0;
  let deniedChecks = 0;
  let allowed = true;
  await page.route('**/api/admin', (route) => {
    if (allowed) return route.fallback();
    deniedReads++;
    return route.fulfill({
      status: 403,
      json: {
        code: 'admin_network_denied',
        detail: 'Administration is unavailable from this network.',
      },
    });
  });
  await page.route('**/api/config', async (route) => {
    if (allowed) return route.fallback();
    expect(route.request().headers()['x-session-context']).toBe(memberUser.csrf);
    deniedChecks++;
    await release.promise;
    return route.fulfill({ json: { ...memberConfig, admin_access: false } });
  });
  const diagnostics = page.getByRole('heading', { name: 'Processing queue' });
  const notice = page.getByRole('alert').filter({
    hasText: /^Administration is unavailable from this network\.$/,
  });
  try {
    await page.goto('/admin');
    await expect(diagnostics).toBeVisible();
    allowed = false;
    await page.getByRole('button', { name: 'Refresh map status' }).click();

    await expect.poll(() => deniedChecks).toBe(1);
    await expect(diagnostics).toBeHidden();
    await expect(notice).toHaveCount(0);
    release.resolve();

    await expect(diagnostics).toHaveCount(0);
    await expect(notice).toHaveCount(1);
    await expect(notice).toBeVisible();
    expect(deniedReads).toBe(1);
    await page.getByRole('button', { name: memberUser.username, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Account settings', exact: true }).click();
    await expect(page.getByLabel('Your sign-in username')).toHaveValue(memberUser.username);
    await expect(page.locator('.account-identity .member-role')).toHaveText('Admin');
  } finally {
    release.resolve();
  }
});

test('foreground checking conceals an open administrator confirmation until network access is known', async ({
  page,
}) => {
  const apiPath = await installAdminDetail(page);
  const read = deferred();
  const release = deferred();
  let access: 'allowed' | 'failed' | 'denied' = 'allowed';
  let writes = 0;
  await page.route('**/api/config', async (route) => {
    if (access === 'failed') {
      read.resolve();
      await release.promise;
      return route.abort('failed');
    }
    return route.fulfill({ json: { ...memberConfig, admin_access: access === 'allowed' } });
  });
  await page.route(apiPath + '/actions', (route) => {
    writes++;
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto(selfAccountPath.replace('/admin', '/%41DMIN'));
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    access = 'failed';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await read.promise;
    await expect(page.locator('.admin-user-detail')).toBeHidden();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    release.resolve();
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
    access = 'denied';
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Administration is unavailable from this network.', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.admin-user-detail')).toHaveCount(0);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    expect(writes).toBe(0);
    await page.getByRole('button', { name: memberUser.username, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Account settings', exact: true }).click();
    await expect(page.getByLabel('Your sign-in username')).toHaveValue(memberUser.username);
  } finally {
    release.resolve();
  }
});

test('a same-account network denial removes the administrator step-up dialog and cancels its action', async ({
  page,
}) => {
  const apiPath = await installAdminDetail(page);
  const admin = accountStatus(memberUser);
  let allowed = true;
  let writes = 0;
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { ...admin, session: { ...admin.session, proof_fresh: false } } }),
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...memberConfig, admin_access: allowed } }),
  );
  await page.route(apiPath + '/actions', (route) => {
    writes++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(selfAccountPath);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Reset password', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Confirm your identity' })).toBeVisible();
  allowed = false;
  await page.evaluate(({ id, role }) => {
    const peer = new BroadcastChannel('cswatch-session');
    peer.postMessage({ id, role, stage: 'full', enrollment: null });
    peer.close();
  }, memberUser);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(
    page.getByText('Administration is unavailable from this network.', { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(0);
});

test('a changed guest capability between status and configuration conceals the old viewer before retry', async ({
  page,
}) => {
  const fixtureCsrf = 'synthetic-guest-pair-scope';
  const retry = deferred();
  const release = deferred();
  let mode: 'stable' | 'changed' | 'recovering' | 'absent' = 'stable';
  const guest = () => ({
    ...accountStatus(null),
    guest_session: { csrf: fixtureCsrf, expires_at: 2_000_000_000 },
  });
  await page.route('**/api/auth/me', async (route) => {
    if (mode === 'recovering') {
      retry.resolve();
      await release.promise;
      return route.abort('failed');
    }
    return route.fulfill({ json: mode === 'absent' ? accountStatus(null) : guest() });
  });
  const contexts: string[] = [];
  await page.route('**/api/config', (route) => {
    contexts.push(route.request().headers()['x-guest-context']);
    if (mode === 'changed') {
      mode = 'recovering';
      return route.fulfill(sessionChanged);
    }
    return route.fulfill({
      json: { ...memberConfig, guest_uploads_enabled: mode !== 'absent' },
    });
  });
  await page.route('**/api/demos/guest-pair-fixture', (route) =>
    route.fulfill(
      mode !== 'absent'
        ? {
            json: {
              id: 'guest-pair-fixture',
              name: 'Private guest upload',
              source: 'guest',
              status: 'processing',
              guest_owned: true,
            },
          }
        : { status: 404, json: { detail: 'Demo not found.' } },
    ),
  );
  try {
    await page.goto('/watch/guest-pair-fixture');
    const prior = page.getByRole('heading', { name: 'Reading the match…' });
    await expect(prior).toBeVisible();

    mode = 'changed';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await retry.promise;
    await expect(prior).toBeHidden();
    release.resolve();
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
    await expect(prior).toBeHidden();

    mode = 'absent';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Demo unavailable' })).toBeVisible();
    await expect(prior).toHaveCount(0);
    expect(contexts).toContain(fixtureCsrf);
    expect(contexts.at(-1)).toBe('');
  } finally {
    release.resolve();
  }
});

test('a denied administrator sees the connection address and the specific proxy error on the admin page', async ({
  page,
}, testInfo) => {
  await installAdminDetail(page);
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        ...memberConfig,
        admin_access: false,
        admin_network_denial: 'unknown_client',
        admin_network_diagnostic: {
          connection: '172.18.0.2',
          client: null,
          issue: 'missing_address',
        },
      },
    }),
  );
  await page.goto('/admin');
  for (const language of ['en', 'fr']) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(
        ({ language, theme }) => {
          localStorage.setItem('cswatch.language', language);
          localStorage.setItem('theme', theme);
        },
        { language, theme },
      );
      await page.reload();
      const alert = page.getByRole('alert').filter({ hasText: '172.18.0.2' });
      await expect(alert).toContainText(
        language === 'fr' ? 'sans adresse cliente' : 'without a client address',
      );
      await expect(alert).toContainText(language === 'fr' ? 'Non vérifiée' : 'Unverified');
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ]) {
        await page.setViewportSize({ width, height });
        await expect(alert).toBeInViewport();
        expect(await alert.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        if (process.env.CSWATCH_CAPTURE_NETWORK)
          await page.screenshot({
            path: testInfo.outputPath('network-' + language + '-' + theme + '-' + width + '.png'),
          });
      }
    }
  }
  await expect(page).toHaveURL(/\/admin$/);
});
