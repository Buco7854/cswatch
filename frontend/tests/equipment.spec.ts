import { test, expect, type Page } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';

// An original one-pixel raster exercises transport only. No game artwork is a fixture.
const chunk = (type: string, data: Buffer) => {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const syntheticPng = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
  chunk('IEND', Buffer.alloc(0)),
]);

async function enableEquipment(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({ economy: true, inputs: false, quality: 'low' }),
    ),
  );
  await page.route('**/api/assets/equipment/*.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: syntheticPng }),
  );
}

test('many glyphs share one equipment manifest and ignore external artwork URLs', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await enableEquipment(page);
  let manifests = 0,
    externalRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('untrusted.invalid')) externalRequests++;
  });
  await page.route('**/api/assets/equipment', (route) => {
    manifests++;
    return route.fulfill({
      json: {
        icons: {
          m4a1: '/api/assets/equipment/m4a1.png',
          ak47: 'https://untrusted.invalid/ak47.png',
        },
      },
    });
  });
  await page.goto('/watch/sample');
  const hud = page.getByRole('complementary', { name: 'Analysis HUD', exact: true });
  await expect(
    hud.locator('.broadcast-bank[data-team="3"] .equipment-game-icon.is-weapon'),
  ).toHaveCount(5);
  await expect(
    hud.locator('.broadcast-bank[data-team="2"] .equipment-game-icon.is-weapon'),
  ).toHaveCount(0);
  await expect(
    hud.locator('.broadcast-bank[data-team="2"] svg.equipment-glyph.is-weapon'),
  ).toHaveCount(5);
  expect(manifests).toBe(1);
  expect(externalRequests).toBe(0);
});

test('equipment lookup retries a denied manifest on the next viewer mount', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await enableEquipment(page);
  let manifests = 0;
  await page.route('**/api/assets/equipment', (route) => {
    manifests++;
    return manifests === 1
      ? route.fulfill({ status: 401, json: { error: 'Explicit test denial' } })
      : route.fulfill({ json: { icons: { m4a1: '/api/assets/equipment/m4a1.png' } } });
  });
  await page.goto('/watch/sample');
  await expect.poll(() => manifests).toBe(1);
  await expect(page.locator('.broadcast-bank .equipment-game-icon')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to library', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.getByRole('link', { name: 'Try the viewer', exact: true }).click();
  await expect(
    page.locator('.broadcast-bank[data-team="3"] .equipment-game-icon.is-weapon'),
  ).toHaveCount(5);
  expect(manifests).toBe(2);
});

test('right-side lineups stay compact on mobile and their visibility is managed in Options', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await enableEquipment(page);
  await page.route('**/api/assets/equipment', (route) => route.fulfill({ json: { icons: {} } }));
  await page.goto('/watch/sample');
  const hud = page.getByRole('complementary', { name: 'Analysis HUD', exact: true });
  await expect(hud.locator('.broadcast-player')).toHaveCount(10);
  await expect(
    hud.locator('.broadcast-bank-heading,.broadcast-compact-card,.observed-player'),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(hud.locator('.broadcast-lineups-open,.broadcast-lineups-close')).toHaveCount(0);
  await expect(hud.locator('.broadcast-player').first()).toBeVisible();
  await hud.locator('.broadcast-player[data-player-id="6"] button').click();
  await expect(hud.locator('.broadcast-player button[aria-pressed="true"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('switch', { name: /^Economy and loadouts/ }).uncheck();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await expect(hud).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('switch', { name: /^Economy and loadouts/ }).check();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await expect(hud.locator('.broadcast-player button[aria-pressed="true"]')).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(hud.locator('.broadcast-player').last()).toBeVisible();
  await expect(hud.locator('.broadcast-player button[aria-pressed="true"]')).toHaveCount(1);
});

test('native demo artwork differentiates selected kills, deaths and objective symbols with an honest fallback', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await enableEquipment(page);
  let installed = true;
  const keys = [
    'demokill',
    'demodeath',
    'bombplanted',
    'bombdefused',
    'bombexploded',
    'teamct',
    'teamt',
    'roundmarker',
  ];
  await page.route('**/api/assets/equipment', (route) =>
    route.fulfill({
      json: {
        icons: installed
          ? Object.fromEntries(keys.map((key) => [key, `/api/assets/equipment/${key}.png`]))
          : {},
      },
    }),
  );
  await page.goto('/watch/sample');
  const markers = page.locator('.timeline-event-markers');
  for (const key of ['demokill', 'bombplanted', 'bombdefused'])
    await expect(markers.locator(`[data-asset-key="${key}"][data-artwork="operator"]`)).toHaveCount(
      1,
    );
  await page.locator('.broadcast-player[data-player-id="6"] .broadcast-player-select').click();
  await expect(
    markers.locator('[data-asset-key="demodeath"][data-artwork="operator"]'),
  ).toHaveCount(1);
  await expect(markers.locator('[data-asset-key="demokill"]')).toHaveCount(0);
  installed = false;
  await page.reload();
  await expect(
    markers.locator('svg[data-asset-key="demokill"][data-artwork="original-fallback"]'),
  ).toHaveCount(1);
  await expect(markers.locator('[data-artwork="operator"]')).toHaveCount(0);
});
