import { expect, test, type Page } from '@playwright/test';
import { originalOverviewPNG } from './fixtures/original-map';

// Original synthetic raster, not game artwork. Genuine map crops are inspected
// separately against the operator's ignored preview pack.
const image = originalOverviewPNG();
const descriptor = { image: '/api/map-preview/de_mirage.png', map: 'de_mirage' };
const publicOnly = Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function fonts(page: Page) {
  await page.evaluate(() => document.fonts.ready);
}

test('optional map artwork leaves upload geometry, language menus and file picking usable in both themes and languages', async ({
  page,
}) => {
  test.skip(publicOnly);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseImage = deferred();
  await page.route('**/api/map-preview', (route) => route.fulfill({ json: descriptor }));
  await page.route('**/api/map-preview/de_mirage.png', async (route) => {
    await releaseImage.promise;
    await route.fulfill({ contentType: 'image/png', body: image });
  });
  try {
    for (const language of ['en', 'fr']) {
      for (const theme of ['dark', 'light']) {
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.addInitScript(
            ({ language, theme }) => {
              localStorage.setItem('cswatch.language', language);
              localStorage.setItem('theme', theme);
            },
            { language, theme },
          );
          await page.goto('/', { waitUntil: 'domcontentloaded' });
          const upload = page.getByRole('button', {
            name: language === 'fr' ? /Déposez votre démo ici/ : /Drop your demo here/,
          });
          await expect(upload).toBeVisible();
          await fonts(page);
          const before = await upload.boundingBox();
          releaseImage.resolve();
          await expect(page.locator('.landing-backdrop')).toHaveAttribute('data-ready', 'true');
          expect(await upload.boundingBox()).toEqual(before);
          const decorative = page.locator('.landing-backdrop img');
          await expect(decorative).toHaveAttribute('alt', '');
          expect(
            await decorative.evaluate((element: HTMLImageElement) => element.naturalWidth),
          ).toBe(1024);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          const languageMenu = page.getByRole('combobox', {
            name: language === 'fr' ? 'Langue' : 'Language',
            exact: true,
          });
          const triggerBefore = await languageMenu.boundingBox();
          await languageMenu.click();
          await expect(page.getByRole('option', { name: 'Français', exact: true })).toBeVisible();
          // The modal list correctly hides surrounding controls from the
          // accessibility tree. Measure the same visible trigger in the DOM.
          expect((await page.locator('.public-header .language-control').boundingBox())?.x).toBe(
            triggerBefore?.x,
          );
          await page.keyboard.press('Escape');
          await expect(languageMenu).toBeFocused();
          const picker = page.waitForEvent('filechooser');
          await upload.click();
          await (await picker).setFiles([]);
          releaseImage = deferred();
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    releaseImage.resolve();
  }
});

test('missing, failed or malformed optional previews preserve entry and never fetch an untrusted image', async ({
  page,
}) => {
  test.skip(publicOnly);
  const errors: string[] = [],
    requestedImages: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/map-preview/*.png', (route) => {
    requestedImages.push(route.request().url());
    return route.fulfill({ status: 404 });
  });
  await page.route('https://untrusted.invalid/**', (route) => {
    requestedImages.push(route.request().url());
    return route.abort();
  });
  for (const value of [
    { image: null, map: null },
    { image: 'https://untrusted.invalid/image.png', map: 'de_mirage' },
    { image: '/api/map-preview/de_dust2.png', map: 'de_mirage' },
    { image: '/api/map-preview/unlisted.png', map: 'unlisted' },
    descriptor,
    null,
  ]) {
    await page.route('**/api/map-preview', (route) =>
      value === null ? route.fulfill({ status: 503 }) : route.fulfill({ json: value }),
    );
    const previewResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/map-preview'),
    );
    const imageResponse =
      value === descriptor
        ? page.waitForResponse((response) => response.url().endsWith(descriptor.image))
        : null;
    await page.goto('/');
    await previewResponse;
    if (imageResponse) await imageResponse;
    await expect(page.getByRole('button', { name: /Drop your demo here/ })).toBeEnabled();
    await expect(page.locator('.landing-backdrop')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.unroute('**/api/map-preview');
  }
  expect(requestedImages).toHaveLength(1);
  expect(new URL(requestedImages[0]).pathname).toBe(descriptor.image);
  expect(errors).toEqual([]);
});

test('leaving public entry cancels a delayed preview without loading artwork on another screen', async ({
  page,
}) => {
  test.skip(publicOnly);
  const started = deferred(),
    response = deferred();
  let images = 0;
  await page.route('**/api/map-preview', async (route) => {
    started.resolve();
    await response.promise;
    await route.fulfill({ json: descriptor }).catch(() => {});
  });
  await page.route('**/api/map-preview/*.png', (route) => {
    images++;
    return route.fulfill({ contentType: 'image/png', body: image });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await started.promise;
    await page.evaluate(() => {
      history.pushState({}, '', '/account');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('button', { name: 'Sign in to continue' })).toBeVisible();
    response.resolve();
    await expect(page.locator('.landing-backdrop')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in to continue' }).click();
    await expect(page.getByRole('dialog', { name: 'Back for another look.' })).toBeVisible();
    expect(images).toBe(0);
  } finally {
    response.resolve();
  }
});
