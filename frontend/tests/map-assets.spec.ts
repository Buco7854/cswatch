import { selectOptionsCategory } from './fixtures/viewer-options';
import { accountStatus, configForSyntheticAccount } from './fixtures/account-status';
import { chooseSelectOption } from './fixtures/select-control';
import { chooseCameraControl, expectCameraControl } from './fixtures/viewer-transport';
import { fulfillReplayFixture, replayFixture } from './fixtures/streamed-replay';
import { manualMapAssets } from './fixtures/map-assets';
import { nativeMap } from './fixtures/native-map';
import { installMemberWorkspace, memberUser } from './fixtures/member-workspace';
import { installOriginalCameraProbe, originalFloorPixel } from './fixtures/original-camera';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  originalEnvironmentPNG,
  originalMapReplay,
  originalOverviewPNG,
  qaActor,
  qaMap,
  qaOverview,
} from './fixtures/original-map';
import type { MapAssets } from '../../shared/map-assets';

const image = originalOverviewPNG();
async function install(
  page: Page,
  assets: MapAssets,
  options: {
    theme?: string;
    language?: string;
    id?: string;
    map?: string;
    model?: (route: Route) => Promise<void>;
    image?: (route: Route) => Promise<void>;
    playback?: ReturnType<typeof originalMapReplay>;
    crosshair?: boolean;
    quality?: string;
    renderResolution?: number;
  } = {},
) {
  const map = options.map || qaMap,
    id = options.id || 'original-map-fixture';
  let discoveries = 0,
    models = 0;
  const world = nativeMap(map);
  const resolved = assets.model ? { ...assets, model: world.model(id) } : assets;
  await page.addInitScript(
    ({ theme, crosshair, language, quality, renderResolution }) => {
      localStorage.setItem('theme', theme);
      localStorage.setItem('cswatch.language', language);
      ['viewer-settings-v2', 'viewer-settings-v2-mobile'].forEach((key) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            quality,
            renderResolution,
            autoHideControls: false,
            matchScore: false,
            killReplay: false,
            grenadeLanding: false,
            crosshair,
          }),
        ),
      );
    },
    {
      theme: options.theme || 'dark',
      crosshair: options.crosshair ?? false,
      language: options.language || 'en',
      quality: options.quality || 'high',
      renderResolution: options.renderResolution,
    },
  );
  await page.route(`**/api/demos/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name: 'Original synthetic QA map, not CS2 content',
        status: 'ready',
        owned: false,
        public: true,
        source: 'synthetic-qa',
        map,
      },
    }),
  );
  await page.route(`**/api/demos/${id}/playback`, (route) =>
    fulfillReplayFixture(route, options.playback || originalMapReplay(map)),
  );
  await page.route(`**/api/demos/${id}/map-assets`, (route) => {
    discoveries++;
    return route.fulfill({ json: manualMapAssets(resolved) });
  });
  await page.route(`**/api/maps/${map}/overview.png`, (route) =>
    options.image ? options.image(route) : route.fulfill({ contentType: 'image/png', body: image }),
  );
  await world.route(page);
  await page.route(`**/api/demos/${id}/world/**/map.json`, (route) => {
    models++;
    return options.model ? options.model(route) : route.fallback();
  });
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
  return {
    id,
    get discoveries() {
      return discoveries;
    },
    get models() {
      return models;
    },
  };
}
async function open(page: Page, id = 'original-map-fixture') {
  const response = await page.goto('/watch/' + id);
  await expect(page.locator('.timeline-slider')).toBeVisible();
  return response;
}
/** Report matching compressed texture extensions as unavailable, before the app's first context. */
async function hideTextureExtensions(page: Page, hidden: RegExp) {
  await page.addInitScript((source) => {
    const pattern = new RegExp(source);
    const gl = WebGL2RenderingContext.prototype;
    const getExtension = gl.getExtension;
    gl.getExtension = function (name: string) {
      return pattern.test(name) ? null : getExtension.call(this, name);
    } as typeof getExtension;
  }, hidden.source);
}
for (const [language, message] of [
  ['en', 'This device lacks the texture support needed for 3D'],
  ['fr', 'Cet appareil ne prend pas en charge les textures nécessaires à la 3D'],
] as const)
  for (const theme of ['light', 'dark'])
    test(`without BC or ASTC textures the viewer shows the 2D map and explains why (${language}, ${theme})`, async ({
      page,
    }) => {
      test.skip(Boolean(process.env.E2E_PRIVATE));
      await install(page, { model: 'native', overview: qaOverview }, { language, theme });
      await hideTextureExtensions(page, /^(EXT_texture_compression_|WEBGL_compressed_texture_)/);
      await open(page);
      await expect(page.locator('.viewer-map-status')).toHaveText(message);
      await expect(page.locator('.scene')).not.toHaveAttribute('data-map-tier', /./);
      await expect(page.locator('.tactical-plot')).toBeVisible();
    });
async function setRendererEvidence(page: Page, adapter: string) {
  await page.addInitScript((adapter) => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 });
    const gl = WebGL2RenderingContext.prototype;
    const getExtension = gl.getExtension;
    const getParameter = gl.getParameter;
    gl.getExtension = function (name: string) {
      return name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
        : getExtension.call(this, name);
    } as typeof getExtension;
    gl.getParameter = function (name: number) {
      return name === 0x9246 ? adapter : getParameter.call(this, name);
    };
  }, adapter);
}

test.describe('dense displays', () => {
  test.use({ deviceScaleFactor: 3 });
  test('a phone keeps detailed textures and renders above CSS resolution within its pixel budget on rotation', async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    await page.setViewportSize({ width: 390, height: 844 });
    await setRendererEvidence(page, 'ANGLE (Qualcomm, Adreno 740)');
    await install(
      page,
      {
        model: 'native',
        overview: qaOverview,
      },
      { quality: 'auto' },
    );
    await hideTextureExtensions(
      page,
      /^(EXT_texture_compression_(bptc|rgtc)|WEBGL_compressed_texture_s3tc)/,
    );
    await open(page);
    await expect(page.locator('.scene')).toHaveAttribute('data-map-tier', 'phone');
    await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
    const buffer = () =>
      page.locator('.scene canvas').evaluate((el) => {
        const gl = (el as HTMLCanvasElement).getContext('webgl2')!;
        return [gl.drawingBufferWidth, gl.drawingBufferHeight];
      });
    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [1280, 720],
      [390, 400],
    ]) {
      await page.setViewportSize({ width, height });
      const ratio = Math.min(2, Math.sqrt(1024 ** 2 / (width * height)));
      await expect.poll(buffer).toEqual([Math.floor(width * ratio), Math.floor(height * ratio)]);
    }
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await selectOptionsCategory(page, 'Performance');
    await chooseSelectOption(page, 'Rendering quality', 'High · shadows, higher resolution');
    await expect(page.locator('.scene')).toHaveAttribute('data-map-tier', 'phone');
    await expect.poll(buffer).toEqual([1170, 1200]);
    await page.setViewportSize({ width: 1280, height: 720 });
    // Wide and narrow layouts have independent saved quality preferences.
    await expect(page.getByRole('combobox', { name: 'Rendering quality' })).toContainText('Auto');
    await chooseSelectOption(page, 'Rendering quality', 'High · shadows, higher resolution');
    const highDpr = Math.sqrt((4 * 1024 ** 2) / (1280 * 720));
    await expect.poll(buffer).toEqual([Math.floor(1280 * highDpr), Math.floor(720 * highDpr)]);
  });
  test('the explicit 50% ceiling preserves the same pixel dimensions when playback starts', async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    await page.setViewportSize({ width: 390, height: 400 });
    await setRendererEvidence(page, 'ANGLE (Qualcomm, Adreno 740)');
    const replay = originalMapReplay();
    replay.frames[1].tick = 6400;
    await install(
      page,
      { model: null, model: 'native', overview: null },
      { quality: 'auto', renderResolution: 50, playback: replay },
    );
    await open(page);
    const scene = page.locator('.scene');
    await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
    const width = () =>
      scene
        .locator('canvas')
        .evaluate(
          (canvas) => (canvas as HTMLCanvasElement).getContext('webgl2')!.drawingBufferWidth,
        );
    await expect.poll(width).toBe(390);
    const timeline = page.locator('.timeline-slider');
    const first = Number(await timeline.inputValue());
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => Number(await timeline.inputValue())).toBeGreaterThan(first);
    await expect.poll(width).toBe(390);
  });
  test('slow playback keeps its learned resolution while buffering and restores detail on pause', async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    await page.setViewportSize({ width: 390, height: 400 });
    await setRendererEvidence(page, 'ANGLE (Qualcomm, Adreno 740)');
    // Deliver a slow, regular browser frame cadence independently of the test host's GPU.
    await page.addInitScript(() => {
      window.requestAnimationFrame = (callback) =>
        window.setTimeout(() => callback(performance.now()), 160);
      window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    });
    const replay = originalMapReplay();
    replay.frames = Array.from({ length: 601 }, (_, index) => ({
      ...replay.frames[0],
      tick: 4 * index,
    }));
    const fixture = await install(
      page,
      { model: null, model: 'native', overview: null },
      { quality: 'auto', playback: replay },
    );
    const { manifest, chunks } = await replayFixture(replay);
    const playbackUrl = `**/api/demos/${fixture.id}/playback`;
    await page.route(playbackUrl, (route) => route.fulfill({ json: manifest }));
    const nextChunk = Promise.withResolvers<void>();
    await page.route(`${playbackUrl}/chunks/*`, async (route) => {
      const index = Number(new URL(route.request().url()).pathname.split('/').at(-1));
      if (index === 1) await nextChunk.promise;
      await route.fulfill({ contentType: 'application/json', body: chunks[index] });
    });
    await open(page, fixture.id + '?tick=1400');
    const scene = page.locator('.scene');
    const width = () =>
      scene
        .locator('canvas')
        .evaluate(
          (canvas) => (canvas as HTMLCanvasElement).getContext('webgl2')!.drawingBufferWidth,
        );
    await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
    await expect.poll(width).toBe(780);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(width, { timeout: 12000 }).toBeLessThan(780);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(width).toBe(780);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(width).toBeLessThan(780);
    try {
      await expect(page.locator('.replay-buffer')).toBeVisible({ timeout: 20000 });
      await expect.poll(width).toBeLessThan(780);
    } finally {
      nextChunk.resolve();
    }
    await expect
      .poll(async () => Number(await page.locator('.timeline-slider').inputValue()))
      .toBeGreaterThan(manifest.chunks[1].startTick);
    await expect.poll(width).toBeLessThan(780);
  });
});
async function camera(page: Page, value: string) {
  await chooseCameraControl(page, value);
}
async function mapPalette(plot: Locator) {
  return plot.evaluate((svg) => {
    const colors = (selector: string) => {
      const element = svg.querySelector(selector);
      return element
        ? { fill: getComputedStyle(element).fill, stroke: getComputedStyle(element).stroke }
        : null;
    };
    return {
      ground: getComputedStyle(svg).backgroundColor,
      plane: colors(':scope > rect'),
      ct: colors('[data-player-id="76561198000000001"] circle'),
      t: colors('[data-player-id="76561198000000002"] circle'),
      grid: colors('.tactical-grid'),
      opacity: getComputedStyle(svg).opacity,
      imageOpacity: svg.querySelector('image')
        ? getComputedStyle(svg.querySelector('image')!).opacity
        : null,
    };
  });
}
async function samplePixel(page: Page, x: number, y: number) {
  const bytes = await page.screenshot({
    clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 },
  });
  return page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        ),
        surface = new OffscreenCanvas(1, 1),
        context = surface.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    },
    [...bytes],
  );
}
async function expectRadarCompositing(page: Page, radar: Locator) {
  const box = (await radar.boundingBox())!,
    painted = await samplePixel(page, box.x + 3, box.y + 3);
  await radar.evaluate((node) => ((node as SVGElement).style.visibility = 'hidden'));
  let underneath: number[];
  try {
    underneath = await samplePixel(page, box.x + 3, box.y + 3);
  } finally {
    await radar.evaluate((node) => (node as SVGElement).style.removeProperty('visibility'));
  }
  for (let channel = 0; channel < 3; channel++)
    expect(
      Math.abs(painted[channel] - underneath![channel] * 0.62),
      'Radar paints one38%black layer over the actual scene',
    ).toBeLessThanOrEqual(3);
}

test('original QA overview aligns players, utility and radar across desktop, tablet, phone and both themes', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let palette: Awaited<ReturnType<typeof mapPalette>> | undefined;
  for (const theme of ['dark', 'light'])
    for (const size of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      const requests = await install(page, { model: 'native', overview: qaOverview }, { theme });
      await open(page);
      const radar = page.locator('.position-radar');
      await expect(radar).toHaveAttribute('data-map-image-state', 'ready');
      await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
      const colors = await mapPalette(radar);
      expect(colors.ground).toBe('rgba(0, 0, 0, 0)');
      expect(colors.plane?.fill).toBe('rgba(0, 0, 0, 0.38)');
      expect(colors.opacity).toBe('1');
      expect(colors.imageOpacity).toBe('1');
      await expectRadarCompositing(page, radar);
      palette ||= colors;
      expect(
        colors,
        'Radar map content must keep its palette across UI themes and devices',
      ).toEqual(palette);
      await expect(radar.locator('image')).toHaveAttribute('href', qaOverview.image);
      await expect(radar.locator(`[data-player-id="${qaActor}"]`)).toHaveAttribute(
        'transform',
        'translate(35 60)',
      );
      await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
      await page.screenshot({
        path: info.outputPath(`original-QA-radar-${theme}-${size.width}.png`),
      });
      await camera(page, '2D tactical · low power');
      const plot = page.locator('.tactical-plot');
      await expect(plot).toHaveAttribute('data-map-image-state', 'ready');
      expect(
        await mapPalette(plot),
        '2D keeps an opaque readable ground and the same map/marker colors',
      ).toEqual({
        ...palette,
        ground: 'rgb(82, 82, 82)',
        plane: { fill: 'rgb(82, 82, 82)', stroke: 'none' },
      });
      await expect(plot.locator(`[data-player-id="${qaActor}"]`)).toHaveAttribute(
        'transform',
        'translate(35 60)',
      );
      await page.locator('.timeline-slider').fill('128');
      await expect(plot.locator('.tactical-projectile')).toHaveAttribute('cx', '60');
      await expect(plot.locator('.tactical-projectile')).toHaveAttribute('cy', '60');
      await page.locator('.timeline-slider').fill('256');
      const smoke = plot.locator('.tactical-utility-zone[data-kind="smoke"]');
      await expect(smoke).toHaveAttribute('cx', '85');
      await expect(smoke).toHaveAttribute('cy', '60');
      expect(Number(await smoke.getAttribute('r'))).toBeCloseTo((146 / 2048) * 100, 6);
      await expect(page.locator('.viewer-map-status')).toHaveText('Map overview');
      expect(requests.discoveries).toBe(1);
      expect(requests.models).toBe(1);
      await page.screenshot({
        path: info.outputPath(`original-QA-overview-${theme}-${size.width}.png`),
      });
    }
});

test('the radar crops the playable bounds without changing recorded positions on the image', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const playback = originalMapReplay();
  playback.worldBounds = { minX: -768, maxX: 768, minY: -512, maxY: 512, minZ: 0, maxZ: 300 };
  await install(
    page,
    {
      model: 'native',
      overview: qaOverview,
    },
    { playback },
  );
  await open(page);
  const readCalibration = async (selector: string) =>
    page.locator(selector).evaluate((node, id) => {
      const svg = node as SVGSVGElement;
      const image = svg.querySelector('image')!;
      const marker = svg.querySelector<SVGGElement>(`[data-player-id="${id}"]`)!;
      const pixel = new DOMPoint(0, 0).matrixTransform(marker.getScreenCTM()!);
      const mapPoint = pixel.matrixTransform(image.getScreenCTM()!.inverse());
      const bounds = image.getBBox();
      return {
        width: svg.viewBox.baseVal.width,
        east: (mapPoint.x - bounds.x) / bounds.width,
        south: (mapPoint.y - bounds.y) / bounds.height,
      };
    }, qaActor);
  await expect(page.locator('.position-radar')).toHaveAttribute('data-map-image-state', 'ready');
  const radar = await readCalibration('.position-radar');
  expect(75 / radar.width).toBeCloseTo(0.9, 5);
  await camera(page, '2D tactical · low power');
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  const overview = await readCalibration('.tactical-plot');
  expect(overview.width).toBe(120);
  expect(radar.east).toBeCloseTo(0.25, 6);
  expect(radar.south).toBeCloseTo(0.5, 6);
  expect(radar.east).toBeCloseTo(overview.east, 6);
  expect(radar.south).toBeCloseTo(overview.south, 6);
});

test('a real 3D map without an overview omits the compact radar and explains unavailable2D in both themes', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  for (const theme of ['dark', 'light']) {
    await install(page, { model: 'native', overview: null }, { theme });
    await open(page);
    await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
    await expect(page.locator('.position-radar')).toHaveCount(0);
    await camera(page, '2D tactical · low power');
    await expect(
      page.getByRole('status', { name: 'Map overview unavailable', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('No calibrated overview is installed. Choose a 3D camera to view this map.'),
    ).toBeVisible();
    await expect(page.locator('.tactical-plot,[data-player-id] circle')).toHaveCount(0);
  }
});

test('known and unknown map names without instance packs show localized unavailable state instead of player dots', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [map, language] of [
    ['de_mirage', 'en'],
    ['de_unknown_qa', 'fr'],
  ]) {
    const id = 'missing-' + language;
    await install(page, { model: null, overview: null }, { id, map, language, theme: 'light' });
    await open(page, id);
    await expect(
      page.getByRole('status', {
        name: language === 'fr' ? 'Carte indisponible' : 'Map unavailable',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('[data-map-unavailable="missing"]')).toBeVisible();
    await expect(page.locator('.scene canvas,.position-radar,.tactical-plot')).toHaveCount(0);
    await expect(page.locator('.map-unavailable p')).toContainText(
      language === 'fr' ? 'administrateur' : 'administrator',
    );
    await expect(page.locator('.viewer-frame')).toBeInViewport();
  }
});

test('the same library link keeps its position and keyboard focus through demo processing, discovery and Cache preparation', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  const id = 'member-design-0';
  await install(page, { model: null, overview: null }, { id, map: 'de_cache', language: 'fr' });
  let ready = false;
  await page.route('**/api/demos/' + id, (route) =>
    ready
      ? route.fallback()
      : route.fulfill({ json: { id, name: 'Cache', status: 'processing', owned: true } }),
  );
  const discovery = Promise.withResolvers<void>();
  await page.route('**/api/demos/' + id + '/map-assets', async (route) => {
    await discovery.promise;
    await route.fulfill({
      json: {
        ...manualMapAssets({ model: null, overview: null }),
        resolution: {
          status: 'latest',
          selection: {
            map: 'de_cache',
            appId: 730,
            depotId: 2347770,
            manifest: '12345678901234567890',
            sha1: 'c'.repeat(40),
            bytes: 128000,
          },
          inventoryUpdatedAt: 1795000000,
          source: null,
        },
        acquisition: 'processing',
      },
    });
  });
  try {
    await page.goto('/library');
    await page.locator('a[href="/watch/member-design-0"]').click();
    const loading = page.locator('.viewer-map-loading');
    await expect(loading.getByRole('heading')).toHaveText('Lecture des données de partie…');
    const back = loading.getByRole('link', { name: 'Retour à la bibliothèque' });
    await expect(back).toBeInViewport();
    await back.focus();
    const position = await back.boundingBox();
    const panel = loading.locator('.viewer-loading-panel');
    const panelTop = (await panel.boundingBox())?.y;
    ready = true;
    await expect(loading.getByRole('heading')).toHaveText(
      'Chargement des ressources de la carte…',
      { timeout: 10000 },
    );
    await expect(loading.getByText('cache', { exact: true })).toBeVisible();
    expect(await back.boundingBox()).toEqual(position);
    expect((await panel.boundingBox())?.y).toBe(panelTop);
    await expect(back).toBeFocused();
    discovery.resolve();
    await expect(loading.getByRole('heading')).toHaveText('Préparation des ressources de la carte');
    await expect(loading).toContainText('Sa géométrie peut différer de cet enregistrement.');
    await expect(loading.getByRole('button', { name: 'Ouvrir la chronologie' })).toBeInViewport();
    expect(await back.boundingBox()).toEqual(position);
    expect((await panel.boundingBox())?.y).toBe(panelTop);
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/library');
  } finally {
    discovery.resolve();
  }
});

test('discovery and overview image decoding keep recorded markers hidden until an actual calibrated map is ready', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let revealAssets = () => {},
    revealImage = () => {};
  const descriptor = new Promise<void>((resolve) => (revealAssets = resolve)),
    raster = new Promise<void>((resolve) => (revealImage = resolve));
  await install(
    page,
    { model: null, overview: qaOverview },
    {
      image: async (route) => {
        await raster;
        await route.fulfill({ contentType: 'image/png', body: image });
      },
    },
  );
  await page.route('**/api/demos/original-map-fixture/map-assets', async (route) => {
    await descriptor;
    await route.fulfill({
      json: manualMapAssets({ model: null, overview: qaOverview }),
    });
  });
  await page.goto('/watch/original-map-fixture');
  await expect(page.locator('.viewer-map-loading [role="status"]')).toHaveText(
    'Loading map assets…',
  );
  await expect(page.locator('.scene canvas,.tactical-plot,.position-radar')).toHaveCount(0);
  revealAssets();
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'pending');
  await expect(page.locator('.tactical-plot [data-player-id] circle').first()).toBeHidden();
  await expect(page.locator('.viewer-map-loading [role="status"]')).toHaveText(
    'Loading map overview…',
  );
  revealImage();
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.tactical-plot [data-player-id] circle').first()).toBeVisible();
  await expect(page.locator('.viewer-map-status')).toHaveText('2D map fallback');
  await expect(page.locator('.scene canvas,.position-radar')).toHaveCount(0);
});

test('failed3D without an overview and noWebGL without an overview expose distinct unavailable reasons', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await install(
    page,
    { model: 'native', overview: null },
    {
      model: (route) =>
        route.fulfill({
          contentType: 'model/gltf-binary',
          body: Buffer.from('Original bad QA GLB'),
        }),
    },
  );
  await open(page);
  await expect(page.locator('[data-map-unavailable="model-error"]')).toBeVisible();
  await expect(
    page.getByText('The 3D map could not be loaded and no usable overview is installed.'),
  ).toBeVisible();
  await expect(page.locator('.scene canvas,.tactical-plot,.position-radar')).toHaveCount(0);
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) return null;
      return Reflect.apply(get, this, [type, ...args]);
    } as typeof get;
  });
  await page.reload();
  await expect(page.locator('[data-map-unavailable="renderer-error"]')).toBeVisible();
  await expect(
    page.getByText('This device could not render the 3D map and no usable overview is installed.'),
  ).toBeVisible();
  await expect(page.locator('.scene canvas,.tactical-plot,.position-radar')).toHaveCount(0);
});

test('recorded world equipment shares radar calibration and survives seeking without duplicate projectiles or stale lifetimes', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  const playback = originalMapReplay();
  playback.itemState = {
    complete: true,
    coverage: { dropped: true, planted: true, projectile: true },
  };
  playback.itemSamples = [
    {
      id: 'item:101:1:0',
      tick: 0,
      present: true,
      equipment: 'ak47',
      kind: 'dropped',
      x: -512,
      y: 0,
      z: 0,
    },
    {
      id: 'item:102:1:0',
      tick: 0,
      present: true,
      equipment: 'smokegrenade',
      kind: 'projectile',
      x: -512,
      y: 0,
      z: 10,
    },
    {
      id: 'item:102:1:0',
      tick: 128,
      present: true,
      equipment: 'smokegrenade',
      kind: 'projectile',
      x: 0,
      y: 0,
      z: 300,
    },
    {
      id: 'item:103:1:192',
      tick: 192,
      present: true,
      equipment: 'plantedc4',
      kind: 'planted',
      x: 512,
      y: 0,
      z: 0,
    },
    { id: 'item:101:1:0', tick: 256, present: false },
    {
      id: 'item:101:2:256',
      tick: 256,
      present: true,
      equipment: 'awp',
      kind: 'dropped',
      x: 256,
      y: 0,
      z: 0,
    },
    { id: 'item:102:1:0', tick: 257, present: false },
    { id: 'item:103:1:192', tick: 384, present: false },
    { id: 'item:101:2:256', tick: 384, present: false },
  ];
  await page.route('**/api/assets/equipment', (route) =>
    route.fulfill({
      json: {
        icons: {
          ak47: '/api/assets/equipment/ak47.png',
          c4: '/api/assets/equipment/c4.png',
          smokegrenade: '/api/assets/equipment/smokegrenade.png',
        },
      },
    }),
  );
  await page.route('**/api/assets/equipment/*.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: originalEnvironmentPNG(0) }),
  );
  await install(page, { model: 'native', overview: qaOverview }, { playback, theme: 'light' });
  await open(page);
  const radar = page.locator('.position-radar');
  await expect(radar.locator('.tactical-item[data-kind="dropped"]')).toHaveAttribute(
    'transform',
    'translate(35 60)',
  );
  await expect(
    radar.locator('.tactical-item[data-kind="dropped"] .equipment-game-icon'),
  ).toBeVisible();
  await page.locator('.timeline-slider').fill('128');
  await expect(radar.locator('.tactical-item[data-kind="projectile"]')).toHaveAttribute(
    'transform',
    'translate(60 60)',
  );
  await expect(radar.locator('.tactical-projectile')).toHaveCount(0);
  const markers = await radar
    .locator('.tactical-item')
    .evaluateAll((nodes) =>
      nodes.map((node) => [node.getAttribute('data-item-id'), node.getAttribute('transform')]),
    );
  await camera(page, '2D tactical · low power');
  const plot = page.locator('.tactical-plot');
  expect(
    await plot
      .locator('.tactical-item')
      .evaluateAll((nodes) =>
        nodes.map((node) => [node.getAttribute('data-item-id'), node.getAttribute('transform')]),
      ),
  ).toEqual(markers);
  await page.locator('.timeline-slider').fill('256');
  await expect(plot.locator('.tactical-item[data-item-id="item:101:1:0"]')).toHaveCount(0);
  await expect(plot.locator('.tactical-item[data-item-id="item:101:2:256"]')).toHaveAttribute(
    'data-equipment',
    'awp',
  );
  await expect(plot.locator('.tactical-item[data-kind="planted"]')).toHaveAttribute(
    'transform',
    'translate(85 60)',
  );
  await expect(
    plot.locator('.tactical-item[data-kind="planted"] .equipment-game-icon'),
  ).toBeVisible();
  await page.locator('.timeline-slider').fill('384');
  await expect(plot.locator('.tactical-item')).toHaveCount(0);
  await page.locator('.timeline-slider').fill('0');
  await expect(plot.locator('.tactical-item[data-item-id="item:101:1:0"]')).toHaveAttribute(
    'data-equipment',
    'ak47',
  );
  await expect(plot.locator('.tactical-item[data-kind="planted"]')).toHaveCount(0);
  await expect(page.locator('.viewer-frame')).toBeInViewport();
});

test('an explicit camera retries failed WebGL and stale same-map context events leave its HUD intact', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await install(page, { model: 'native', overview: qaOverview }, { crosshair: true });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext,
      failed = new Set<HTMLCanvasElement>();
    let available = false;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (!available && ['webgl', 'webgl2', 'experimental-webgl'].includes(type)) {
        failed.add(this);
        return null;
      }
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
    (window as unknown as { recoverOriginalQAContext: () => void }).recoverOriginalQAContext =
      () => {
        available = true;
      };
    (
      window as unknown as { lateOriginalQAContextEvents: () => number }
    ).lateOriginalQAContextEvents = () => {
      for (const canvas of failed) {
        canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
        canvas.dispatchEvent(new Event('webglcontextrestored'));
      }
      return failed.size;
    };
  });
  await open(page);
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D unavailable');
  await expect(page.locator('.position-radar')).toHaveCount(0);
  await expect(page.locator('.viewer-crosshair')).toHaveCount(0);
  await expectCameraControl(page, '2D map fallback');
  await page.evaluate(() =>
    (window as unknown as { recoverOriginalQAContext: () => void }).recoverOriginalQAContext(),
  );
  await camera(page, 'Player perspective');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.scene canvas')).toBeVisible();
  await expect(page.locator('.tactical-plot')).toHaveCount(0);
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await expect(page.locator('.position-radar')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.viewer-crosshair')).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { lateOriginalQAContextEvents: () => number }
      ).lateOriginalQAContextEvents(),
    ),
  ).toBeGreaterThan(0);
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await expect(page.locator('.position-radar')).toBeVisible();
  await expect(page.locator('.viewer-crosshair')).toBeVisible();
});

test('overview image failure stays explicit and a new viewer retries updated calibration instead of a negative cache', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let good = false,
    version = 'original-QA-v1';
  const assets = {
    model: null,
    overview: {
      ...qaOverview,
      get assetVersion() {
        return version;
      },
    },
  };
  const requests = await install(page, assets, {
    image: async (route) =>
      route.fulfill(
        good
          ? { contentType: 'image/png', body: image }
          : { status: 404, json: { detail: 'Explicit synthetic missing image' } },
      ),
  });
  await open(page);
  await camera(page, '2D tactical · low power');
  await expect(page.locator('.viewer-map-status')).toHaveText('Map overview failed to load');
  await expect(page.getByRole('status', { name: 'Map unavailable', exact: true })).toBeVisible();
  await expect(
    page.getByText('The installed map overview could not be loaded. Reopen the viewer to retry.'),
  ).toBeVisible();
  await expect(page.locator('.tactical-plot')).toHaveCount(0);
  await expect(page.locator('.tactical-plot image')).toHaveCount(0);
  good = true;
  version = 'original-QA-v2';
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await camera(page, '2D tactical · low power');
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.viewer-map-status')).toHaveText('Map overview');
  expect(requests.discoveries).toBe(2);
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-overview-version', version);
});

test('switching demos clears the old map image before delayed discovery resolves and uses the new calibration', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await install(page, { model: null, overview: qaOverview });
  const nextMap = 'de_other_original_map_qa',
    nextId = 'other-original-map-fixture';
  const nextOverview = {
    ...qaOverview,
    image: `/api/maps/${nextMap}/overview.png`,
    origin: { x: -2048, y: 2048 },
    scale: 4,
    assetVersion: 'original-QA-other-calibration',
  };
  await install(page, { model: null, overview: nextOverview }, { map: nextMap, id: nextId });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/demos/${nextId}/map-assets`, async (route) => {
    await gate;
    await route.fulfill({
      json: manualMapAssets({ model: null, overview: nextOverview }),
    });
  });
  await open(page);
  await camera(page, '2D tactical · low power');
  await expect(page.locator('.tactical-plot image')).toHaveAttribute('href', qaOverview.image);
  await page.evaluate((path) => {
    history.pushState({ ...history.state, idx: (history.state?.idx || 0) + 1 }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, '/watch/' + nextId);
  await expect(page.locator('.viewer-match h1')).toHaveText('other_original_map_qa');
  await expect(page.locator('.tactical-plot image')).toHaveCount(0);
  await expect(page.locator('.viewer-map-status')).toHaveText('Loading 3D map…');
  release();
  await camera(page, '2D tactical · low power');
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.tactical-plot image')).toHaveAttribute('href', nextOverview.image);
  await expect(page.locator(`.tactical-plot [data-player-id="${qaActor}"]`)).toHaveAttribute(
    'transform',
    'translate(47.5 60)',
  );
});

test('paused viewer stops native rendering and camera, held keys and POV seeks explicitly request frames', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.addInitScript(() => {
    (window as unknown as { qaGLClears: number }).qaGLClears = 0;
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function (mask: number) {
      (window as unknown as { qaGLClears: number }).qaGLClears++;
      return clear.call(this, mask);
    };
  });
  await install(page, {
    model: 'native',
    overview: qaOverview,
  });
  const catalogs = {
    '/api/assets/agents': { ct: null, t: null },
    '/api/assets/equipment-models': { schemaVersion: 2, items: {}, complete: false },
    '/api/assets/viewmodels': { items: {}, complete: false },
  };
  const initialCatalogs = new Set<string>();
  const pendingCatalogs = new Set<string>();
  const refreshes = new Map<string, () => void>();
  for (const [path, json] of Object.entries(catalogs)) {
    const refreshGate = new Promise<void>((resolve) => refreshes.set(path, resolve));
    await page.route(`**${path}`, async (route) => {
      if (initialCatalogs.has(path)) {
        pendingCatalogs.add(path);
        await refreshGate;
      } else initialCatalogs.add(path);
      await route.fulfill({ json });
    });
  }
  const frames = () =>
    page.evaluate(() => (window as unknown as { qaGLClears: number }).qaGLClears);
  const idle = async () => {
    let previous = -1,
      stable = 0;
    await expect
      .poll(
        async () => {
          const value = await frames();
          stable = value === previous ? stable + 1 : 0;
          previous = value;
          return stable;
        },
        { intervals: [100] },
      )
      .toBeGreaterThanOrEqual(2);
    const before = await frames();
    await page.waitForTimeout(250);
    expect(await frames(), 'Paused idle must not continuously render').toBe(before);
  };
  await open(page);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await page.locator('.timeline-slider').fill('0');
  await camera(page, 'Free camera');
  const cameraNotice = page.locator('.viewer-camera-tools');
  await expect(cameraNotice).toHaveAttribute('data-camera-changed', 'false');
  // Hold the already-issued poll responses while the first render settles.
  await expect.poll(() => pendingCatalogs.size).toBe(Object.keys(catalogs).length);
  await idle();
  const initial = await frames();
  expect(await frames(), 'Expiring the camera announcement must leave the scene idle').toBe(
    initial,
  );
  for (const [path, releaseRefresh] of refreshes) {
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === path);
    releaseRefresh();
    await refreshed;
    await page.waitForTimeout(250);
    expect(await frames(), `Unchanged ${path} must leave the paused scene idle`).toBe(initial);
  }
  const unfocused = await frames();
  await page.getByRole('button', { name: 'Options', exact: true }).focus();
  await page.keyboard.press('x');
  await page.waitForTimeout(250);
  expect(
    await frames(),
    'Unrelated control focus and nonmovement keyup must not render the paused scene',
  ).toBe(unfocused);
  await page.locator('.viewer-stage').focus();
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(250);
  expect(
    await frames(),
    'Ordinary backward focus navigation must not start an idle camera frame',
  ).toBe(unfocused);
  let before = await frames();
  await page.locator('.viewer-stage').focus();
  await page.keyboard.down('w');
  await expect.poll(frames).toBeGreaterThan(before + 2);
  await page.keyboard.up('w');
  await idle();
  before = await frames();
  await camera(page, 'Player perspective');
  await expect.poll(frames).toBeGreaterThan(before);
  await expect(cameraNotice).toHaveAttribute('data-camera-changed', 'false');
  before = await frames();
  await page.locator('.timeline-slider').fill('64');
  await expect.poll(frames).toBeGreaterThan(before);
  await idle();
});
