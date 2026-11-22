import { chooseCameraControl } from './fixtures/viewer-transport';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { manualMapAssets } from './fixtures/map-assets';
import { originalOverviewPNG, qaOverview } from './fixtures/original-map';
import { expect, test, type Page, type Route } from '@playwright/test';
import { originalMapGLB, qaActor } from './fixtures/original-map';
import {
  originalEquipmentCatalog,
  originalEquipmentGLB,
  originalEquipmentReplay,
} from './fixtures/original-equipment';
import type { EquipmentModelCatalog } from '../../shared/equipment-models';

async function camera(page: Page, name: string) {
  await chooseCameraControl(page, name);
}
async function install(
  page: Page,
  options: {
    theme?: string;
    language?: string;
    quality?: string;
    catalog?: EquipmentModelCatalog;
    model?: (id: string, attempt: number, route: Route) => Promise<void>;
    coverage?: boolean;
  } = {},
) {
  const replay = originalEquipmentReplay(),
    counts = new Map<string, number>();
  replay.itemState = {
    complete: false,
    coverage: { dropped: false, planted: true, projectile: options.coverage ?? true },
  };
  await page.addInitScript(
    ({ theme, quality, language }) => {
      localStorage.setItem('theme', theme);
      localStorage.setItem('cswatch.language', language);
      for (const key of ['viewer-settings-v2', 'viewer-settings-v2-mobile'])
        localStorage.setItem(
          key,
          JSON.stringify({
            quality,
            autoHideControls: false,
            matchScore: false,
            killReplay: false,
            grenadeLanding: false,
            crosshair: false,
            xray: false,
            utilities: false,
            trajectories: 'off',
          }),
        );
    },
    {
      theme: options.theme || 'dark',
      quality: options.quality || 'high',
      language: options.language || 'en',
    },
  );
  await page.route('**/api/demos/equipment-model-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'equipment-model-fixture',
        name: 'Original equipment QA, not game artwork',
        status: 'ready',
        owned: false,
        public: true,
        map: replay.map,
      },
    }),
  );
  await page.route('**/api/demos/equipment-model-fixture/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await page.route('**/api/demos/equipment-model-fixture/map-assets', (route) =>
    route.fulfill({
      json: manualMapAssets({
        model: `/map-assets/${replay.map}/desktop/scene.glb`,
        mobile: null,
        overview: { ...qaOverview, image: `/api/maps/${replay.map}/overview.png` },
      }),
    }),
  );
  await page.route(`**/map-assets/${replay.map}/desktop/scene.glb`, (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalMapGLB() }),
  );
  await page.route(`**/api/maps/${replay.map}/overview.png`, (route) =>
    route.fulfill({ contentType: 'image/png', body: originalOverviewPNG() }),
  );
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
  await page.route('**/api/assets/equipment-models', (route) =>
    route.fulfill({ json: options.catalog || originalEquipmentCatalog() }),
  );
  await page.route('**/api/assets/equipment-models/*.glb', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!.replace('.glb', ''),
      attempt = (counts.get(id) || 0) + 1;
    counts.set(id, attempt);
    if (options.model) return options.model(id, attempt, route);
    await route.fulfill({ contentType: 'model/gltf-binary', body: originalEquipmentGLB() });
  });
  return { replay, counts };
}
async function open(page: Page) {
  await page.goto('/watch/equipment-model-fixture?tick=0');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute('data-equipment-model-state', 'ready');
}

test('model catalog completeness is strictly validated, retains partial models on errors and stops discovery after completion', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const start = Date.UTC(2026, 0, 1);
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 60_000);
  await install(page);
  let reads = 0;
  await page.route('**/api/assets/equipment-models', async (route) => {
    reads++;
    if (reads === 1)
      return route.fulfill({ json: { schemaVersion: 2, items: {}, complete: 'true' } });
    if (reads === 2)
      return route.fulfill({ json: { schemaVersion: 2, items: {}, complete: false } });
    if (reads === 4) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: { ...originalEquipmentCatalog(), complete: reads >= 5 } });
  });
  await page.goto('/watch/equipment-model-fixture?tick=0');
  const scene = page.locator('.scene');
  // Admit renderer frames under the paused clock without consuming a catalog retry.
  await expect
    .poll(async () => {
      await page.clock.runFor(160);
      return scene.getAttribute('data-map-model-state');
    })
    .toBe('ready');
  await expect(scene).toHaveAttribute('data-equipment-model-state', 'error');
  await page.clock.runFor(2100);
  await expect.poll(() => reads).toBe(2);
  await expect(scene).toHaveAttribute('data-equipment-model-state', 'missing');
  await page.clock.runFor(5100);
  await expect.poll(() => reads).toBe(3);
  await expect(scene).toHaveAttribute('data-equipment-model-state', 'ready');
  await page.clock.runFor(15100);
  await expect.poll(() => reads).toBe(4);
  await expect(scene).toHaveAttribute('data-equipment-model-state', 'ready');
  await page.clock.runFor(30100);
  await expect.poll(() => reads).toBe(5);
  await expect(scene).toHaveAttribute('data-equipment-model-state', 'ready');
  await page.clock.fastForward(60000);
  expect(reads).toBe(5);
});
async function magentaPixels(page: Page, interior = false) {
  const bytes = await page.locator('.scene canvas').screenshot();
  return page.evaluate(
    async ({ bytes, interior }) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        ),
        surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = surface.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      bitmap.close();
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const x = (i / 4) % surface.width;
        if (
          (!interior || (x > surface.width * 0.5 && x < surface.width * 0.9)) &&
          pixels[i] > 180 &&
          pixels[i + 1] < 80 &&
          pixels[i + 2] > 180
        )
          count++;
      }
      return count;
    },
    { bytes: [...bytes], interior },
  );
}

async function equipmentStatus(page: Page, french = false) {
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page
    .getByRole('tab', { name: french ? 'Performances' : 'Performance', exact: true })
    .click();
  const report = page.getByRole('group', {
    name: french ? 'État des modèles d’équipement' : 'Equipment model status',
    exact: true,
  });
  await report.scrollIntoViewIfNeeded();
  await expect(report).toBeVisible();
  const fits = await report.evaluate((element) => {
    const dialog = element.closest('dialog')!,
      panel = element.closest('[role="tabpanel"]')!,
      box = element.getBoundingClientRect(),
      view = panel.getBoundingClientRect();
    return {
      horizontal:
        dialog.scrollWidth <= dialog.clientWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1,
      vertical: box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
    };
  });
  expect(fits).toEqual({ horizontal: true, vertical: true });
  return report;
}

for (const theme of ['dark', 'light'])
  for (const width of [1440, 390])
    test(`original static equipment coexists with map, all six projectile types, recorded drops/plants and eye-relative POV (${theme},${width})`, async ({
      page,
    }, info) => {
      test.skip(Boolean(process.env.E2E_PRIVATE));
      test.setTimeout(90000);
      await page.setViewportSize({ width, height: 900 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { counts } = await install(page, { theme, quality: width === 390 ? 'low' : 'high' });
      await open(page);
      await camera(page, 'Overhead');
      await page.locator('.timeline-slider').fill('0');
      const scene = page.locator('.scene');
      await expect(scene).toHaveAttribute('data-equipment-ready-count', '10');
      await expect(scene).toHaveAttribute('data-equipment-expected-count', '10');
      await expect(scene).toHaveAttribute('data-equipment-unavailable-count', '0');
      await expect(scene).toHaveAttribute('data-equipment-error-count', '0');
      await expect(scene).toHaveAttribute('data-recorded-world-item-count', '8');
      for (const id of ['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'incgrenade', 'decoy'])
        expect(await scene.getAttribute('data-equipment-ready-instances')).toContain(':' + id);
      expect(await scene.getAttribute('data-equipment-ready-instances')).not.toContain(
        'trajectory-projectile:',
      );
      expect(counts.get('ak47'), 'two held and one dropped instance share one decoded asset').toBe(
        1,
      );
      expect(counts.has('c4'), 'unused catalog entries do not load').toBe(false);
      await camera(page, 'Player perspective');
      await expect(scene).toHaveAttribute(
        'data-equipment-ready-instances',
        new RegExp('pov:' + qaActor + ':ak47'),
      );
      expect(await scene.getAttribute('data-equipment-ready-instances')).not.toContain(
        'held:' + qaActor + ':ak47',
      );
      await expect
        .poll(() => magentaPixels(page), {
          message:
            'Original static prop must actually render ahead of the eye, not just report loaded',
        })
        .toBeGreaterThan(100);
      await expect
        .poll(() => magentaPixels(page, true), {
          message:
            'Portrait attachment must remain visibly inside the viewport, not clipped to its edge',
        })
        .toBeGreaterThan(100);
      await page.screenshot({
        path: info.outputPath(`original-equipment-${theme}-${width}-pov.png`),
      });
      await page.locator('.timeline-slider').fill('64');
      await expect(scene).toHaveAttribute('data-recorded-world-item-count', '7');
      await expect(scene).toHaveAttribute('data-equipment-ready-count', '9');
      expect(await scene.getAttribute('data-equipment-ready-instances')).not.toContain(
        'item:item:1:0:0:ak47',
      );
      await page.locator('.timeline-slider').fill('0');
      await expect(scene).toHaveAttribute('data-equipment-ready-count', '10');
      await camera(page, '2D tactical · low power');
      await expect(page.locator('.tactical-plot')).toBeVisible();
      await camera(page, 'Player perspective');
      await expect(scene).toHaveAttribute('data-equipment-ready-count', '10');
      await expect.poll(() => magentaPixels(page)).toBeGreaterThan(100);
      expect(counts.get('ak47')).toBe(1);
      expect(errors).toEqual([]);
    });

test('failed equipment is isolated from map and other models, retains low-tier grenade fallback and retries on the next viewer', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  const { counts } = await install(page, {
    quality: 'low',
    model: async (id, attempt, route) => {
      await route.fulfill({
        contentType: 'model/gltf-binary',
        body:
          id === 'smokegrenade' && attempt === 1
            ? Buffer.from('Original malformed QA GLB')
            : originalEquipmentGLB(),
      });
    },
  });
  await open(page);
  await camera(page, 'Overhead');
  await page.locator('.timeline-slider').fill('0');
  const scene = page.locator('.scene');
  await expect(scene).toHaveAttribute('data-equipment-error-count', '1');
  await expect(scene).toHaveAttribute('data-equipment-ready-count', '9');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  await expect(scene).toHaveAttribute('data-quality', 'low');
  await expect(scene).toHaveAttribute('data-recorded-world-item-count', '8');
  const report = await equipmentStatus(page);
  await expect(
    report
      .locator('dl div')
      .filter({ has: page.getByText('Failed models', { exact: true }) })
      .locator('dd'),
  ).toHaveText('1');
  await expect(
    report.getByText(
      'Held models follow an installed character’s weapon bone when available. POV models use approximate presets without first-person arms or recoil.',
    ),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('equipment-status-phone-dark.png') });
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await camera(page, 'Overhead');
  await page.locator('.timeline-slider').fill('0');
  await expect(scene).toHaveAttribute('data-equipment-ready-count', '10');
  await expect(scene).toHaveAttribute('data-equipment-error-count', '0');
  expect(counts.get('smokegrenade')).toBe(2);
});

test('missing model packs expose availability without fake bodies and incomplete projectile coverage preserves the trajectory-based body', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  const { counts } = await install(page, {
    theme: 'light',
    language: 'fr',
    catalog: originalEquipmentCatalog(['ak47']),
    coverage: false,
  });
  await open(page);
  await chooseCameraControl(page, 'Vue du dessus', 'Mode de caméra');
  await page.locator('.timeline-slider').fill('0');
  const scene = page.locator('.scene');
  await expect(scene).toHaveAttribute('data-equipment-ready-count', '3');
  await expect(scene).toHaveAttribute('data-equipment-expected-count', '5');
  await expect(scene).toHaveAttribute('data-equipment-unavailable-count', '2');
  await expect(scene).toHaveAttribute('data-recorded-world-item-count', '2');
  await expect(scene).toHaveAttribute('data-projectile-count', '1');
  expect([...counts.keys()]).toEqual(['ak47']);
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  const report = await equipmentStatus(page, true);
  await expect(
    report
      .locator('dl div')
      .filter({ has: page.getByText('Modèles indisponibles', { exact: true }) })
      .locator('dd'),
  ).toHaveText('2');
  await page.screenshot({ path: info.outputPath('equipment-status-phone-light-french.png') });
});
