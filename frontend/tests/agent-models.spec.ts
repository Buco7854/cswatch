import { chooseCameraControl } from './fixtures/viewer-transport';
import { nativeMap } from './fixtures/native-map';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { manualMapAssets } from './fixtures/map-assets';
import { originalOverviewPNG, qaOverview } from './fixtures/original-map';
import { expect, test, type Page } from '@playwright/test';
import { originalMapReplay } from './fixtures/original-map';
import { originalAgentGLB, originalAnimatedAgentGLB } from './fixtures/original-agent';
import { modelResourceId } from '../../shared/model-resource-id.mjs';

async function camera(page: Page, name: string) {
  await chooseCameraControl(page, name);
}
async function install(
  page: Page,
  badT = false,
  variant?: { handle: string; body: Buffer; prepared: boolean },
) {
  const replay = originalMapReplay('de_agent_qa'),
    requests = { ct: 0, t: 0, variant: 0 };
  if (variant)
    for (const frame of replay.frames)
      for (const player of frame.players)
        // The recorded handle belongs to the T opponent facing the free camera; the CT
        // reviewer keeps the team default.
        if (player.team === 2) player.agentModel = variant.handle;
  let missingT = false;
  replay.events = [];
  replay.grenades = [];
  // Ground-level free view begins at the reviewer. Face the other recorded
  // actor toward that camera so the asymmetric authored front remains visible.
  for (const frame of replay.frames) frame.players[1].yaw = 180;
  // This QA uses the actual authored courtyard extents, unlike the deliberately
  // oversized coordinate fixture used to test overview calibration.
  replay.worldBounds = { minX: -768, maxX: 768, minY: -512, maxY: 512, minZ: 0, maxZ: 128 };
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem('theme', 'dark');
    localStorage.setItem(
      'viewer-settings-v2',
      JSON.stringify({
        quality: 'high',
        autoHideControls: false,
        matchScore: false,
        xray: false,
        crosshair: false,
        playerLabels: false,
        killReplay: false,
        grenadeLanding: false,
      }),
    );
  });
  await page.route('**/api/demos/agent-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'agent-fixture',
        name: 'Original skinned agent QA, not game artwork',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
      },
    }),
  );
  await page.route('**/api/demos/agent-fixture/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await page.route('**/api/demos/agent-fixture/map-assets', (route) =>
    route.fulfill({
      json: manualMapAssets({
        model: nativeMap(replay.map).model('agent-fixture'),
        overview: { ...qaOverview, image: `/api/maps/${replay.map}/overview.png` },
      }),
    }),
  );
  await nativeMap(replay.map).route(page);
  await page.route('**/api/assets/equipment-models', (route) =>
    route.fulfill({ json: { schemaVersion: 1, items: {} } }),
  );
  await page.route(`**/api/maps/${replay.map}/overview.png`, (route) =>
    route.fulfill({ contentType: 'image/png', body: originalOverviewPNG() }),
  );
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({
      json: {
        ct: '/map-assets/agents/ct.glb',
        t: missingT ? null : '/map-assets/agents/t.glb',
        models: variant?.prepared
          ? { [variant.handle]: `/map-assets/agent-models/${variant.handle}.glb` }
          : {},
      },
    }),
  );
  await page.route('**/map-assets/agent-models/*.glb', (route) => {
    requests.variant++;
    return route.fulfill({
      contentType: 'model/gltf-binary',
      body: variant?.body ?? Buffer.alloc(0),
    });
  });
  await page.route('**/map-assets/agents/*.glb', (route) => {
    const team = new URL(route.request().url()).pathname.includes('/ct.glb') ? 'ct' : 't';
    requests[team]++;
    return route.fulfill({
      contentType: 'model/gltf-binary',
      body: team === 't' && badT ? originalAgentGLB() : originalAnimatedAgentGLB(),
    });
  });
  return {
    requests,
    hideT: () => (missingT = true),
    prepare: () => variant && (variant.prepared = true),
  };
}
/** The QA skin recoloured, so a swapped-in recorded agent is visible as its own colour. */
function recoloured(glb: Buffer, color: [number, number, number]) {
  const length = glb.readUInt32LE(12),
    json = JSON.parse(glb.subarray(20, 20 + length).toString()),
    binary = glb.subarray(20 + length);
  json.materials[0].pbrMetallicRoughness.baseColorFactor = [...color, 1];
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + binary.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, text, binary]);
}
/** Pixels whose `channel` (0 red, 2 blue) dominates: a recoloured skin or the team model. */
async function countDominant(page: Page, channel: 0 | 2) {
  const shot = await page.locator('.scene canvas').screenshot();
  return page.evaluate(
    async ({ bytes, channel }) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        ),
        surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = surface.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, surface.width, surface.height).data;
      const [a, b] = [0, 1, 2].filter((other) => other !== channel);
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const value = pixels[i + channel];
        if (value > 120 && value > pixels[i + a] * 2 && value > pixels[i + b] * 2) count++;
      }
      return count;
    },
    { bytes: [...shot], channel },
  );
}
async function open(page: Page) {
  await page.goto('/watch/agent-fixture?tick=0');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
}

test('invalid directional packs and missing native actors retain generic bodies while another actor and the actual3Dmap stay available', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const fixture = await install(page, true);
  await open(page);
  await camera(page, 'Overhead');
  const scene = page.locator('.scene');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '1');
  await expect(scene).toHaveAttribute('data-agent-error-count', '1');
  await expect(scene).toHaveAttribute('data-agent-fallback-count', '1');
  await expect(page.locator('.scene canvas')).toBeVisible();
  await expect(page.locator('.tactical-plot')).toHaveCount(0);
  await camera(page, 'Player perspective');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '0');
  await expect(scene).toHaveAttribute('data-agent-fallback-count', '1');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  fixture.hideT();
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.locator('.viewer-frame')).toHaveCount(0);
  await page.goBack();
  await camera(page, 'Overhead');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '1');
  await expect(scene).toHaveAttribute('data-agent-error-count', '0');
  await expect(scene).toHaveAttribute('data-agent-fallback-count', '1');
  expect(fixture.requests).toEqual({ ct: 1, t: 1, variant: 0 });
});

test('skinned original native-axis agents release cloned bone textures on POV removal and reuse live cached bodies through2D', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.addInitScript(() => {
    const bindings = new WeakMap<WebGL2RenderingContext, Map<number, WebGLTexture | null>>(),
      bones = new Set<WebGLTexture>(),
      deleted = new Set<WebGLTexture>();
    const bind = WebGL2RenderingContext.prototype.bindTexture,
      image = WebGL2RenderingContext.prototype.texImage2D,
      dispose = WebGL2RenderingContext.prototype.deleteTexture;
    (
      window as unknown as { qaAgentBoneStats: () => { uploaded: number; disposed: number } }
    ).qaAgentBoneStats = () => ({ uploaded: bones.size, disposed: deleted.size });
    WebGL2RenderingContext.prototype.bindTexture = function (target, texture) {
      let current = bindings.get(this);
      if (!current) {
        current = new Map();
        bindings.set(this, current);
      }
      current.set(target, texture);
      return bind.call(this, target, texture);
    };
    WebGL2RenderingContext.prototype.texImage2D = function (...args) {
      if (
        args.length === 9 &&
        args[6] === this.RGBA &&
        args[7] === this.FLOAT &&
        args[8] instanceof Float32Array
      ) {
        const texture = bindings.get(this)?.get(args[0]);
        if (texture) bones.add(texture);
      }
      return image.apply(this, args as Parameters<typeof image>);
    } as typeof image;
    const subImage = WebGL2RenderingContext.prototype.texSubImage2D;
    WebGL2RenderingContext.prototype.texSubImage2D = function (...args) {
      if (
        args.length === 9 &&
        args[6] === this.RGBA &&
        args[7] === this.FLOAT &&
        args[8] instanceof Float32Array
      ) {
        const texture = bindings.get(this)?.get(args[0]);
        if (texture) bones.add(texture);
      }
      return subImage.apply(this, args as Parameters<typeof subImage>);
    } as typeof subImage;
    WebGL2RenderingContext.prototype.deleteTexture = function (texture) {
      if (texture && bones.has(texture)) deleted.add(texture);
      return dispose.call(this, texture);
    };
  });
  const { requests } = await install(page);
  await open(page);
  await page.locator('.timeline-slider').fill('0');
  await camera(page, 'Free camera');
  const scene = page.locator('.scene'),
    stats = () =>
      page.evaluate(() =>
        (
          window as unknown as { qaAgentBoneStats: () => { uploaded: number; disposed: number } }
        ).qaAgentBoneStats(),
      );
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  await expect(scene).toHaveAttribute('data-agent-fallback-count', '0');
  const colors = await page.locator('.scene canvas').screenshot();
  const visibleColors = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        ),
        surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = surface.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, surface.width, surface.height).data;
      let blue = 0,
        green = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        // The native map grade maps the original blue material to about (26, 39, 180).
        if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] > 150) blue++;
        // ACES maps the original green material to approximately(142,224,103).
        // Channel contrast distinguishes it from the neutral/gray-green courtyard.
        if (
          pixels[i + 1] > 150 &&
          pixels[i + 1] > pixels[i] * 1.5 &&
          pixels[i + 1] > pixels[i + 2] * 1.5
        )
          green++;
      }
      return { blue, green };
    },
    [...colors],
  );
  await page.screenshot({ path: info.outputPath('original-native-axis-skinned-agents.png') });
  expect(
    visibleColors.blue,
    'Original skinned body must draw actual blue geometry',
  ).toBeGreaterThan(10);
  expect(visibleColors.green, 'Asymmetric native-front marker must actually draw').toBeGreaterThan(
    5,
  );
  // Free view intentionally hides a body intersecting its own eye. Use the
  // explicit overview to render both bodies and exercise both GPU bone textures.
  await camera(page, 'Overhead');
  await expect.poll(async () => (await stats()).uploaded).toBeGreaterThanOrEqual(2);
  const before = await stats();
  await camera(page, 'Player perspective');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '1');
  await expect.poll(async () => (await stats()).disposed).toBeGreaterThan(before.disposed);
  await camera(page, 'Overhead');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  await expect.poll(async () => (await stats()).uploaded).toBeGreaterThan(before.uploaded);
  await camera(page, '2D tactical · low power');
  await expect(page.locator('.tactical-plot')).toBeVisible();
  await camera(page, 'Overhead');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  expect(requests).toEqual({ ct: 1, t: 1, variant: 0 });
});

test('a recorded official agent swaps in once prepared, animated by its team clips', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  // tm_leet/tm_leet_varianta: a catalogued T agent. Its skin has no clips of its own.
  const handle = modelResourceId('characters/models/tm_leet/tm_leet_varianta.vmdl');
  const variant = {
    handle,
    body: recoloured(originalAgentGLB(), [0.9, 0.04, 0.02]),
    prepared: false,
  };
  const fixture = await install(page, false, variant);
  await open(page);
  await page.locator('.timeline-slider').fill('0');
  await camera(page, 'Free camera');
  const scene = page.locator('.scene');
  // Not prepared yet: the team model renders and nothing else is requested.
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  expect(await countDominant(page, 0)).toBe(0);
  expect(fixture.requests.variant).toBe(0);
  // Discovery continues while a recorded agent is missing, then swaps it in.
  fixture.prepare();
  await expect.poll(() => fixture.requests.variant, { timeout: 60000 }).toBe(1);
  await expect.poll(() => countDominant(page, 0), { timeout: 30000 }).toBeGreaterThan(10);
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  await expect(scene).toHaveAttribute('data-agent-error-count', '0');
  await expect(scene).toHaveAttribute('data-agent-fallback-count', '0');
  await page.screenshot({ path: info.outputPath('recorded-agent-variant.png') });
  expect(fixture.requests).toEqual({ ct: 1, t: 1, variant: 1 });
});

test('an unusable recorded agent keeps the team model', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const handle = modelResourceId('characters/models/tm_leet/tm_leet_varianta.vmdl');
  const fixture = await install(page, false, {
    handle,
    body: Buffer.from('Not a GLB'),
    prepared: true,
  });
  await open(page);
  await camera(page, 'Overhead');
  const scene = page.locator('.scene');
  await expect.poll(() => fixture.requests.variant, { timeout: 60000 }).toBe(1);
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  await expect(scene).toHaveAttribute('data-agent-error-count', '0');
  await expect(scene).toHaveAttribute('data-agent-fallback-count', '0');
  await page.locator('.timeline-slider').fill('0');
  await camera(page, 'Free camera');
  await expect.poll(() => countDominant(page, 2)).toBeGreaterThan(10);
  expect(await countDominant(page, 0)).toBe(0);
});
