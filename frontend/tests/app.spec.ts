import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { activateViewerAction } from './fixtures/viewer-actions';
import { test, expect, type Page } from '@playwright/test';
import { selectOptionsCategory } from './fixtures/viewer-options';
import { sample } from '../src/sample';
const privateInstance = Boolean(process.env.E2E_PRIVATE);
async function choose(page: Page, label: string, option: string) {
  if (label === 'Language' || label === 'Langue') {
    await page
      .getByRole('button', {
        name: label === 'Langue' ? 'Menu du lecteur' : 'Viewer menu',
        exact: true,
      })
      .click();
    await page
      .getByRole('menuitem', { name: option === 'FR' ? 'Français' : 'English', exact: true })
      .click();
    return;
  }
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
test('the single public page uploads a private guest demo into the whole-tab viewer', async ({
  page,
}) => {
  test.skip(privateInstance, 'Private entry has its own assertions.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/guest/session', (route) =>
    route.fulfill({ json: { csrf: 'synthetic-guest-token', expires_at: 2000000000 } }),
  );
  const file = {
    name: 'guest-fixture.dem',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('PBDEMS2\0synthetic-guest-upload-fixture'),
  };
  await page.route('**/api/demos', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe('synthetic-guest-token');
    expect(route.request().postDataBuffer()?.includes(file.buffer)).toBe(true);
    await route.fulfill({ status: 202, json: { id: 'guest-fixture' } });
  });
  await page.route('**/api/demos/guest-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'guest-fixture',
        name: file.name,
        source: 'synthetic-qa',
        status: 'ready',
        public: false,
        owned: false,
        guest_owned: true,
        expires_at: 2000000000,
        map: 'de_guest_fixture',
        size: file.buffer.length,
        rounds: 3,
        duration: 60,
        created_at: 1700000000,
        error: null,
      },
    }),
  );
  await page.route('**/api/demos/guest-fixture/playback', (route) =>
    fulfillReplayFixture(route, { ...sample, sample: false, map: 'de_guest_fixture' }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Review your CS2 demos.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/Buco7854/cswatch',
  );
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Try the viewer', exact: true })).toHaveCount(0);
  await expect(
    page.locator('a[href^="/features"],a[href="/explore"],a[href="/watch/sample"]'),
  ).toHaveCount(0);
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose demo file/ }).click();
  await (await picker).setFiles(file);
  await expect(page).toHaveURL(/\/watch\/guest-fixture$/);
  await expect(page.getByRole('heading', { name: 'guest_fixture', exact: true })).toBeVisible();
  await expect(page.locator('.auth-page')).toHaveCount(0);
  await expect(page.locator('.site-sidebar')).toHaveCount(0);
  expect(
    await page
      .locator('.viewer-frame')
      .evaluate((element) => Math.abs(element.getBoundingClientRect().height - innerHeight) < 2),
  ).toBe(true);
  await choose(page, 'Camera mode', '2D tactical · low power');
  await expect(page.getByRole('status', { name: 'Map unavailable', exact: true })).toBeVisible();
  const slider = page.getByRole('slider', { name: 'Playback position' });
  const before = await slider.inputValue();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect(Number(await slider.inputValue())).toBeGreaterThan(Number(before));
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('switch', { name: /X-ray silhouettes/ }).uncheck();
  await selectOptionsCategory(page, 'Performance');
  await choose(page, 'Rendering quality', 'Low · reduced resolution, no shadows');
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('switch', { name: /X-ray silhouettes/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  for (const width of [390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.viewer-dock')
        .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});
test('account-required upload preserves route intent, registration and logout work', async ({
  page,
}) => {
  test.skip(privateInstance || process.env.E2E_REGISTRATIONS === 'false');
  const username = 'review_' + Date.now().toString(36);
  await page.goto('/library?upload=1');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Flibrary%3Fupload%3D1$/);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'New here? Create an account' }).click();
  await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('Unique-test-password-392!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Create account', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/library\?upload=1/);
  await page.getByRole('button', { name: 'Close upload' }).click();
  await expect(page.getByText('No demos yet.')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(username) }).click();
  await page
    .getByRole('menu', { name: 'Account menu' })
    .getByRole('menuitem', { name: 'Account settings' })
    .click();
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation', exact: true })
      .getByRole('link', { name: 'Account settings' }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation', exact: true })
      .getByRole('link', { name: 'Connections', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Connected accounts', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/connections$/);
  await expect(page.getByRole('heading', { name: 'Steam identity' })).toBeVisible();
  await page.goto('/connections');
  await expect(page).toHaveURL(/\/account\/connections$/);
  await page.getByRole('button', { name: new RegExp(username) }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount%2Fconnections$/);
});
test('French covers public pages, viewer, auth errors and saved language choice', async ({
  page,
}) => {
  test.skip(privateInstance);
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: 'Français', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { name: 'Revoyez vos démos CS2.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Revoyez vos démos CS2.' })).toBeVisible();
  await expect(page.locator('a[href^="/features"],a[href="/explore"]')).toHaveCount(0);
  // The internal practice fixture still exercises French viewer states without
  // presenting an example demo as the anonymous upload feature.
  await page.goto('/watch/sample');
  await expect(page.getByRole('heading', { name: 'Cour d’entraînement' })).toBeVisible();
  await choose(page, 'Mode de caméra', 'Vue tactique 2D · économe');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('switch', { name: /Silhouettes à travers les murs/ })).toBeVisible();
  await page.getByRole('button', { name: 'Fermer les options du lecteur' }).click();
  await page.getByRole('button', { name: 'Menu du lecteur', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Se connecter', exact: true }).click();
  await page.getByLabel('Nom d’utilisateur', { exact: true }).fill('missing_member');
  await page.getByLabel('Mot de passe', { exact: true }).fill('wrong-test-password');
  await page
    .getByRole('form', { name: 'Se connecter', exact: true })
    .getByRole('button', { name: 'Se connecter', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveText('Nom d’utilisateur ou mot de passe incorrect.');
  await page.getByRole('link', { name: 'Retour', exact: true }).click();
  await choose(page, 'Langue', 'EN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
test('private entry gates feature and demo routes and respects registrations policy', async ({
  page,
  request,
}) => {
  test.skip(!privateInstance);
  for (const path of ['/', '/features/viewer', '/library', '/watch/sample']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(
      page.getByText('This instance is open to signed-in members only.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try the viewer' })).toHaveCount(0);
  }
  const login = await page.goto('/login?returnTo=%2Faccount');
  expect(login?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.reload())?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const registration = await page.goto('/register?returnTo=%2Faccount');
  expect(registration?.status()).toBe(200);
  await expect(
    page.getByRole('heading', {
      name: process.env.E2E_REGISTRATIONS === 'false' ? 'Sign in' : 'Create account',
      exact: true,
    }),
  ).toBeVisible();
  await page.goto('/login');
  const notice = await request.get('/licenses/provider-brands.txt');
  expect(notice.status()).toBe(200);
  expect(notice.headers()['content-type']).toContain('text/plain');
  expect(await notice.text()).toContain('©2026 Valve Corporation.');
  expect((await request.get('/api/demos?scope=public')).status()).toBe(401);
  expect((await request.get('/api/maps/de_mirage')).status()).toBe(401);
  expect((await request.get('/map-assets/de_mirage.glb')).status()).toBe(401);
  if (process.env.E2E_REGISTRATIONS === 'false')
    await expect(page.getByRole('link', { name: 'New here? Create an account' })).toHaveCount(0);
  else await expect(page.getByRole('link', { name: 'New here? Create an account' })).toBeVisible();
  if (process.env.E2E_REGISTRATIONS !== 'false') {
    await page.goto('/');
    await page.getByRole('link', { name: 'New here? Create an account' }).click();
    await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill('private_' + Date.now().toString(36));
    await page.getByLabel('Password', { exact: true }).fill('Unique-private-password-392!');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole('heading', { name: 'Demo library', exact: true })).toBeVisible();
    await expect(page.locator('a[href="/explore"]')).toHaveCount(0);
    await page.goto('/');
    await expect(page).toHaveURL(/\/library$/);
  }
});

test('viewer keeps scene, dock, panels and fullscreen within the browser tab', async ({ page }) => {
  test.skip(privateInstance);
  await page.goto('/watch/sample');
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [768, 1024],
    [1440, 900],
    [1920, 1080],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.locator('.viewer-frame').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
      }),
    ).toBe(true);
    expect(
      await page.locator('.viewer-dock').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }),
    ).toBe(true);
    await activateViewerAction(page, 'Players');
    await expect(page.locator('.viewer-drawer')).toBeVisible();
    expect(
      await page.locator('.viewer-drawer').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.height > 70 &&
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          r.left >= 0 &&
          r.right <= innerWidth
        );
      }),
    ).toBe(true);
    await page.getByRole('button', { name: 'Close panel' }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await activateViewerAction(page, 'Players');
  await page.getByRole('button', { name: /echo/ }).click();
  await expect(page.locator('.viewer-drawer')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Camera mode' })).toContainText(
    'Player perspective',
  );
  await activateViewerAction(page, 'Players');
  await expect(
    page.getByRole('button', { name: 'Select player echo', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await page.getByPlaceholder('What happened here?').fill('Check this timing');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByText('Check this timing', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.viewer-drawer')).toHaveCount(0);
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole('button', { name: 'Toggle fullscreen' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => document.fullscreenElement?.classList.contains('viewer-frame')),
      )
      .toBe(true);
    await page.evaluate(() => document.exitFullscreen());
  }
});

test('viewer menus support keyboard selection, bounded touch lists and fullscreen dialogs', async ({
  page,
}) => {
  test.skip(privateInstance);
  test.setTimeout(90000);
  await page.goto('/watch/sample');
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
      await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
      await page
        .getByRole('menuitem', {
          name: theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme',
        })
        .click();
    }
    for (const [width, height] of [
      [320, 740],
      [768, 1024],
      [1440, 900],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      // Resize events close Radix selects. Let the browser deliver that event
      // and commit the responsive layout before opening the next keyboard list.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const camera = page.getByRole('combobox', { name: 'Camera mode' });
      await page.getByRole('button', { name: 'Viewer menu', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(camera).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('listbox')).toBeVisible();
      expect(
        await page.getByRole('listbox').evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.top >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight
          );
        }),
      ).toBe(true);
      await page.keyboard.press('End');
      await expect(
        page.getByRole('option', { name: 'Player perspective', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(camera).toContainText('Player perspective');
      const compact = width <= 760 || (width <= 1100 && height <= 560);
      const triggerName = 'Replay tools';
      const menuName = 'Replay tools';
      await page.getByRole('button', { name: triggerName, exact: true }).click();
      await expect(page.getByRole('menu', { name: menuName })).toBeVisible();
      expect(
        await page.getByRole('menu', { name: menuName }).evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.top >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight
          );
        }),
      ).toBe(true);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: triggerName, exact: true })).toBeFocused();
      if (compact) {
        expect(
          await page.locator('.viewer-controlbar button:visible').evaluateAll((elements) =>
            elements.every((element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.width >= 44 && bounds.height >= 44;
            }),
          ),
        ).toBe(true);
        await page.getByRole('button', { name: 'Replay tools' }).click();
        await page.getByRole('menuitem', { name: 'Add note', exact: true }).click();
        await expect(page.getByPlaceholder('What happened here?')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Close panel' })).toBeFocused();
        await page.getByRole('button', { name: 'Close panel' }).click();
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await activateViewerAction(page, 'Players');
  await page.getByRole('button', { name: 'Replay tools', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.viewer-drawer')).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole('button', { name: 'Toggle fullscreen' }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await choose(page, 'Camera mode', 'Overhead');
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await selectOptionsCategory(page, 'Performance');
    await choose(page, 'Rendering quality', 'Low · reduced resolution, no shadows');
    await expect(page.getByRole('combobox', { name: 'Rendering quality' })).toContainText('Low');
    await page.getByRole('button', { name: 'Close viewer options' }).click();
    await page.evaluate(() => document.exitFullscreen());
  }
});

test('library searches the full collection and keeps loaded pages on refresh', async ({ page }) => {
  test.skip(privateInstance);
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: 'library-fixture-' + index,
    name: index === 119 ? 'unique-final-match.dem' : 'team-review-' + index + '.dem',
    source: 'upload',
    status: 'ready',
    size: 1024,
    created_at: 1700000000 - index,
    public: false,
    owned: true,
    map: 'de_mirage',
    duration: 1200,
    rounds: 24,
    error: null,
  }));
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'library-fixture-user',
          username: 'library_fixture',
          is_admin: false,
          csrf: 'library-fixture-csrf',
          identities: [],
        },
      },
    }),
  );
  await page.route('**/api/demos?*', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('scope')).toBe('mine');
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const offset = Number(url.searchParams.get('offset') || 0);
    const matches = rows.filter((row) => (row.name + ' ' + row.map).toLowerCase().includes(query));
    await route.fulfill({
      json: { demos: matches.slice(offset, offset + 50), total: matches.length },
    });
  });
  await page.goto('/library');
  await expect(page.locator('.demo-row:not(.table-head)')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more demos' }).click();
  await expect(page.locator('.demo-row:not(.table-head)')).toHaveCount(100);
  await page.getByRole('button', { name: 'Refresh demos' }).click();
  await expect(page.locator('.library-section')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.demo-row:not(.table-head)')).toHaveCount(100);
  await page.getByRole('textbox', { name: 'Search demos' }).fill('unique-final');
  await expect(page.locator('.demo-row:not(.table-head)')).toHaveCount(1);
  await expect(page.getByText('unique-final-match.dem', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more demos' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search demos' }).fill('no-such-match');
  await expect(page.getByRole('heading', { name: 'No matching demos.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search demos' }).clear();
  await expect(page.locator('.demo-row:not(.table-head)')).toHaveCount(50);
});

test('guest upload policy keeps the public entry simple and uses one accessible language menu', async ({
  page,
}) => {
  test.skip(privateInstance);
  await page.route('**/api/config', async (route) => {
    const config = await (await route.fetch()).json();
    await route.fulfill({ json: { ...config, guest_uploads_enabled: false } });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Review your CS2 demos.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in to upload', exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"],select')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: 'Français', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Revoyez vos démos CS2.', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const signin = await page
        .getByRole('button', { name: 'Se connecter', exact: true })
        .boundingBox();
      expect(signin!.width).toBeGreaterThanOrEqual(44);
      expect(signin!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.getByRole('button', { name: 'Se connecter pour importer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Se connecter', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Flibrary$/);
});

test('personal library search keeps the complete placeholder readable and keyboard focus visible', async ({
  page,
}) => {
  test.skip(privateInstance);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'search-fixture-user',
          username: 'search_fixture',
          is_admin: false,
          csrf: 'search-fixture-csrf',
          identities: [],
        },
      },
    }),
  );
  await page.route('**/api/demos?*', (route) => route.fulfill({ json: { demos: [], total: 0 } }));
  await page.goto('/library');
  for (const language of ['en', 'fr']) {
    await page.getByRole('combobox', { name: /^(Language|Langue)$/, exact: true }).click();
    await page
      .getByRole('option', { name: language === 'en' ? 'English' : 'Français', exact: true })
      .click();
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const input = page.getByRole('textbox', {
          name: language === 'en' ? 'Search demos' : 'Rechercher des démos',
          exact: true,
        });
        await expect(input).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const clearance = await input.evaluate((element) => {
          const input = element as HTMLInputElement;
          const style = getComputedStyle(input);
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = style.font;
          return (
            input.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight) -
            context.measureText(input.placeholder).width
          );
        });
        expect(clearance).toBeGreaterThanOrEqual(1);
        await input.focus();
        expect(await input.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
          'none',
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
  }
  await expect(page.locator('a[href="/explore"],.workspace-label')).toHaveCount(0);
});
