import { expect, test } from '@playwright/test';
import { equipmentIconKey, validateEquipmentIcons } from '../src/equipment-icons';
import { installMapFixture } from './fixtures/map-assets';
import { originalEnvironmentPNG, originalMapReplay, qaMap } from './fixtures/original-map';

test('equipment artwork admits only exact registry identities and local paths', () => {
  expect(equipmentIconKey('weapon_m4a1')).toBe('m4a1');
  expect(equipmentIconKey('M4A4')).toBe('m4a1');
  expect(equipmentIconKey('M4A1-S')).toBe('m4a1silencer');
  expect(validateEquipmentIcons({ icons: { ak47: '/api/assets/equipment/ak47.png' } })).toEqual({
    ak47: '/api/assets/equipment/ak47.png',
  });
  for (const value of [
    { icons: { ak47: 'https://untrusted.invalid/ak47.png' } },
    { icons: { ak47: '/api/assets/equipment/awp.png' } },
    { icons: { invented: '/api/assets/equipment/invented.png' } },
    JSON.parse('{"icons":{"__proto__":"/api/assets/equipment/ak47.png"}}'),
    { icons: [] },
    { icons: {}, complete: 'true' },
  ])
    expect(() => validateEquipmentIcons(value)).toThrow();
});

test('a mounted viewer replaces recorded weapon text when its artwork is prepared later', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  let discoveries = 0;
  await page.addInitScript(() => {
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({ economy: true, autoHideControls: false }),
    );
  });
  const id = 'original-late-artwork';
  await installMapFixture(page, qaMap, id);
  await page.route(`**/api/demos/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name: 'Original artwork availability fixture',
        status: 'ready',
        owned: false,
        public: true,
        source: 'synthetic-qa',
        map: qaMap,
      },
    }),
  );
  await page.route(`**/api/demos/${id}/playback`, (route) =>
    route.fulfill({ json: originalMapReplay() }),
  );
  await page.route('**/api/assets/equipment', (route) => {
    discoveries++;
    return route.fulfill({
      json: {
        icons: discoveries === 1 ? {} : { ak47: '/api/assets/equipment/ak47.png' },
        complete: discoveries > 1,
      },
    });
  });
  await page.route('**/api/assets/equipment/ak47.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: originalEnvironmentPNG(0),
    }),
  );
  await page.goto('/watch/' + id);
  const row = page.locator('.broadcast-player').first();
  await expect(row.locator('.equipment-text-fallback')).toHaveText('AK-47');
  await expect(row.locator('.equipment-text-fallback')).toHaveCount(0);
  await expect(row.locator('.broadcast-weapon-identity .equipment-game-icon')).toHaveCSS(
    'mask-image',
    /\/api\/assets\/equipment\/ak47\.png/,
  );
  expect(discoveries).toBeGreaterThanOrEqual(2);
});
