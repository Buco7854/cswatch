import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('cold tabs share one browser grant before guest issuance and account sign-in', async ({
  page,
  context,
  playwright,
}) => {
  test.skip(
    Boolean(process.env.E2E_SETUP || process.env.E2E_PRIVATE || process.env.E2E_EXISTING_SERVER) ||
      process.env.E2E_REGISTRATIONS === 'false',
    'Uses an isolated public instance with registrations.',
  );

  const other = await context.newPage();
  // A tab without Web Locks must coordinate with a standard tab.
  await other.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  const firstGrant = deferred();
  const release = deferred();
  const otherProbe = deferred();
  const bootstraps: string[] = [];
  let lastGrant = '';
  await context.route('**/api/auth/me', async (route) => {
    const request = route.request();
    // Use a browser-independent request context so the first Set-Cookie
    // stays withheld until its real page receives the complete response.
    const server = await playwright.request.newContext();
    try {
      const response = await server.get(request.url(), {
        headers: { ...(await request.allHeaders()), 'x-forwarded-for': '192.0.2.58' },
      });
      if (response.headers()['set-cookie']) {
        const { session } = await response.json();
        bootstraps.push(session.csrf);
        lastGrant = session.csrf;
        if (bootstraps.length === 1) {
          firstGrant.resolve();
          await release.promise;
        }
      }
      if (request.frame().page() === other) otherProbe.resolve();
      await route.fulfill({ response });
    } finally {
      await server.dispose();
    }
  });
  try {
    await page.goto('/register?returnTo=%2Faccount');
    await firstGrant.promise;
    expect(await context.cookies()).toEqual([]);
    await other.goto('/');
    await otherProbe.promise;
    expect(bootstraps).toHaveLength(1);
    release.resolve();

    await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
    await expect(other.getByRole('button', { name: 'Choose demo file' })).toBeVisible();
    expect(bootstraps).toHaveLength(1);

    const guest = (tab: Page, csrf: string) =>
      tab.evaluate(async (token) => {
        const response = await fetch('/api/guest/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': token },
          body: '{}',
        });
        return { status: response.status, body: await response.json() };
      }, csrf);
    const issued = await Promise.all([guest(page, lastGrant), guest(other, lastGrant)]);
    expect(issued.filter(({ status }) => status === 201)).toHaveLength(1);
    const capability = issued.find(({ status }) => status === 201)!.body.csrf;
    expect((await guest(other, capability)).body.csrf).toBe(capability);

    const name = 'cold_' + randomUUID().slice(0, 8);
    await page.getByLabel('Display name', { exact: true }).fill(name);
    await page.getByLabel('Password', { exact: true }).fill('Disposable-cold-tab-password-2026');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Save your sign-in name' })).toBeVisible();
    expect((await guest(other, capability)).status).toBe(403);
    const active = await other.evaluate(async () => (await fetch('/api/auth/me')).json());
    expect(active.user.display_name).toBe(name);
    expect(active.guest_session).toBeNull();
    expect(bootstraps).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

for (const scenario of [
  {
    access: 'missing',
    language: 'en',
    title: 'Browser storage unavailable',
    detail:
      'In your browser settings, allow this site to store data, then retry. You can also use another browser.',
    retryLabel: 'Retry',
    signIn: 'Sign in',
  },
  {
    access: 'denied',
    language: 'fr',
    title: 'Stockage du navigateur indisponible',
    detail:
      'Dans les réglages du navigateur, autorisez ce site à stocker des données, puis réessayez. Vous pouvez aussi utiliser un autre navigateur.',
    retryLabel: 'Réessayer',
    signIn: 'Se connecter',
  },
] as const) {
  test(`cold sign-in needs shared storage when IndexedDB is ${scenario.access}`, async ({
    page,
    context,
  }) => {
    test.skip(Boolean(process.env.E2E_SETUP));
    await page.addInitScript(({ language, access }) => {
      localStorage.setItem('cswatch.language', language);
      const storage = window.indexedDB;
      let blocked = true;
      window.addEventListener('restore-fixture-storage', () => (blocked = false), { once: true });
      Object.defineProperty(window, 'indexedDB', {
        get() {
          if (!blocked) return storage;
          if (access === 'denied') throw new DOMException('Storage is blocked.', 'SecurityError');
          return undefined;
        },
      });
    }, scenario);
    const probe = page.waitForResponse('**/api/auth/me');
    await page.goto('/login');
    expect((await probe).status()).toBe(204);
    await expect(page.getByRole('heading', { name: scenario.title, exact: true })).toBeFocused();
    await expect(page.getByRole('alert')).toHaveText(scenario.detail);
    expect(await context.cookies()).toEqual([]);

    await page.evaluate(() => window.dispatchEvent(new Event('restore-fixture-storage')));
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: scenario.retryLabel, exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: scenario.signIn, exact: true })).toBeVisible();
    const cookies = await context.cookies();
    const prefix = cookies.every((cookie) => cookie.secure) ? '__Host-' : '';
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      prefix + 'cswatch_browser',
      prefix + 'cswatch_browser_binding',
    ]);
  });
}
