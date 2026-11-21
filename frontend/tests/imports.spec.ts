import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ reducedMotion: 'reduce' });
const privateInstance = Boolean(process.env.E2E_PRIVATE);
const file = {
  name: 'premier-fixture.dem',
  mimeType: 'application/octet-stream',
  buffer: Buffer.from('PBDEMS2\0synthetic-upload-test'),
};

async function member(page: Page, french = false) {
  if (french) await page.addInitScript(() => localStorage.setItem('cswatch.language', 'fr'));
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'upload-fixture-user',
          username: 'upload_fixture',
          is_admin: false,
          csrf: 'upload-fixture-csrf',
          identities: [],
        },
      },
    }),
  );
  await page.route('**/api/demos?**', (route) =>
    route.fulfill({ json: { demos: [], has_more: false } }),
  );
  await page.goto('/library');
  await page
    .getByRole('button', { name: french ? 'Ajouter une démo' : 'Add a demo', exact: true })
    .click();
}
async function fits(page: Page, filename: string) {
  expect(
    await page
      .locator('dialog[open]')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 2),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.CSWATCH_IMPORT_SCREENSHOTS) {
    mkdirSync(process.env.CSWATCH_IMPORT_SCREENSHOTS, { recursive: true });
    await page.screenshot({
      path: resolve(process.env.CSWATCH_IMPORT_SCREENSHOTS, filename + '.png'),
    });
  }
}

test('the file-only dialog leads to the native picker and a private upload', async ({ page }) => {
  test.skip(privateInstance);
  await member(page);
  const uploadButton = page.getByRole('button', { name: 'Choose demo file', exact: true });
  await expect(uploadButton).toBeVisible();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await expect(dialog.locator('details')).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: 'Upload a demo' }).getByRole('link')).toHaveCount(
    0,
  );
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('dialog[open]').evaluate((dialog) => {
        dialog.scrollTop = 0;
      });
      await fits(page, `upload-en-${theme}-${width}`);
      const upload = await uploadButton.boundingBox();
      expect(upload!.y + upload!.height).toBeLessThanOrEqual(900);
    }
  }
  const close = await page.getByRole('button', { name: 'Close upload', exact: true }).boundingBox();
  expect(close!.y).toBeGreaterThanOrEqual(0);
  expect(close!.y + close!.height).toBeLessThanOrEqual(900);
  await page.route('**/api/demos', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe('upload-fixture-csrf');
    expect(route.request().postDataBuffer()?.includes(file.buffer)).toBe(true);
    await route.fulfill({ status: 202, json: { id: 'uploaded-fixture' } });
  });
  await page.route('**/api/demos/uploaded-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'uploaded-fixture',
        status: 'queued',
        name: file.name,
        owned: true,
        public: false,
        source: 'upload',
      },
    }),
  );
  const chooser = page.waitForEvent('filechooser');
  await uploadButton.focus();
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(file);
  await expect(page).toHaveURL(/\/watch\/uploaded-fixture$/);
});

test('members can open connections from a separate link beside the file picker', async ({
  page,
}) => {
  test.skip(privateInstance);
  await member(page, true);
  const connections = page.getByRole('link', { name: 'Steam et FACEIT Comptes associés' });
  await expect(connections).toHaveAttribute('href', '/account/connections');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await fits(page, `upload-fr-${theme}-${width}`);
    }
  }
  await expect(page.getByRole('button', { name: 'Choisir le fichier de démo' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ ...file, name: 'download.dem.bz2' });
  await expect(page.getByRole('alert')).toContainText('Extrayez d’abord ce téléchargement');
  await connections.click();
  await expect(page).toHaveURL(/\/account\/connections$/);
  await expect(page.getByRole('heading', { name: 'Comptes associés', exact: true })).toBeVisible();
});

test('guests sign in for accounts and return directly to connections', async ({ page }) => {
  test.skip(privateInstance || process.env.E2E_REGISTRATIONS === 'false');
  await page.goto('/');
  await expect(
    page.getByRole('region', { name: 'Choose a CS2 demo' }).getByRole('link'),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Steam and FACEIT Sign in to connect' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount%2Fconnections$/);
  await expect(page.getByRole('link', { name: 'Go back' })).toHaveAttribute('href', '/');
  await page.getByRole('link', { name: 'New here? Create an account', exact: true }).click();
  const registration = page.getByRole('form', { name: 'Create account', exact: true });
  await registration
    .getByLabel('Username', { exact: true })
    .fill('connections_' + Date.now().toString(36));
  await registration
    .getByLabel('Password', { exact: true })
    .fill('Disposable-browser-password-2026!');
  await registration.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/connections$/);
  await expect(
    page.getByRole('heading', { name: 'Connected accounts', exact: true }),
  ).toBeVisible();
});

test('dismissing the upload dialog returns focus unless the user has moved it', async ({
  page,
}) => {
  test.skip(privateInstance);
  await member(page);
  const add = page.getByRole('button', { name: 'Add a demo', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Upload a demo', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();

  await page.goto('/library?upload=1');
  await expect(dialog).toBeVisible();
  await page.mouse.click(1, 1);
  await expect(page).toHaveURL(/\/library$/);
  await expect(add).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  const queued = await page.evaluate(async () => {
    const request = window.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => frames.push(callback);
    try {
      document.querySelector<HTMLButtonElement>('.upload-dialog .dialog-close')!.click();
      await new Promise<void>((resolve) => request.call(window, () => resolve()));
      document.querySelector<HTMLInputElement>('.library-tools input')!.focus();
      for (const frame of frames) frame(performance.now());
      return frames.length;
    } finally {
      window.requestAnimationFrame = request;
    }
  });
  expect(queued).toBeGreaterThan(0);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search demos', exact: true })).toBeFocused();
});

test('closing an upload cancels the request and never redirects after unmount', async ({
  page,
}) => {
  test.skip(privateInstance);
  await member(page);
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/demos', async (route) => {
    started = true;
    await delayed;
    await route.fulfill({ status: 202, json: { id: 'late-upload-must-not-open' } }).catch(() => {});
  });
  const failed = page.waitForEvent(
    'requestfailed',
    (request) => new URL(request.url()).pathname === '/api/demos',
  );
  await page.locator('input[type=file]').setInputFiles(file);
  await expect.poll(() => started).toBe(true);
  await expect(
    page.getByText('Closing this dialog cancels the upload.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close upload', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a demo', exact: true })).toBeFocused();
  await failed;
  release();
  await page.waitForTimeout(100);
  await expect(page).toHaveURL(/\/library$/);
  expect(errors).toEqual([]);
});

test('malformed successful upload responses show a retryable error without hanging', async ({
  page,
}) => {
  test.skip(privateInstance);
  await member(page);
  await page.route('**/api/demos', (route) => route.fulfill({ status: 200, json: null }));
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByRole('alert')).toContainText('Upload failed.');
  await expect(page.getByRole('button', { name: 'Choose demo file', exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/library$/);
});
