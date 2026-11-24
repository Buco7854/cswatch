import { chooseCameraControl } from './fixtures/viewer-transport';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { selectOptionsCategory, type OptionsCategory } from './fixtures/viewer-options';

const french = JSON.parse(
  readFileSync(new URL('../src/locales/fr.json', import.meta.url), 'utf8'),
) as Record<string, string>;
type Language = 'en' | 'fr';
const message = (language: Language, key: string) => (language === 'fr' ? french[key] || key : key);

/** The shipped, explicitly labeled original practice scene; never personal data. */
async function openPractice(
  page: Page,
  language: Language = 'en',
  theme: 'light' | 'dark' = 'dark',
) {
  await page.addInitScript(
    ({ language, theme }) => {
      localStorage.setItem('cswatch.language', language);
      localStorage.setItem('theme', theme);
      if (
        !localStorage.getItem(
          window.matchMedia(
            '(max-width:760px),(max-width:960px) and (max-height:560px),(pointer:coarse) and (max-height:560px)',
          ).matches
            ? 'viewer-settings-v2-mobile'
            : 'viewer-settings-v2',
        )
      )
        ['viewer-settings-v2', 'viewer-settings-v2-mobile'].forEach((key) =>
          localStorage.setItem(
            key,
            JSON.stringify({
              quality: 'low',
              autoHideControls: false,
              radar: false,
              killfeed: false,
            }),
          ),
        );
    },
    { language, theme },
  );
  await page.goto('/watch/sample');
  await expect(
    page.getByRole('heading', { name: message(language, 'Training courtyard'), exact: true }),
  ).toBeVisible();
}
const openOptions = (page: Page) =>
  page.getByRole('button', { name: 'Options', exact: true }).click();
const closeOptions = (page: Page, language: Language = 'en') =>
  page
    .getByRole('button', { name: message(language, 'Close viewer options'), exact: true })
    .click();
const chooseCamera = async (page: Page, language: Language, option: string) => {
  await chooseCameraControl(page, message(language, option), message(language, 'Camera mode'));
};
const saved = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(
      localStorage.getItem(
        window.matchMedia(
          '(max-width:760px),(max-width:960px) and (max-height:560px),(pointer:coarse) and (max-height:560px)',
        ).matches
          ? 'viewer-settings-v2-mobile'
          : 'viewer-settings-v2',
      ) || '{}',
    ),
  );
async function renderedCrosshair(locator: Locator) {
  return locator.evaluate((svg) => ({
    viewBox: svg.getAttribute('viewBox'),
    opacity: svg.querySelector(':scope > g')?.getAttribute('opacity'),
    layers: [...svg.querySelectorAll('[data-crosshair-layer]')].map((layer) => ({
      name: layer.getAttribute('data-crosshair-layer'),
      color: layer.getAttribute('fill'),
      parts: [...layer.querySelectorAll('rect')].map((rect) => ({
        id: rect.getAttribute('data-crosshair-part'),
        x: rect.getAttribute('x'),
        y: rect.getAttribute('y'),
        width: rect.getAttribute('width'),
        height: rect.getAttribute('height'),
      })),
    })),
  }));
}

test('custom crosshair edits use the same live POV geometry, persist, copy safely and reset', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Labeled synthetic practice replay.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPractice(page);
  await chooseCamera(page, 'en', 'Player perspective');
  const live = page.locator('.viewer-crosshair:not(.is-preview)');
  await expect(live).toBeVisible();
  await openOptions(page);
  await selectOptionsCategory(page, 'Crosshair');
  const preview = page.getByRole('img', { name: 'Custom crosshair preview', exact: true });
  const hex = page.getByRole('textbox', { name: 'Crosshair hex color', exact: true });
  await expect(
    page.getByText('This custom crosshair is saved on this device.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Crosshair source', exact: true })).toHaveText(
    'Your crosshair',
  );
  await hex.fill('#f45e8a');
  for (const [name, value] of [
    ['Crosshair length', '10.5'],
    ['Crosshair thickness', '3'],
    ['Crosshair gap', '4'],
    ['Crosshair opacity', '0.65'],
  ])
    await page.getByRole('slider', { name, exact: true }).fill(value);
  await page.getByRole('switch', { name: 'Crosshair outline', exact: true }).check();
  await page.getByRole('slider', { name: 'Outline thickness', exact: true }).fill('2');
  await page.getByRole('switch', { name: 'Center dot', exact: true }).check();
  await page.getByRole('switch', { name: 'T-style crosshair', exact: true }).check();
  const edited = {
    color: '#f45e8a',
    length: 10.5,
    thickness: 3,
    gap: 4,
    opacity: 0.65,
    outline: true,
    outlineWidth: 2,
    centerDot: true,
    tStyle: true,
  };
  await expect.poll(async () => (await saved(page)).crosshairStyle).toEqual(edited);
  expect(await renderedCrosshair(preview)).toEqual(await renderedCrosshair(live));
  await expect(preview.locator('[data-crosshair-layer="fill"]')).toHaveAttribute(
    'fill',
    edited.color,
  );
  await expect(preview.locator(':scope > g')).toHaveAttribute('opacity', '0.65');
  await expect(preview.locator('[data-crosshair-layer="fill"] rect')).toHaveCount(4);
  await expect(
    preview.locator('[data-crosshair-layer="fill"] [data-crosshair-part="top"]'),
  ).toHaveCount(0);
  await expect(
    preview.locator('[data-crosshair-layer="fill"] [data-crosshair-part="dot"]'),
  ).toHaveCount(1);
  await expect(preview.locator('[data-crosshair-layer="outline"] rect')).toHaveCount(4);
  await expect(
    preview.locator('[data-crosshair-layer="fill"] [data-crosshair-part="right"]'),
  ).toHaveAttribute('width', '10.5');
  await expect(
    preview.locator('[data-crosshair-layer="fill"] [data-crosshair-part="right"]'),
  ).toHaveAttribute('height', '3');
  const enabled = page.getByRole('switch', { name: /^Crosshair\s*Show a centered crosshair/ });
  await enabled.uncheck();
  await expect(live).toHaveCount(0);
  await expect(preview).toBeVisible();
  await enabled.check();
  await expect(live).toHaveCount(1);
  await closeOptions(page);
  await page.reload();
  await chooseCamera(page, 'en', 'Player perspective');
  await openOptions(page);
  await selectOptionsCategory(page, 'Crosshair');
  await expect(hex).toHaveValue('#f45e8a');
  await expect(page.getByRole('slider', { name: 'Crosshair gap', exact: true })).toHaveValue('4');
  expect(await renderedCrosshair(preview)).toEqual(await renderedCrosshair(live));
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copiedCrosshair = text;
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Copy custom preset', exact: true }).click();
  await expect(page.getByText('Custom preset copied.', { exact: true })).toHaveAttribute(
    'role',
    'status',
  );
  const copied = JSON.parse(await page.evaluate(() => (window as any).__copiedCrosshair));
  expect(copied).toEqual({ format: 'cswatch-crosshair', version: 1, style: edited });
  await expect(
    page.getByText('A cswatch JSON preset, not a CS2 share code.', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Explicit test clipboard denial');
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Copy custom preset', exact: true }).click();
  const fallback = page.getByRole('textbox', { name: 'Copy this cswatch preset', exact: true });
  await expect(fallback).toBeVisible();
  expect(JSON.parse(await fallback.inputValue())).toEqual(copied);
  await fallback.focus();
  expect(
    await fallback.evaluate((node) => {
      const input = node as HTMLTextAreaElement;
      return input.selectionStart === 0 && input.selectionEnd === input.value.length;
    }),
  ).toBe(true);
  await page.getByRole('button', { name: 'Reset crosshair', exact: true }).click();
  await expect(fallback).toHaveCount(0);
  await expect(hex).toHaveValue('#c6f24e');
  await expect(preview.locator('[data-crosshair-layer="fill"] rect')).toHaveCount(4);
  await expect(preview.locator('[data-crosshair-layer="outline"] rect')).toHaveCount(0);
  await expect(
    preview.locator('[data-crosshair-layer="fill"] [data-crosshair-part="top"]'),
  ).toHaveCount(1);
  await expect(
    preview.locator('[data-crosshair-layer="fill"] [data-crosshair-part="dot"]'),
  ).toHaveCount(0);
  expect(await renderedCrosshair(preview)).toEqual(await renderedCrosshair(live));
  await hex.fill('#zzzzzz');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await expect(preview.locator('[data-crosshair-layer="fill"]')).toHaveAttribute('fill', '#c6f24e');
  await page.getByRole('slider', { name: 'Crosshair length', exact: true }).focus();
  await expect(hex).toHaveValue('#c6f24e');
  await expect(hex).toHaveAttribute('aria-invalid', 'false');
});

test('stale clipboard results cannot replace a newer crosshair preset or survive an editor close', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Labeled synthetic practice replay.');
  await openPractice(page);
  await chooseCamera(page, 'en', '2D tactical · low power');
  await openOptions(page);
  await selectOptionsCategory(page, 'Crosshair');
  await page.evaluate(() => {
    (window as any).__pendingCrosshairWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) =>
          new Promise<void>((resolve, reject) => {
            (window as any).__pendingCrosshairWrites.push({
              text,
              resolve,
              reject: () => reject(new Error('Explicit delayed clipboard denial')),
            });
          }),
      },
    });
  });
  const copy = page.getByRole('button', { name: 'Copy custom preset', exact: true });
  const hex = page.getByRole('textbox', { name: 'Crosshair hex color', exact: true });
  const fallback = page.getByRole('textbox', { name: 'Copy this cswatch preset', exact: true });
  const success = page.getByText('Custom preset copied.', { exact: true });
  const settle = (index: number, outcome: 'resolve' | 'reject') =>
    page.evaluate(
      async ({ index, outcome }) => {
        (window as any).__pendingCrosshairWrites[index][outcome]();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      },
      { index, outcome },
    );

  await copy.click(); // Attempt 0: invalidated by editing the style.
  await hex.fill('#12ab34');
  await settle(0, 'reject');
  await expect(fallback).toHaveCount(0);
  await expect(success).toHaveCount(0);

  await copy.click(); // Attempt 1: an older permission prompt remains pending.
  await hex.fill('#ab1234');
  await copy.click(); // Attempt 2: the current style, rejected before attempt 1 settles.
  await settle(2, 'reject');
  await expect(fallback).toBeVisible();
  const currentPreset = JSON.parse(await fallback.inputValue());
  expect(currentPreset).toEqual({
    format: 'cswatch-crosshair',
    version: 1,
    style: (await saved(page)).crosshairStyle,
  });
  expect(currentPreset.style.color).toBe('#ab1234');
  await settle(1, 'resolve');
  await expect(success).toHaveCount(0);
  expect(JSON.parse(await fallback.inputValue())).toEqual(currentPreset);

  // A newer request also supersedes an older request without a style change.
  await copy.click(); // Attempt 3.
  await copy.click(); // Attempt 4.
  await expect(fallback).toHaveCount(0);
  await settle(4, 'resolve');
  await expect(success).toBeVisible();
  await settle(3, 'reject');
  await expect(success).toBeVisible();
  await expect(fallback).toHaveCount(0);

  await copy.click(); // Attempt 5: closing invalidates its pending permission result.
  await closeOptions(page);
  await openOptions(page);
  await selectOptionsCategory(page, 'Crosshair');
  await settle(5, 'reject');
  await expect(success).toHaveCount(0);
  await expect(fallback).toHaveCount(0);
  await expect(hex).toHaveValue('#ab1234');
});

async function fovPixels(page: Page, info: TestInfo, fov: number, name: string) {
  await openOptions(page);
  await selectOptionsCategory(page, 'Camera');
  await page.getByRole('slider', { name: 'Vertical field of view', exact: true }).fill(String(fov));
  await closeOptions(page);
  await expect.poll(async () => (await saved(page)).cameraFov).toBe(fov);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const image = await page.locator('.viewer-stage canvas').screenshot();
  await info.attach(name, { body: image, contentType: 'image/png' });
  return createHash('sha256').update(image).digest('hex');
}

test('vertical FOV changes real 3D camera pixels reversibly rather than only saving a preference', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Labeled original practice scene.');
  await page.setViewportSize({ width: 960, height: 640 });
  await openPractice(page);
  await expect(page.locator('.viewer-stage canvas')).toBeVisible();
  await chooseCamera(page, 'en', 'Free camera');
  await expect(page.locator('.scene')).toHaveAttribute('data-camera-mode', 'orbit');
  // The canvas screenshot includes composited DOM. Isolate the world lens
  // from text settling and the label layout, which have separate checks.
  await openOptions(page);
  await page.getByRole('switch', { name: /^Player names and health/ }).uncheck();
  await closeOptions(page);
  const narrow = await fovPixels(page, info, 40, 'original-practice-camera-40');
  const wide = await fovPixels(page, info, 110, 'original-practice-camera-110');
  const narrowAgain = await fovPixels(page, info, 40, 'original-practice-camera-40-restored');
  expect(wide).not.toBe(narrow);
  expect(narrowAgain).toBe(narrow);
  await page.reload();
  await openOptions(page);
  await selectOptionsCategory(page, 'Camera');
  await expect(
    page.getByRole('slider', { name: 'Vertical field of view', exact: true }),
  ).toHaveValue('40');
});

for (const language of ['en', 'fr'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${language}/${theme}: category keyboard navigation and every settings panel fit narrow and short screens`, async ({
      page,
    }) => {
      test.skip(Boolean(process.env.E2E_PRIVATE), 'Labeled synthetic practice replay.');
      await page.setViewportSize({ width: 1440, height: 900 });
      await openPractice(page, language, theme);
      await chooseCamera(page, language, '2D tactical · low power');
      for (const size of [
        { width: 320, height: 740 },
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 844, height: 390 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(size);
        await openOptions(page);
        const dialog = page.getByRole('dialog', {
          name: message(language, 'Viewer options'),
          exact: true,
        });
        const tab = (key: OptionsCategory) =>
          page.getByRole('tab', { name: message(language, key), exact: true });
        await expect(tab('Visuals')).toHaveAttribute('aria-selected', 'true');
        await tab('Visuals').focus();
        await page.keyboard.press('ArrowRight');
        await expect(tab('Crosshair')).toBeFocused();
        await expect(tab('Crosshair')).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('End');
        await expect(tab('Performance')).toBeFocused();
        await page.keyboard.press('Home');
        await expect(tab('Visuals')).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(tab('Performance')).toBeFocused();
        for (const category of [
          'Visuals',
          'Crosshair',
          'Playback',
          'Camera',
          'Performance',
        ] as const) {
          await selectOptionsCategory(page, category);
          const panel = page.getByRole('tabpanel', {
            name: message(language, category),
            exact: true,
          });
          expect(
            await dialog.evaluate((node) => {
              const box = node.getBoundingClientRect();
              return (
                box.left >= 0 &&
                box.top >= 0 &&
                box.right <= innerWidth + 1 &&
                box.bottom <= innerHeight + 1 &&
                node.scrollWidth <= node.clientWidth + 1
              );
            }),
            `${category} modal must fit ${size.width}x${size.height}`,
          ).toBe(true);
          expect(
            await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
            `${category} must not clip horizontally`,
          ).toBe(true);
          await expect(
            page.getByRole('button', {
              name: message(language, 'Review communications'),
              exact: true,
            }),
          ).toBeVisible();
        }
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeFocused();
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        ).toBe(true);
      }
    });
