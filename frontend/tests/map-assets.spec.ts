import { chooseCameraControl, expectCameraControl } from './fixtures/viewer-transport';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { manualMapAssets } from './fixtures/map-assets';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  originalMapGLB,
  originalMapReplay,
  originalEnvironmentPNG,
  originalEnvironmentReplay,
  originalOverviewPNG,
  qaActor,
  qaMap,
  qaOverview,
  qaEnvironment,
} from './fixtures/original-map';
import type { MapAssets } from '../../shared/map-assets';

const image = originalOverviewPNG(),
  model = originalMapGLB();
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
  } = {},
) {
  const map = options.map || qaMap,
    id = options.id || 'original-map-fixture';
  let discoveries = 0,
    models = 0;
  await page.addInitScript(
    ({ theme, crosshair, language, quality }) => {
      localStorage.setItem('theme', theme);
      localStorage.setItem('cswatch.language', language);
      ['viewer-settings-v2', 'viewer-settings-v2-mobile'].forEach((key) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            quality,
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
    return route.fulfill({ json: manualMapAssets(assets) });
  });
  await page.route(`**/api/maps/${map}/overview.png`, (route) =>
    options.image ? options.image(route) : route.fulfill({ contentType: 'image/png', body: image }),
  );
  await page.route(`**/map-assets/${map}/**`, (route) => {
    models++;
    return options.model
      ? options.model(route)
      : route.fulfill({ contentType: 'model/gltf-binary', body: model });
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
for (const profile of [
  { adapter: 'ANGLE (NVIDIA GeForce RTX 4060)', device: 'hardware', tier: 'desktop' },
  { adapter: 'ANGLE (Google, Vulkan SwiftShader Device)', device: 'software', tier: 'compact' },
  { adapter: 'ANGLE (Intel(R) Iris Xe Graphics)', device: 'integrated', tier: 'mobile' },
]) {
  test(`Auto starts with the ${profile.tier} map for ${profile.device} renderer evidence`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    await page.setViewportSize({ width: 1280, height: 720 });
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
    }, profile.adapter);
    const paths: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith(`/map-assets/${qaMap}/`)) paths.push(path);
    });
    await install(
      page,
      {
        model: `/map-assets/${qaMap}/desktop/scene.glb`,
        mobile: `/map-assets/${qaMap}/mobile/scene.glb`,
        compact: `/map-assets/${qaMap}/compact/scene.glb`,
        overview: qaOverview,
      },
      { quality: 'auto' },
    );
    await open(page);
    const scene = page.locator('.scene');
    await expect(scene).toHaveAttribute('data-render-device', profile.device);
    await expect(scene).toHaveAttribute('data-map-tier', profile.tier);
    await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
    expect(paths).toEqual([`/map-assets/${qaMap}/${profile.tier}/scene.glb`]);
  });
}

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

async function centerPixel(page: Page) {
  const pixels = await page.locator('.scene canvas').screenshot();
  return page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = surface.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixel = Array.from(
        context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1)
          .data,
      ).slice(0, 3);
      bitmap.close();
      return pixel;
    },
    [...pixels],
  );
}

async function installSky(page: Page, body: (face: number, route: Route) => Promise<void>) {
  await page.route(`**/api/maps/${qaMap}/environment/*.png`, (route) => {
    const face = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].indexOf(
      new URL(route.request().url()).pathname.split('/').pop()!.replace('.png', ''),
    );
    return body(face, route);
  });
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
      const requests = await install(
        page,
        { model: `/map-assets/${qaMap}/desktop/scene.glb`, mobile: null, overview: qaOverview },
        { theme },
      );
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

test('a real 3D map without an overview omits the compact radar and explains unavailable2D in both themes', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  for (const theme of ['dark', 'light']) {
    await install(
      page,
      { model: `/map-assets/${qaMap}/desktop/scene.glb`, mobile: null, overview: null },
      { theme },
    );
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
    await install(
      page,
      { model: null, mobile: null, overview: null },
      { id, map, language, theme: 'light' },
    );
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
    { model: null, mobile: null, overview: qaOverview },
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
      json: manualMapAssets({ model: null, mobile: null, overview: qaOverview }),
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
    { model: `/map-assets/${qaMap}/desktop/scene.glb`, mobile: null, overview: null },
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
  await install(
    page,
    { model: `/map-assets/${qaMap}/desktop/scene.glb`, mobile: null, overview: qaOverview },
    { playback, theme: 'light' },
  );
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

test('3D map readiness waits for an actual GLB and a failed map retries without removing the scene or overview', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let release: () => void = () => {},
    good = false;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const assets = {
    model: `/map-assets/${qaMap}/desktop/scene.glb`,
    mobile: null,
    overview: qaOverview,
  };
  const requests = await install(page, assets, {
    model: async (route) => {
      if (!good) await gate;
      await route.fulfill({
        contentType: 'model/gltf-binary',
        body: good ? model : Buffer.from('Explicit original QA bad GLB'),
      });
    },
  });
  await page.goto('/watch/original-map-fixture');
  await expect(page.locator('.viewer-map-loading [role="status"]')).toHaveText('Loading 3D map…');
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveCount(0);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'pending');
  release();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'error');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D failed');
  await expect(page.locator('.viewer-map-loading')).toHaveCount(0);
  const canvas = page.locator('.scene canvas');
  await expect(canvas).toHaveCount(0);
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.position-radar')).toHaveCount(0);
  const failed = await page.locator('.viewer-stage').screenshot();
  good = true;
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await page.waitForTimeout(150);
  expect(
    (await page.locator('.viewer-stage').screenshot()).equals(failed),
    'The valid original GLB must change real rendered scene pixels',
  ).toBe(false);
  expect(requests.models).toBe(2);
  await page.screenshot({ path: info.outputPath('original-QA-real-loaded-GLB.png') });
});

test('map loading shows measured byte progress and waits for decoded textures', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await install(
    page,
    { model: `/map-assets/${qaMap}/desktop/scene.glb`, mobile: null, overview: qaOverview },
    {
      model: (route) =>
        route.fulfill({
          contentType: 'model/gltf-binary',
          body: originalMapGLB(false, 'webp'),
        }),
    },
  );
  await page.addInitScript(() => {
    const gates = {
      start: Promise.withResolvers<void>(),
      finish: Promise.withResolvers<void>(),
      decode: Promise.withResolvers<void>(),
    };
    Object.assign(window, {
      advanceOriginalMap: (stage: keyof typeof gates) => gates[stage].resolve(),
    });
    const fetch = window.fetch;
    window.fetch = async (input, options) => {
      const response = await fetch(input, options);
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/scene.glb')) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const halfway = Math.ceil(bytes.length / 2);
      return new Response(
        new ReadableStream({
          async start(controller) {
            await gates.start.promise;
            controller.enqueue(bytes.subarray(0, halfway));
            await gates.finish.promise;
            controller.enqueue(bytes.subarray(halfway));
            controller.close();
          },
        }),
        { headers: { 'Content-Length': String(bytes.length) } },
      );
    };
    const decode = window.createImageBitmap;
    window.createImageBitmap = async (...args: Parameters<typeof decode>) => {
      if (args[0] instanceof Blob) await gates.decode.promise;
      return decode(...args);
    };
  });
  const advance = (stage: 'start' | 'finish' | 'decode') =>
    page.evaluate((next) => {
      (window as unknown as { advanceOriginalMap: (stage: string) => void }).advanceOriginalMap(
        next,
      );
    }, stage);
  await page.goto('/watch/original-map-fixture');
  const download = page.getByRole('progressbar', { name: 'Loading 3D map…' });
  await expect(download).toBeVisible();
  expect(await download.getAttribute('aria-valuenow')).toBeNull();
  await advance('start');
  await expect(download).toHaveAttribute('aria-valuenow', '50');
  await expect(page.locator('.viewer-loading-percent')).toHaveText('50%');
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveCount(0);
  await advance('finish');
  const preparing = page.getByRole('progressbar', { name: 'Preparing 3D map…' });
  await expect(preparing).toBeVisible();
  expect(await preparing.getAttribute('aria-valuenow')).toBeNull();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'pending');
  await advance('decode');
  await expect(page.locator('.viewer-map-loading')).toHaveCount(0);
  await expect(page.locator('.scene[data-map-model-state="ready"] canvas')).toBeVisible();
});

test('high quality accepts an installed mobile-only GLB and no WebGL still shows the aligned map overview', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await install(page, {
    model: null,
    mobile: `/map-assets/${qaMap}/mobile/scene.glb`,
    overview: qaOverview,
  });
  await open(page);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  await page.reload();
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.tactical-plot image')).toHaveAttribute('href', qaOverview.image);
  await expect(page.locator('.viewer-map-status')).toHaveText('3D unavailable');
  await expect(page.locator('.position-radar')).toHaveCount(0);
});

test('an explicit camera retries failed WebGL and stale same-map context events leave its HUD intact', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await install(
    page,
    { model: `/map-assets/${qaMap}/desktop/scene.glb`, mobile: null, overview: qaOverview },
    { crosshair: true },
  );
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

test.describe('touch camera recovery', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('Auto uses the compact 3D map on phones and retries a detailed map if it fails', async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    let failCompact = false;
    const requests: string[] = [];
    await install(
      page,
      {
        model: `/map-assets/${qaMap}/desktop/scene.glb`,
        mobile: `/map-assets/${qaMap}/mobile/scene.glb`,
        compact: `/map-assets/${qaMap}/compact/scene.glb`,
        overview: qaOverview,
      },
      {
        quality: 'auto',
        model: (route) => {
          const path = new URL(route.request().url()).pathname;
          requests.push(path);
          return route.fulfill({
            contentType: 'model/gltf-binary',
            body:
              failCompact && path.includes('/compact/')
                ? Buffer.from('Invalid compact GLB')
                : model,
          });
        },
      },
    );
    await open(page);
    await expect(
      page.locator('.scene[data-map-tier="compact"][data-map-model-state="ready"] canvas'),
    ).toBeVisible();
    expect(requests).toEqual([`/map-assets/${qaMap}/compact/scene.glb`]);
    const cameraPicker = page.getByRole('combobox', { name: 'Camera mode' });
    await cameraPicker.tap();
    await page.getByRole('option', { name: 'Player perspective', exact: true }).tap();
    await expect(page.locator('.scene[data-camera-mode="pov"] canvas')).toBeVisible();
    await expect(page.locator('.position-radar')).toBeVisible();

    failCompact = true;
    requests.length = 0;
    await page.reload();
    await expect(
      page.locator('.scene[data-map-tier="mobile"][data-map-model-state="ready"] canvas'),
    ).toBeVisible();
    await expect(page.locator('.tactical-plot')).toHaveCount(0);
    expect(requests).toEqual([
      `/map-assets/${qaMap}/compact/scene.glb`,
      `/map-assets/${qaMap}/mobile/scene.glb`,
    ]);
  });

  test('an explicit 3D camera retries a failed phone map and keeps the actual view selected', async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    let available = false;
    const requests = await install(
      page,
      { model: null, mobile: `/map-assets/${qaMap}/mobile/scene.glb`, overview: qaOverview },
      {
        model: (route) =>
          route.fulfill({
            contentType: 'model/gltf-binary',
            body: available ? model : Buffer.from('Original QA bad mobile GLB'),
          }),
      },
    );
    await open(page);
    const picker = page.getByRole('combobox', { name: 'Camera mode', exact: true });
    const slider = page.getByRole('slider', { name: 'Playback position' });
    const choose = async (name: string) => {
      await picker.tap();
      await page.getByRole('option', { name, exact: true }).tap();
    };
    await expect(page.locator('.tactical-plot')).toBeVisible();
    await expect(page.locator('.viewer-map-status')).toBeVisible();
    expect(await page.locator('.viewer-map-status').evaluate((status) => status.scrollWidth)).toBe(
      await page.locator('.viewer-map-status').evaluate((status) => status.clientWidth),
    );
    await slider.fill('128');
    await expect(picker).toHaveText('2D map fallback');
    await choose('Player perspective');
    await expect(page.locator('.tactical-plot')).toBeVisible();
    await expect(picker).toHaveText('2D map fallback');
    expect(requests.models).toBe(2);

    available = true;
    await choose('Player perspective');
    await expect(page.locator('.scene[data-camera-mode="pov"] canvas')).toBeVisible();
    await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
    await expect(page.locator('.tactical-plot')).toHaveCount(0);
    await expect(picker).toHaveText('Player perspective');
    await expect(slider).toHaveValue('128');
    expect(requests.models).toBe(3);
    await choose('2D tactical · low power');
    await expect(page.locator('.tactical-plot')).toBeVisible();
    await choose('Overhead');
    await expect(page.locator('.scene[data-camera-mode="tactical"] canvas')).toBeVisible();
    await expect(page.locator('.position-radar')).toBeVisible();
    expect(requests.models).toBe(3);
  });
});

test('imported engine light intensity cannot wash out the original map material colors', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let engineLight = false;
  await install(
    page,
    {
      model: `/map-assets/${qaMap}/desktop/scene.glb`,
      mobile: null,
      overview: qaOverview,
    },
    {
      model: (route) =>
        route.fulfill({
          contentType: 'model/gltf-binary',
          body: originalMapGLB(engineLight),
        }),
    },
  );
  await open(page);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  const canvas = page.locator('.scene canvas');
  const unlitImport = await canvas.screenshot();
  const coloredPixels = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let green = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 1] > 60 &&
          pixels[i + 1] > pixels[i] * 1.07 &&
          pixels[i + 1] > pixels[i + 2] * 1.03
        )
          green++;
      bitmap.close();
      return green;
    },
    [...unlitImport],
  );
  expect(
    coloredPixels,
    'The original green map material must remain visibly colored',
  ).toBeGreaterThan(1000);
  engineLight = true;
  await page.reload();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  expect(
    (await canvas.screenshot()).equals(unlitImport),
    'Adding an exported 2049-intensity Source light must not change viewer-owned lighting',
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('original-QA-imported-light-neutralized.png') });
});

test('embedded WebP map textures render under production CSP and missing required textures cannot report ready', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let broken = true;
  const cspErrors: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) cspErrors.push(message.text());
  });
  const requests = await install(
    page,
    {
      model: `/map-assets/${qaMap}/desktop/scene.glb`,
      mobile: null,
      overview: qaOverview,
    },
    {
      model: (route) =>
        route.fulfill({
          contentType: 'model/gltf-binary',
          body: originalMapGLB(false, broken ? 'broken' : 'webp'),
        }),
    },
  );
  const response = await open(page);
  expect(response?.headers()['content-security-policy']).toMatch(/connect-src\s+[^;]*blob:/);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'error');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D failed');
  await expect(page.locator('.scene canvas')).toHaveCount(0);
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  broken = false;
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  const pixels = await page.locator('.scene canvas').screenshot();
  const colors = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let red = 0,
        blue = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 60 && pixels[i] > pixels[i + 2] * 1.5) red++;
        if (pixels[i + 2] > 60 && pixels[i + 2] > pixels[i] * 1.5) blue++;
      }
      bitmap.close();
      return { red, blue };
    },
    [...pixels],
  );
  expect(
    colors.red,
    'Embedded original red texture pixels must reach the rendered map',
  ).toBeGreaterThan(1000);
  expect(
    colors.blue,
    'Embedded original blue texture pixels must reach the rendered map',
  ).toBeGreaterThan(1000);
  expect(cspErrors).toEqual([]);
  expect(requests.models).toBe(2);
  await page.screenshot({ path: info.outputPath('original-QA-WebP-textured-map.png') });
});

test('overview image failure stays explicit and a new viewer retries updated calibration instead of a negative cache', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let good = false,
    version = 'original-QA-v1';
  const assets = {
    model: null,
    mobile: null,
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
  await install(page, { model: null, mobile: null, overview: qaOverview });
  const nextMap = 'de_other_original_map_qa',
    nextId = 'other-original-map-fixture';
  const nextOverview = {
    ...qaOverview,
    image: `/api/maps/${nextMap}/overview.png`,
    origin: { x: -2048, y: 2048 },
    scale: 4,
    assetVersion: 'original-QA-other-calibration',
  };
  await install(
    page,
    { model: null, mobile: null, overview: nextOverview },
    { map: nextMap, id: nextId },
  );
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/demos/${nextId}/map-assets`, async (route) => {
    await gate;
    await route.fulfill({
      json: manualMapAssets({ model: null, mobile: null, overview: nextOverview }),
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
  await expect(page.locator('.viewer-map-status')).toHaveText('Loading map overview…');
  release();
  await expect(page.locator('.tactical-plot')).toHaveAttribute('data-map-image-state', 'ready');
  await expect(page.locator('.tactical-plot image')).toHaveAttribute('href', nextOverview.image);
  await expect(page.locator(`.tactical-plot [data-player-id="${qaActor}"]`)).toHaveAttribute(
    'transform',
    'translate(47.5 60)',
  );
});

test('original sky cube waits for all faces, preserves cardinal and asymmetric rays, and ignores the HUD theme', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await install(
    page,
    {
      model: `/map-assets/${qaMap}/desktop/scene.glb`,
      mobile: null,
      overview: qaOverview,
      environment: qaEnvironment,
    },
    { playback: originalEnvironmentReplay() },
  );
  await installSky(page, async (face, route) => {
    if (face === 0) await gate;
    await route.fulfill({ contentType: 'image/png', body: originalEnvironmentPNG(face) });
  });
  const response = await open(page);
  expect(response?.headers()['content-security-policy']).toMatch(/img-src\s+[^;]*'self'/);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'pending');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map · loading sky…');
  release();
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'ready');
  await camera(page, 'Player perspective');
  // Standard Three loaded-cube semantics flip X: +X samples nx; other axes keep their slot.
  const expected = [
    [false, true, false],
    [true, false, false],
    [false, true, true],
    [true, false, true],
    [false, false, true],
    [true, true, false],
  ];
  for (let index = 0; index < expected.length; index++) {
    await page.locator('.timeline-slider').fill(String(index * 64));
    await expect
      .poll(async () => (await centerPixel(page)).map((channel) => channel > 100), {
        message: `Original cube cardinal ray ${index}`,
      })
      .toEqual(expected[index]);
  }
  await page.locator('.timeline-slider').fill('384');
  await expect
    .poll(async () => (await centerPixel(page)).every((channel) => channel > 150))
    .toBe(true);
  await page.locator('.timeline-slider').fill('448');
  await expect
    .poll(async () => (await centerPixel(page)).map((channel) => channel > 100))
    .toEqual([false, true, false]);
  await page.locator('.timeline-slider').fill('512');
  await expect
    .poll(async () => (await centerPixel(page)).every((channel) => channel < 50))
    .toBe(true);
  await page.locator('.timeline-slider').fill('0');
  const dark = await centerPixel(page);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  expect(await centerPixel(page)).toEqual(dark);
  await page.screenshot({ path: info.outputPath('original-QA-sky-cube-light-HUD.png') });
});

test('failed sky stays separate from map readiness and retries a new version with recorded brightness', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let broken = true;
  const assets = {
    model: `/map-assets/${qaMap}/desktop/scene.glb`,
    mobile: null,
    overview: qaOverview,
    environment: qaEnvironment,
  };
  await install(page, assets, { playback: originalEnvironmentReplay() });
  await installSky(page, async (face, route) =>
    route.fulfill(
      broken && face === 0
        ? { status: 404, body: 'Original QA absent cube face' }
        : { contentType: 'image/png', body: originalEnvironmentPNG(face) },
    ),
  );
  await open(page);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'error');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map · sky unavailable');
  await expect(page.locator('.scene canvas')).toBeVisible();
  await expect(page.locator('.position-radar')).toHaveAttribute('data-map-image-state', 'ready');
  broken = false;
  assets.environment = {
    ...qaEnvironment,
    assetVersion: 'original-qa-sky-v2',
    sky: { ...qaEnvironment.sky, brightness: 0.25 },
  };
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.scene')).toHaveAttribute(
    'data-environment-version',
    'original-qa-sky-v2',
  );
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'ready');
  await camera(page, 'Player perspective');
  const dim = await centerPixel(page);
  assets.environment = {
    ...assets.environment,
    assetVersion: 'original-qa-sky-v3',
    sky: { ...qaEnvironment.sky, brightness: 1 },
  };
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.scene')).toHaveAttribute(
    'data-environment-version',
    'original-qa-sky-v3',
  );
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'ready');
  const bright = await centerPixel(page);
  expect(bright[1], 'Recorded brightness must affect actual sky pixels').toBeGreaterThan(
    dim[1] + 15,
  );
  await page.screenshot({ path: info.outputPath('original-QA-sky-recovery.png') });
});

test('tagged original landscape stays behind main geometry even when it is physically closer to the camera', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let tagged = false;
  await install(
    page,
    { model: `/map-assets/${qaMap}/desktop/scene.glb`, mobile: null, overview: qaOverview },
    {
      model: (route) =>
        route.fulfill({
          contentType: 'model/gltf-binary',
          body: originalMapGLB(false, undefined, tagged ? 'tagged' : 'untagged'),
        }),
    },
  );
  await open(page);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute('data-landscape-state', 'missing');
  await camera(page, 'Overhead');
  await expect
    .poll(
      async () => {
        const pixel = await centerPixel(page);
        return pixel[2] > pixel[1] * 1.8;
      },
      { message: 'Untagged nearer original blue geometry must occlude the green floor' },
    )
    .toBe(true);
  tagged = true;
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  // New document clears the positive model cache because this fixture intentionally changes bytes at one URL.
  await page.goBack();
  await page.reload();
  await expect(page.locator('.scene')).toHaveAttribute('data-landscape-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Overhead');
  await expect
    .poll(
      async () => {
        const pixel = await centerPixel(page);
        return pixel[1] > pixel[2] + 5;
      },
      {
        message:
          'The same nearer blue geometry tagged as native sky must draw behind the main green floor',
      },
    )
    .toBe(true);
  await page.screenshot({ path: info.outputPath('original-QA-landscape-behind-main.png') });
});

test('paused viewer stops native rendering and camera, held keys, POV seeks and loaded sky explicitly request frames', async ({
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
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await install(
    page,
    {
      model: `/map-assets/${qaMap}/desktop/scene.glb`,
      mobile: null,
      overview: qaOverview,
      environment: qaEnvironment,
    },
    { playback: originalEnvironmentReplay() },
  );
  await installSky(page, async (face, route) => {
    await gate;
    await route.fulfill({ contentType: 'image/png', body: originalEnvironmentPNG(face) });
  });
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
  await idle();
  const initial = await frames();
  await Promise.all(
    ['/api/assets/agents', '/api/assets/equipment-models', '/api/assets/viewmodels'].map((path) =>
      page.waitForResponse((response) => new URL(response.url()).pathname === path),
    ),
  );
  await page.waitForTimeout(250);
  expect(await frames(), 'Unchanged asset discovery must leave the paused scene idle').toBe(
    initial,
  );
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
  before = await frames();
  release();
  await expect(page.locator('.scene')).toHaveAttribute('data-environment-state', 'ready');
  await expect.poll(frames).toBeGreaterThan(before);
  await expect
    .poll(async () => (await centerPixel(page)).map((value) => value > 100))
    .toEqual([true, false, false]);
  await idle();
});
