import { test, expect, type Page } from '@playwright/test';

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

const fixtureUser = {
  id: 'auth-lifecycle-fixture',
  username: 'fixture',
  is_admin: false,
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
    route.fulfill({ json: { user: authenticated ? fixtureUser : null } }),
  );
  await page.route('**/api/auth/login', async (route) => {
    attempts++;
    await response.promise;
    authenticated = true;
    await route.fulfill({ json: { user: fixtureUser } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const form = page.getByRole('form', { name: 'Sign in', exact: true });
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByText('Sign in to your review room.', { exact: true })).toBeVisible();
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    await form.getByLabel('Password', { exact: true }).fill('Disposable-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    // An explicit second submit must not create a competing authentication request.
    await form.evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.getByRole('link', { name: 'Go back', exact: true }).click();
    await expect(form).toHaveCount(0);
    await changeRoute(page, '/account');
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await form.getByLabel('Username', { exact: true }).fill('new_attempt');

    const refreshed = page.waitForResponse(
      async (response) =>
        response.url().endsWith('/api/auth/me') &&
        (await response.json()).user?.id === fixtureUser.id,
    );
    response.resolve();
    await (await refreshed).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Username', { exact: true })).toHaveValue('new_attempt');
    await expect(form.getByRole('alert')).toHaveCount(0);
    expect(attempts).toBe(1);
    await changeRoute(page, '/account');
    await expect(page.getByText('Signed in as fixture.', { exact: true })).toBeVisible();
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
    route.fulfill({ json: { user: authenticated ? fixtureUser : null } }),
  );
  await page.route('**/api/auth/login', async (route) => {
    attempts++;
    if (attempts === 1) {
      await first.promise;
      authenticated = true;
      await route.fulfill({ json: { user: fixtureUser } });
    } else {
      await second.promise;
      await route.fulfill({ status: 401, json: { detail: 'Invalid username or password.' } });
    }
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const form = page.getByRole('form', { name: 'Sign in', exact: true });
    await form.getByLabel('Username', { exact: true }).fill('fixture');
    await form.getByLabel('Password', { exact: true }).fill('Disposable-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);

    await changeRoute(page, '/account');
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await form.getByLabel('Username', { exact: true }).fill('new_attempt');
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
    await expect(form.getByLabel('Username', { exact: true })).toHaveValue('new_attempt');

    second.resolve();
    await expect(form.getByRole('alert')).toHaveText('Invalid username or password.');
    await expect(form.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
    await changeRoute(page, '/account');
    await expect(page.getByText('Signed in as fixture.', { exact: true })).toBeVisible();
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
    await route.fulfill({ json: { user: snapshot } });
  });
  await page.route('**/api/auth/login', (route) => {
    session = ++attempts === 1 ? firstUser : latestUser;
    return route.fulfill({ json: { user: session } });
  });
  await page.route('**/api/auth/password', (route) => {
    passwordCsrf = route.request().headers()['x-csrf-token'];
    return route.fulfill({ json: { csrf: latestUser.csrf } });
  });
  try {
    await page.goto('/account');
    const form = page.getByRole('form', { name: 'Sign in', exact: true });
    await form.getByLabel('Username', { exact: true }).fill(firstUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-first-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await oldRefreshStarted.promise;
    await page.getByRole('link', { name: 'Go back', exact: true }).click();
    await expect(form).toHaveCount(0);
    await changeRoute(page, '/account');

    await form.getByLabel('Username', { exact: true }).fill(latestUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-latest-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: latestUser.username, exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Signed in as latest_fixture.', { exact: true })).toBeVisible();

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
    await expect(page.getByText('Signed in as latest_fixture.', { exact: true })).toBeVisible();
    await page
      .getByLabel('Current password', { exact: true })
      .fill('Disposable-latest-password-2026');
    await page.getByLabel('New password', { exact: true }).fill('Disposable-updated-password-2026');
    await page.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect.poll(() => passwordCsrf).toBe(latestUser.csrf);
    await expect(page.getByText('Signed in as latest_fixture.', { exact: true })).toBeVisible();
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
    return route.fulfill({ json: { user: session } });
  });
  await page.route('**/api/auth/login', async (route) => {
    if (++attempts === 1) {
      await lateLogin.promise;
      session = lateUser;
    } else session = displayedUser;
    await route.fulfill({ json: { user: session } });
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
    await form.getByLabel('Username', { exact: true }).fill(lateUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-late-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    await page.getByRole('link', { name: 'Go back', exact: true }).click();
    await expect(form).toHaveCount(0);
    await changeRoute(page, '/account');
    await form.getByLabel('Username', { exact: true }).fill(displayedUser.username);
    await form.getByLabel('Password', { exact: true }).fill('Disposable-displayed-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Signed in as displayed_fixture.', { exact: true })).toBeVisible();
    await expect(form).toHaveCount(0);
    lateLogin.resolve();
    await lateRefresh.promise;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await page
      .getByLabel('Current password', { exact: true })
      .fill('Disposable-displayed-password-2026');
    await page.getByLabel('New password', { exact: true }).fill('Disposable-updated-password-2026');
    await page.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect.poll(() => mutationCsrf).toBe(displayedUser.csrf);
    expect(authorizedMutations).toBe(0);
    await expect(page.getByText('Invalid CSRF token.', { exact: true })).toBeVisible();
  } finally {
    lateLogin.resolve();
  }
});
