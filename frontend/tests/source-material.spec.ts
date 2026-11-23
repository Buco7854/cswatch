import { chooseCameraControl } from './fixtures/viewer-transport';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { manualMapAssets } from './fixtures/map-assets';
import {
  installOriginalCameraProbe,
  originalFloorPixel as pixel,
} from './fixtures/original-camera';
import { expect, test, type Page } from '@playwright/test';
import {
  originalMapGLB,
  originalMapReplay,
  originalOverviewPNG,
  originalEnvironmentPNG,
  qaMap,
  qaOverview,
  qaEnvironment,
} from './fixtures/original-map';
import type { MapCubeFog, MapEnvironment } from '../../shared/map-assets';

const fog: MapCubeFog = {
  blend: 'multiply',
  start: 0,
  end: 1,
  exponent: 1,
  height: null,
  maxOpacity: 1,
  lodBias: 1,
  brightness: 1,
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};
async function overhead(page: Page) {
  await chooseCameraControl(page, 'Overhead');
}
async function install(
  page: Page,
  environment: () => MapEnvironment,
  source: 'exact' | 'name-only' | 'vertex-light' = 'exact',
) {
  await installOriginalCameraProbe(page);
  await page.addInitScript(() => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings-v2',
      JSON.stringify({
        quality: 'high',
        autoHideControls: false,
        crosshair: false,
        matchScore: false,
        killReplay: false,
        grenadeLanding: false,
      }),
    );
  });
  await page.route('**/api/demos/original-source-material', (route) =>
    route.fulfill({
      json: {
        id: 'original-source-material',
        name: 'Original synthetic material QA, not CS2 artwork',
        status: 'ready',
        public: true,
        owned: false,
        map: qaMap,
      },
    }),
  );
  const replay = originalMapReplay();
  replay.frames = replay.frames.map((frame) => ({
    ...frame,
    players: frame.players.map((player) => ({ ...player, weapon: '' })),
  }));
  await page.route('**/api/demos/original-source-material/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await page.route('**/api/demos/original-source-material/map-assets', (route) =>
    route.fulfill({
      json: manualMapAssets({
        model: `/map-assets/${qaMap}/desktop/scene.glb`,
        mobile: null,
        overview: qaOverview,
        environment: environment(),
      }),
    }),
  );
  await page.route(`**/api/maps/${qaMap}/overview.png`, (route) =>
    route.fulfill({ contentType: 'image/png', body: originalOverviewPNG() }),
  );
  await page.route(`**/map-assets/${qaMap}/desktop/scene.glb`, (route) =>
    route.fulfill({
      contentType: 'model/gltf-binary',
      body: originalMapGLB(
        false,
        undefined,
        'tagged',
        source === 'vertex-light' ? undefined : source,
        source === 'vertex-light',
      ),
    }),
  );
  await page.route(`**/api/maps/${qaMap}/environment/*.png`, (route) => {
    const face = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].indexOf(
      new URL(route.request().url()).pathname.split('/').pop()!.replace('.png', ''),
    );
    return route.fulfill({ contentType: 'image/png', body: originalEnvironmentPNG(face) });
  });
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
}
async function open(page: Page) {
  await page.goto('/watch/original-source-material');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute('data-landscape-state', 'ready');
  await overhead(page);
}
async function remount(page: Page) {
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'ready');
  await overhead(page);
}
test('exact Source black material compiles authored cube fog while retaining opaque main-world depth', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let environment: MapEnvironment = { ...qaEnvironment };
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await install(page, () => environment);
  await open(page);
  await expect
    .poll(async () => (await pixel(page)).every((channel) => channel < 15), {
      message: 'No authored fog keeps exact opaque black in front of blue sky geometry',
    })
    .toBe(true);
  environment = { ...qaEnvironment, assetVersion: 'original-qa-fog-v1', fog };
  await remount(page);
  await expect
    .poll(
      async () => {
        const color = await pixel(page);
        return color[0] > 100 && color[1] > 100 && color[2] < 100;
      },
      {
        message: 'The actual compiled opaque shader samples the authored downward yellow cube face',
      },
    )
    .toBe(true);
  const full = await pixel(page);
  environment = {
    ...environment,
    assetVersion: 'original-qa-fog-v2',
    fog: { ...fog, maxOpacity: 0.5, rotation: [1, 0, 0, 0, 0, 1, 0, -1, 0] },
  };
  await remount(page);
  await expect
    .poll(
      async () => {
        const color = await pixel(page);
        return color[0] < 80 && color[1] > 100 && Math.abs(color[1] - color[2]) < 5;
      },
      {
        message:
          'Authored relative rotation selects cyan, opacity dims RGB without revealing blue terrain behind',
      },
    )
    .toBe(true);
  expect((await pixel(page))[1]).toBeLessThan(full[1] - 15);
  environment = {
    ...environment,
    assetVersion: 'original-qa-fog-height',
    fog: { ...fog, height: { start: -2, end: -1, exponent: 2 } },
  };
  await remount(page);
  await expect
    .poll(async () => (await pixel(page)).every((channel) => channel < 15), {
      message: 'Authored height range excludes the main floor without making it transparent',
    })
    .toBe(true);
  environment = {
    ...environment,
    assetVersion: 'original-qa-fog-distance1',
    fog: { ...fog, end: 250, exponent: 1 },
  };
  await remount(page);
  const first = await pixel(page);
  environment = {
    ...environment,
    assetVersion: 'original-qa-fog-distance2',
    fog: { ...fog, end: 250, exponent: 2 },
  };
  await remount(page);
  await expect
    .poll(async () => (await pixel(page))[1], {
      message: 'Authored distance power affects real shader pixels',
    })
    .toBeLessThan(first[1] - 15);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('original-QA-opaque-source-fog.png') });
});
test('a matching display name and white PBR color do not classify an unrelated Source material', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let environment: MapEnvironment = qaEnvironment;
  await install(page, () => environment, 'name-only');
  await open(page);
  const reference = await pixel(page);
  expect(Math.max(...reference)).toBeGreaterThan(24);
  environment = { ...qaEnvironment, fog };
  await remount(page);
  await expect
    .poll(async () =>
      Math.max(
        ...(await pixel(page)).map((channel, index) => Math.abs(channel - reference[index])),
      ),
    )
    .toBeLessThan(5);
});

test('a prepared Source COLOR1 stream supplies indirect light to the real shader', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await install(page, () => qaEnvironment, 'vertex-light');
  await open(page);
  await expect
    .poll(async () => {
      const [red, green, blue] = await pixel(page);
      return red - Math.max(green, blue);
    })
    .toBeGreaterThan(40);
  expect(errors).toEqual([]);
});
