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

async function choose(page: Page, option: string, french = false) {
  await page
    .getByRole('combobox', {
      name: french ? 'Source de la démo à importer' : 'Demo import source',
      exact: true,
    })
    .click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
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

test('Premier and Competitive import guide leads to the real file picker and a private upload', async ({
  page,
}) => {
  test.skip(privateInstance);
  await member(page);
  const uploadButton = page.getByRole('button', { name: 'Choose demo file', exact: true });
  await expect(uploadButton).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Demo import source' })).toHaveCount(0);
  const help = page.getByText('Where do I get a demo?', { exact: true });
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('link', { name: 'Open Steam match history', exact: true }),
  ).toHaveAttribute('href', 'https://steamcommunity.com/my/gcpd/730/');
  await expect(page.getByText('Extract archive downloads to get the .dem file.')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('dialog[open]').evaluate((dialog) => {
        dialog.scrollTop = 0;
      });
      await fits(page, `steam-en-${theme}-${width}`);
      const upload = await uploadButton.boundingBox();
      expect(upload!.y + upload!.height).toBeLessThanOrEqual(900);
    }
  }
  await page.getByText('Already downloaded it inside CS2?', { exact: true }).click();
  await expect(page.getByText('game/csgo/replays', { exact: true })).toBeVisible();
  await page.locator('dialog[open]').evaluate((dialog) => {
    dialog.scrollTop = dialog.scrollHeight;
  });
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
  await page.getByRole('button', { name: 'Choose demo file', exact: true }).click();
  await (await chooser).setFiles(file);
  await expect(page).toHaveURL(/\/watch\/uploaded-fixture$/);
});

test('manual source help remains usable in French, both themes and narrow dialogs', async ({
  page,
}) => {
  test.skip(privateInstance);
  await member(page, true);
  await page.getByText('Où trouver une démo ?', { exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Source de la démo à importer', exact: true }),
  ).toHaveText('Premier / Compétitif / Wingman');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await fits(page, `steam-fr-${theme}-${width}`);
    }
  }
  await choose(page, 'FACEIT', true);
  await expect(page.getByRole('link', { name: 'Ouvrir FACEIT', exact: true })).toHaveAttribute(
    'href',
    'https://www.faceit.com/en/cs2',
  );
  await choose(page, 'HLTV', true);
  await expect(
    page.getByRole('link', { name: 'Trouver des démos sur HLTV', exact: true }),
  ).toHaveAttribute('href', 'https://www.hltv.org/results?content=demo');
  await expect(page.getByRole('link', { name: /bibliothèque pro/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choisir le fichier de démo' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ ...file, name: 'download.dem.bz2' });
  await expect(page.getByRole('alert')).toContainText('Extrayez d’abord ce téléchargement');
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
