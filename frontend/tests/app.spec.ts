import { test, expect } from '@playwright/test';
const privateInstance = Boolean(process.env.E2E_PRIVATE);
test('public landing has working proof, feature navigation, and guest viewer', async ({ page }) => {
  test.skip(privateInstance, 'Private entry has its own assertions.');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Every round. Every angle.' })).toBeVisible();
  await page.getByRole('button', { name: 'Follow marlow' }).click();
  await expect(page.getByRole('button', { name: 'Follow marlow' })).toHaveClass('selected');
  await page.getByRole('slider', { name: 'Practice preview timeline' }).fill('900');
  await page.getByRole('textbox', { name: 'What would you review?' }).fill('Look at the timing');
  await page.getByRole('button', { name: 'Try a note', exact: true }).click();
  await expect(page.getByText('Look at the timing', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Try the viewer', exact: true }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Training courtyard', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.site-sidebar')).toHaveCount(0);
  expect(
    await page
      .locator('.viewer-frame')
      .evaluate((el) => Math.abs(el.getBoundingClientRect().height - innerHeight) < 2),
  ).toBe(true);
  await page.getByLabel('Camera mode').selectOption('2d');
  await expect(
    page.getByRole('img', { name: 'Player position plot. No map geometry.' }),
  ).toBeVisible();
  const slider = page.getByRole('slider', { name: 'Playback position' });
  const before = await slider.inputValue();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect(Number(await slider.inputValue())).toBeGreaterThan(Number(before));
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('switch', { name: /X-ray silhouettes/ }).uncheck();
  await page.getByLabel('Rendering quality').selectOption('low');
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('switch', { name: /X-ray silhouettes/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
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
  await page.goto('/');
  await page.getByRole('link', { name: 'Start your review', exact: true }).first().click();
  await expect(page).toHaveURL(/\/library\?upload=1/);
  await expect(page.getByRole('heading', { name: 'Your review needs a home.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to continue', exact: true }).click();
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('Unique-test-password-392!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('.auth-dialog')).toBeHidden();
  await expect(page).toHaveURL(/\/library\?upload=1/);
  await page.getByRole('button', { name: 'Close upload' }).click();
  await expect(page.getByText('Your matches belong here.')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(username) }).click();
  await page
    .getByRole('navigation', { name: 'Account and mobile navigation' })
    .getByRole('link', { name: 'Account settings' })
    .click();
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(username) }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Your review needs a home.' })).toBeVisible();
});
test('French covers public pages, viewer, auth errors and saved language choice', async ({
  page,
}) => {
  test.skip(privateInstance);
  await page.goto('/');
  await page.getByLabel('Language').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { name: 'Chaque round. Chaque angle.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chaque round. Chaque angle.' })).toBeVisible();
  await page.getByRole('link', { name: 'Essayer le lecteur', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Cour d’entraînement' })).toBeVisible();
  await page.getByLabel('Mode de caméra').selectOption('2d');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('switch', { name: /Silhouettes à travers les murs/ })).toBeVisible();
  await page.getByRole('button', { name: 'Fermer les options du lecteur' }).click();
  await page.getByRole('banner').getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.getByLabel('Nom d’utilisateur', { exact: true }).fill('missing_member');
  await page.getByLabel('Mot de passe', { exact: true }).fill('wrong-test-password');
  await page.getByRole('dialog').getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Nom d’utilisateur ou mot de passe incorrect.');
  await page.getByRole('button', { name: 'Fermer la connexion' }).click();
  await page.getByLabel('Langue').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
test('private entry gates feature and demo routes and respects registrations policy', async ({
  page,
  request,
}) => {
  test.skip(!privateInstance);
  for (const path of ['/', '/features/viewer', '/library', '/watch/sample']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'A private review room.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try the viewer' })).toHaveCount(0);
  }
  expect((await request.get('/api/demos?scope=public')).status()).toBe(401);
  expect((await request.get('/api/maps/de_mirage')).status()).toBe(401);
  expect((await request.get('/map-assets/de_mirage.glb')).status()).toBe(401);
  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  if (process.env.E2E_REGISTRATIONS === 'false')
    await expect(page.getByRole('button', { name: 'New here? Create an account' })).toHaveCount(0);
  else
    await expect(page.getByRole('button', { name: 'New here? Create an account' })).toBeVisible();
  await page.getByRole('button', { name: 'Close sign in' }).click();
  if (process.env.E2E_REGISTRATIONS !== 'false') {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in to continue' }).click();
    await page.getByRole('button', { name: 'New here? Create an account' }).click();
    await page.getByLabel('Username', { exact: true }).fill('private_' + Date.now().toString(36));
    await page.getByLabel('Password', { exact: true }).fill('Unique-private-password-392!');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole('heading', { name: 'Demo library', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Shared demos', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Shared demos', exact: true })).toBeVisible();
    await expect(
      page.getByText('Matches shared with instance members.', { exact: true }),
    ).toBeVisible();
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
    await page.getByRole('button', { name: 'Players', exact: true }).click();
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
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByRole('button', { name: /echo/ }).click();
  await expect(page.locator('.player-row.selected strong')).toHaveText('echo');
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
