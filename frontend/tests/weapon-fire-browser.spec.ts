import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { installDemoMapDescriptor } from './fixtures/map-assets';
import { originalMapGLB, qaActor } from './fixtures/original-map';
import { installOriginalCameraProbe, originalCameraView } from './fixtures/original-camera';
import {
  originalEquipmentCatalog,
  originalEquipmentGLB,
  originalEquipmentReplay,
} from './fixtures/original-equipment';

async function firePixels(page: Page, prop = false, capture?: string) {
  const bytes = await page.locator('.scene canvas').screenshot({
    ...(capture ? { path: capture } : {}),
    // A locator screenshot is composited: dialogs, focus rings and overlays
    // above the canvas still paint into it. Measure rendered game pixels only.
    style: 'body :not(canvas):not(:has(canvas)) { visibility: hidden !important; }',
  });
  return page.evaluate(
    async ({ bytes, prop }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = surface.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, surface.width, surface.height).data;
      let warm = 0;
      for (let at = 0; at < pixels.length; at += 4)
        if (
          prop
            ? pixels[at] > 180 && pixels[at + 1] < 80 && pixels[at + 2] > 180
            : pixels[at] > 180 &&
              pixels[at + 1] > 75 &&
              pixels[at + 2] < 170 &&
              pixels[at] > pixels[at + 1] * 1.12
        )
          warm++;
      return warm;
    },
    { bytes: [...bytes], prop },
  );
}

async function fixture(page: Page, wall = false) {
  await installOriginalCameraProbe(page);
  const replay = originalEquipmentReplay();
  // Stable original positions make actual flash pixels independent of camera motion.
  replay.frames = replay.frames.map((frame) => ({
    ...frame,
    players: replay.frames[0].players.map((player) => ({ ...player })),
  }));
  replay.itemSamples = [];
  replay.grenades = [];
  replay.events = [64, 128].map((tick) => ({
    type: 'weapon_fire',
    tick,
    user_steamid: qaActor,
    weapon: 'ak47',
  }));
  const body = originalEquipmentGLB([1, 0, 1], true),
    catalog = originalEquipmentCatalog(['ak47']);
  catalog.items.ak47.sha256 = createHash('sha256').update(body).digest('hex');
  catalog.items.ak47.bytes = body.length;
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    for (const key of ['viewer-settings', 'viewer-settings-mobile'])
      localStorage.setItem(
        key,
        JSON.stringify({
          quality: key.endsWith('mobile') ? 'low' : 'high',
          autoHideControls: false,
          radar: false,
          economy: false,
          utilities: false,
          trajectories: false,
          matchScore: false,
          xray: false,
          crosshair: false,
          playerLabels: false,
          killReplay: false,
          grenadeLanding: false,
        }),
      );
  });
  await page.route('**/api/demos/fire-qa', (route) =>
    route.fulfill({
      json: {
        id: 'fire-qa',
        name: 'Original firing QA, not CS2 artwork',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
      },
    }),
  );
  await page.route('**/api/demos/fire-qa/playback', (route) => fulfillReplayFixture(route, replay));
  const model = `/map-assets/${replay.map}/desktop/scene.glb`;
  await installDemoMapDescriptor(page, 'fire-qa', {
    model,
    mobile: null,
    overview: null,
    environment: null,
  });
  await page.route('**' + model, (route) =>
    route.fulfill({
      contentType: 'model/gltf-binary',
      body: wall
        ? originalEquipmentGLB([0.1, 0.35, 0.5], false, {
            position: [0, 1.65, -512 * 0.0254 + 0.2],
            scale: [30, 70, 1],
          })
        : originalMapGLB(),
    }),
  );
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
  await page.route('**/api/assets/equipment-models', (route) =>
    route.fulfill({ json: { ...catalog, complete: true } }),
  );
  await page.route('**/api/assets/equipment-models/ak47.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body }),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/watch/fire-qa');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  return errors;
}

async function renderedPovReady(page: Page) {
  const [view, canvas] = await Promise.all([
    originalCameraView(page),
    page.locator('.scene canvas').evaluate((element) => {
      // Three keeps the canvas's own CSS width at the last rendered size.
      // Its observed container is the current layout requirement.
      const rect = element.parentElement!.getBoundingClientRect(),
        low = element.closest('.scene')?.getAttribute('data-quality') === 'low',
        dpr = low ? 1 : Math.max(1, Math.min(1.75, devicePixelRatio));
      return { width: rect.width, height: rect.height, dpr };
    }),
  ]);
  const aspect = view.projection[5] / view.projection[0];
  return (
    view.position.length === 3 &&
    Math.abs(view.position[0] - -512 * 0.0254) < 0.00002 &&
    Math.abs(view.position[1] - 1.65) < 0.00002 &&
    Math.abs(view.position[2]) < 0.00002 &&
    Number.isFinite(aspect) &&
    Math.abs(aspect - canvas.width / canvas.height) < 0.00001 &&
    view.drawingBuffer[0] === Math.floor(canvas.width * canvas.dpr) &&
    view.drawingBuffer[1] === Math.floor(canvas.height * canvas.dpr)
  );
}

async function waitForRenderedPov(page: Page) {
  await expect
    .poll(() => renderedPovReady(page), {
      message: 'Wait for the actual POV draw, projection and drawing-buffer size after resize',
    })
    .toBe(true);
}

async function pov(page: Page) {
  await page.getByRole('combobox', { name: 'Camera mode', exact: true }).click();
  await page.getByRole('option', { name: 'Player perspective', exact: true }).click();
  await expect(page.locator('.scene')).toHaveAttribute(
    'data-equipment-ready-instances',
    new RegExp('pov:' + qaActor),
  );
}

test('recorded shots render at the model muzzle in both themes and low-quality portrait, pause deterministically and disappear on seeks or opt-out', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const errors = await fixture(page);
  await pov(page);
  let lastIdle = 0;
  for (const theme of ['dark', 'light'])
    for (const width of [1440, 768, 390]) {
      await test.step(`${theme} viewer at ${width}px`, async () => {
        await page.emulateMedia({ reducedMotion: width === 390 ? 'reduce' : 'no-preference' });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
          await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
          await page
            .getByRole('menuitem', { name: `Switch to ${theme} theme`, exact: true })
            .click();
        }
        await page.locator('.timeline-slider').fill('0');
        await waitForRenderedPov(page);
        const idle = await firePixels(page, false, info.outputPath(`idle-${theme}-${width}.png`));
        lastIdle = idle;
        await page.locator('.timeline-slider').fill('64');
        await expect.poll(() => firePixels(page)).toBeGreaterThan(idle + 30);
        const paused = await firePixels(page);
        expect(
          await firePixels(page),
          'Paused recorded fire remains at the same demo-time pose',
        ).toBe(paused);
        await page.screenshot({ path: info.outputPath(`firing-${theme}-${width}.png`) });
        if (theme === 'dark' && width === 1440) {
          // Keep the same paused shot and its map ray alive while crossing the lens breakpoint.
          await page.setViewportSize({ width: 768, height: 900 });
          await waitForRenderedPov(page);
          await page.screenshot({ path: info.outputPath('firing-dark-768-resized.png') });
          await page.setViewportSize({ width, height: 900 });
          await waitForRenderedPov(page);
        }

        await page.locator('.timeline-slider').fill('128');
        await expect.poll(() => firePixels(page)).toBeGreaterThan(idle + 30);
        await page.locator('.timeline-slider').fill('64');
        await expect
          .poll(() => firePixels(page), {
            message: 'Returning to an earlier shot restores its deterministic visual variant',
          })
          .toBe(paused);
        await page.locator('.timeline-slider').fill('80');
        await expect
          .poll(() => firePixels(page, false, info.outputPath(`after80-${theme}-${width}.png`)))
          .toBe(idle);
      });
    }
  await page.locator('.timeline-slider').fill('64');
  let language = 'en';
  for (const locale of ['en', 'fr']) {
    if (language !== locale) {
      await page
        .getByRole('button', {
          name: language === 'fr' ? 'Menu du lecteur' : 'Viewer menu',
          exact: true,
        })
        .click();
      await page
        .getByRole('menuitem', { name: locale === 'fr' ? 'Français' : 'English', exact: true })
        .click();
      language = locale;
    }
    for (const theme of ['dark', 'light']) {
      const french = locale === 'fr';
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
        await page
          .getByRole('button', { name: french ? 'Menu du lecteur' : 'Viewer menu', exact: true })
          .click();
        await page
          .getByRole('menuitem', {
            name: french
              ? theme === 'light'
                ? 'Passer au thème clair'
                : 'Passer au thème sombre'
              : `Switch to ${theme} theme`,
            exact: true,
          })
          .click();
      }
      const close = () =>
        page
          .getByRole('button', {
            name: french ? 'Fermer les options du lecteur' : 'Close viewer options',
            exact: true,
          })
          .click();
      const shot = page.getByRole('switch', { name: french ? /^Effets de tir/ : /^Shot effects/ });
      await page.getByRole('button', { name: 'Options', exact: true }).click();
      await shot.check();
      await close();
      await expect.poll(() => firePixels(page)).toBeGreaterThan(lastIdle + 30);
      await page.getByRole('button', { name: 'Options', exact: true }).click();
      await shot.scrollIntoViewIfNeeded();
      expect(
        await shot.evaluate((input) => {
          const row = input.closest('label')!,
            copy = row.querySelector('.viewer-option-copy')!,
            panel = row.closest('[role="tabpanel"]')!,
            dialog = row.closest('dialog')!,
            box = row.getBoundingClientRect(),
            view = panel.getBoundingClientRect();
          return (
            copy.scrollWidth <= copy.clientWidth + 1 &&
            panel.scrollWidth <= panel.clientWidth + 1 &&
            dialog.scrollWidth <= dialog.clientWidth + 1 &&
            box.left >= view.left &&
            box.right <= view.right &&
            box.top >= view.top - 1 &&
            box.bottom <= view.bottom + 1
          );
        }),
      ).toBe(true);
      await shot.uncheck();
      await page.screenshot({ path: info.outputPath(`shot-options-${locale}-${theme}-390.png`) });
      await close();
      expect(await firePixels(page)).toBe(lastIdle);
    }
  }
  expect(errors).toEqual([]);
});

test('first-person equipment has independent depth and remains visible when a real wall is nearer than its entire model', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixture(page, true);
  expect(
    await firePixels(page, true),
    'The actual near wall occludes world equipment in free view',
  ).toBe(0);
  await pov(page);
  await expect
    .poll(() => firePixels(page, true), {
      message:
        'A separate first-person depth pass must render the actual prop in front of nearer map geometry',
    })
    .toBeGreaterThan(1000);
  await page.screenshot({ path: info.outputPath('near-wall-independent-pov.png') });
  expect(errors).toEqual([]);
});

test('rendered POV readiness waits for the real resize draw while model metadata stays ready', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(() => {
    const OriginalResizeObserver = ResizeObserver;
    let held = false;
    const pending: (() => void)[] = [];
    const gate = {
      hold: () => {
        held = true;
      },
      get pending() {
        return pending.length;
      },
      release: () => {
        held = false;
        for (const deliver of pending.splice(0)) deliver();
      },
    };
    (window as unknown as { qaResizeGate: typeof gate }).qaResizeGate = gate;
    window.ResizeObserver = class extends OriginalResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const canvas = document.querySelector('.scene canvas');
          if (held && canvas && entries.some((entry) => entry.target.contains(canvas)))
            pending.push(() => callback(entries, observer));
          else callback(entries, observer);
        });
      }
    };
  });
  const errors = await fixture(page);
  await pov(page);
  await waitForRenderedPov(page);
  const before = await originalCameraView(page);
  await page.evaluate(() => {
    (window as unknown as { qaResizeGate: { hold: () => void } }).qaResizeGate.hold();
    // A layout-driven resize exercises observer delivery without a separate
    // native window resize listener racing around the controlled gate.
    (document.querySelector('.scene') as HTMLElement).style.width = 'calc(100% - 137px)';
  });
  await page.waitForFunction(
    () => (window as unknown as { qaResizeGate: { pending: number } }).qaResizeGate.pending > 0,
  );
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.scene')).toHaveAttribute(
    'data-equipment-ready-instances',
    new RegExp('pov:' + qaActor),
  );
  expect(
    await renderedPovReady(page),
    'Loaded metadata must not certify the stale rendered projection',
  ).toBe(false);
  expect((await originalCameraView(page)).drawingBuffer).toEqual(before.drawingBuffer);
  let resolved = false;
  const readiness = waitForRenderedPov(page).then(() => {
    resolved = true;
  });
  try {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      resolved,
      'Two browser frames cannot satisfy readiness while resize delivery is held',
    ).toBe(false);
  } finally {
    await page.evaluate(() =>
      (window as unknown as { qaResizeGate: { release: () => void } }).qaResizeGate.release(),
    );
    await readiness;
  }
  expect((await originalCameraView(page)).drawingBuffer).not.toEqual(before.drawingBuffer);
  const idle = await firePixels(page, false, info.outputPath('resized-idle.png'));
  await page.locator('.timeline-slider').fill('64');
  await expect.poll(() => firePixels(page)).toBeGreaterThan(idle + 30);
  await page.locator('.timeline-slider').fill('80');
  await expect.poll(() => firePixels(page)).toBe(idle);
  expect(errors).toEqual([]);
});
