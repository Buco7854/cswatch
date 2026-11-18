import { expect, test, type Page, type Route } from '@playwright/test';
import { originalMapGLB, originalMapReplay } from './fixtures/original-map';
import { meshoptMapFixture } from '../../tools/assets/fixtures/meshopt-map.mjs';
import { compressGlbGeometry } from '../../tools/assets/meshopt-glb.mjs';

async function install(
  page: Page,
  custom?: (id: string, attempt: number, route: Route) => Promise<void>,
) {
  const counts = new Map<string, number>();
  await page.addInitScript(() => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({
        quality: 'high',
        autoHideControls: false,
        crosshair: false,
        matchScore: false,
        killReplay: false,
        grenadeLanding: false,
      }),
    );
    (window as unknown as { qaClosed: number; qaLost: number }).qaClosed = 0;
    (window as unknown as { qaLost: number }).qaLost = 0;
    (window as unknown as { qaRendered: WeakSet<HTMLCanvasElement> }).qaRendered = new WeakSet();
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function (mask: number) {
      (window as unknown as { qaRendered: WeakSet<HTMLCanvasElement> }).qaRendered.add(
        this.canvas as HTMLCanvasElement,
      );
      return clear.call(this, mask);
    };
    const close = ImageBitmap.prototype.close;
    ImageBitmap.prototype.close = function () {
      (window as unknown as { qaClosed: number }).qaClosed++;
      return close.call(this);
    };
  });
  for (const id of ['a', 'b', 'c', 'd']) {
    const map = `de_qa_cache_${id}`,
      demo = `cache-${id}`;
    await page.route(`**/api/demos/${demo}`, (route) =>
      route.fulfill({
        json: {
          id: demo,
          status: 'ready',
          map,
          public: true,
          owned: false,
          name: 'Original cache QA, not game artwork',
        },
      }),
    );
    await page.route(`**/api/demos/${demo}/playback`, (route) =>
      route.fulfill({ json: originalMapReplay(map) }),
    );
    await page.route(`**/api/maps/${map}`, (route) =>
      route.fulfill({
        json: { model: `/map-assets/${map}/desktop/scene.glb`, mobile: null, overview: null },
      }),
    );
    await page.route(`**/map-assets/${map}/desktop/scene.glb`, async (route) => {
      const attempt = (counts.get(id) || 0) + 1;
      counts.set(id, attempt);
      if (custom) return custom(id, attempt, route);
      await route.fulfill({
        contentType: 'model/gltf-binary',
        body: originalMapGLB(false, 'webp'),
      });
    });
  }
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
  return counts;
}
async function camera(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Camera mode', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function navigate(page: Page, id: string) {
  await page.evaluate((path) => {
    history.pushState({ ...history.state, idx: (history.state?.idx || 0) + 1 }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, '/watch/cache-' + id);
  await expect(page.locator('.viewer-match h1')).toContainText('cache_' + id);
}
async function ready(page: Page) {
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await expect
    .poll(() =>
      page
        .locator('.scene canvas')
        .evaluate((canvas) =>
          (window as unknown as { qaRendered: WeakSet<HTMLCanvasElement> }).qaRendered.has(
            canvas as HTMLCanvasElement,
          ),
        ),
    )
    .toBe(true);
}
async function observeContext(page: Page) {
  const count = await page.evaluate(() => (window as unknown as { qaLost: number }).qaLost);
  await page.locator('.scene canvas').evaluate((canvas) =>
    canvas.addEventListener(
      'webglcontextlost',
      () => {
        (window as unknown as { qaLost: number }).qaLost++;
      },
      { once: true },
    ),
  );
  return count;
}
async function contextGone(page: Page, previous: number) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { qaLost: number }).qaLost))
    .toBeGreaterThan(previous);
}

test('current-map2D remount keeps decoded bitmaps alive while LRU eviction closes only old maps and reloads valid textures', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const counts = await install(page);
  await page.goto('/watch/cache-a');
  await ready(page);
  let previous = await observeContext(page);
  await camera(page, '2D tactical · low power');
  await contextGone(page, previous);
  expect(await page.evaluate(() => (window as unknown as { qaClosed: number }).qaClosed)).toBe(0);
  await camera(page, 'Free camera');
  await ready(page);
  expect(counts.get('a')).toBe(1);
  for (const id of ['b', 'c', 'd']) {
    previous = await observeContext(page);
    await navigate(page, id);
    await ready(page);
    await contextGone(page, previous);
  }
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { qaClosed: number }).qaClosed))
    .toBeGreaterThan(0);
  await navigate(page, 'a');
  await ready(page);
  expect(counts.get('a')).toBe(2);
  // A real reloaded16x16 WebP must be decoded, not a closed cached ImageBitmap that merely retains metadata.
  const screenshot = await page.locator('.scene canvas').screenshot();
  const colored = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        ),
        surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = surface.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let red = 0,
        blue = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > pixels[i + 2] * 1.5 && pixels[i] > 60) red++;
        if (pixels[i + 2] > pixels[i] * 1.5 && pixels[i + 2] > 60) blue++;
      }
      bitmap.close();
      return { red, blue };
    },
    [...screenshot],
  );
  expect(colored.red).toBeGreaterThan(1000);
  expect(colored.blue).toBeGreaterThan(1000);
});

test('abandoned pending model aborts without poisoning a fresh same-URL navigation or another active model', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const counts = await install(page, async (id, attempt, route) => {
    if (id === 'a' && attempt === 1) {
      await gate;
      await route
        .fulfill({ contentType: 'model/gltf-binary', body: originalMapGLB(false, 'webp') })
        .catch(() => {});
      return;
    }
    await route.fulfill({ contentType: 'model/gltf-binary', body: originalMapGLB(false, 'webp') });
  });
  await page.goto('/watch/cache-a');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'pending');
  await expect.poll(() => counts.get('a')).toBe(1);
  await navigate(page, 'b');
  await ready(page);
  await navigate(page, 'a');
  release();
  await ready(page);
  expect(counts.get('a')).toBe(2);
  await expect(page.locator('.position-radar')).toBeVisible();
});

test('a native bitmap finishing after cancellation is closed before a fresh same-URL load can reuse the slot', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const counts = await install(page);
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    let first = true,
      release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    (window as unknown as { qaHeld: number; qaReleaseBitmap: () => void }).qaHeld = 0;
    (window as unknown as { qaReleaseBitmap: () => void }).qaReleaseBitmap = () => release();
    window.createImageBitmap = function (...args: unknown[]) {
      const decoded = Reflect.apply(original, window, args) as Promise<ImageBitmap>;
      if (first && args[0] instanceof Blob && args[0].type === 'image/webp') {
        first = false;
        return decoded.then((bitmap) => {
          (window as unknown as { qaHeld: number }).qaHeld++;
          return gate.then(() => bitmap);
        });
      }
      return decoded;
    } as typeof window.createImageBitmap;
  });
  await page.goto('/watch/cache-a');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { qaHeld: number }).qaHeld))
    .toBe(1);
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'pending');
  await navigate(page, 'b');
  await ready(page);
  await navigate(page, 'a');
  await page.evaluate(() =>
    (window as unknown as { qaReleaseBitmap: () => void }).qaReleaseBitmap(),
  );
  await ready(page);
  expect(counts.get('a')).toBe(2);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { qaClosed: number }).qaClosed))
    .toBeGreaterThan(0);
});

test('the private map loader decodes lossless Meshopt geometry with a local decoder and real rendered texture pixels', async ({
  page,
  baseURL,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const original = Buffer.from(await meshoptMapFixture()),
    jsonLength = original.readUInt32LE(12),
    document = JSON.parse(original.subarray(20, 20 + jsonLength).toString());
  // The index-preservation fixture winds downward. Author its QA material two-sided
  // for this above-camera rendering check, without changing any geometry/image bytes.
  for (const material of document.materials) material.doubleSided = true;
  const json = Buffer.from(
      JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length / 4) * 4, ' '),
    ),
    header = Buffer.from(original.subarray(0, 20)),
    binaryChunk = original.subarray(20 + jsonLength);
  header.writeUInt32LE(20 + json.length + binaryChunk.length, 8);
  header.writeUInt32LE(json.length, 12);
  const compressed = await compressGlbGeometry(Buffer.concat([header, json, binaryChunk])),
    external: string[] = [],
    origin = new URL(baseURL!).origin;
  expect(compressed.report.compressedViews).toBeGreaterThan(0);
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin)
      external.push(request.url());
  });
  let served = Buffer.concat([header, json, binaryChunk]);
  await install(page, async (_id, _attempt, route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: served }),
  );
  await page.goto('/watch/cache-a');
  await ready(page);
  await expect(page.locator('.scene')).toHaveAttribute('data-landscape-state', 'ready');
  const capture = async (name: string) => {
    let previous: Buffer | undefined;
    await expect
      .poll(async () => {
        const next = await page.locator('.scene canvas').screenshot();
        const same = Boolean(previous?.equals(next));
        previous = next;
        return same;
      })
      .toBe(true);
    return page.locator('.scene canvas').screenshot({ path: info.outputPath(name) });
  };
  const originalPixels = await capture('original-uncompressed.png');
  served = compressed.bytes;
  await page.reload();
  await ready(page);
  await expect(page.locator('.scene')).toHaveAttribute('data-landscape-state', 'ready');
  const screenshot = await capture('original-lossless-meshopt.png');
  expect(
    screenshot.equals(originalPixels),
    'Lossless compressed geometry must render exactly the same original pixels',
  ).toBe(true);
  const detail = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        ),
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const left = Math.floor(bitmap.width * 0.35),
        right = Math.ceil(bitmap.width * 0.65),
        top = Math.floor(bitmap.height * 0.3),
        bottom = Math.ceil(bitmap.height * 0.7),
        offset = (top * bitmap.width + left) * 4,
        background = [pixels[offset], pixels[offset + 1], pixels[offset + 2]],
        colors = new Set<string>();
      let count = 0,
        min = 255,
        max = 0;
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) {
          const i = (y * bitmap.width + x) * 4;
          if (
            Math.max(...background.map((value, index) => Math.abs(value - pixels[i + index]))) <= 12
          )
            continue;
          const luminance = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
          min = Math.min(min, luminance);
          max = Math.max(max, luminance);
          count++;
          colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        }
      bitmap.close();
      return { count, contrast: max - min, colors: colors.size };
    },
    [...screenshot],
  );
  expect(
    detail.count,
    'Original decoded surface must occupy actual non-HUD background pixels',
  ).toBeGreaterThan(1000);
  expect(
    detail.contrast,
    'Original checker and vertex-color detail must remain visible',
  ).toBeGreaterThan(20);
  expect(detail.colors).toBeGreaterThan(16);
  expect(external).toEqual([]);
});
