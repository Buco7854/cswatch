import { chooseCameraControl, expectCameraControl } from './fixtures/viewer-transport';
import { nativeMap, sourcePoint } from './fixtures/native-map';
import { installOriginalCameraProbe } from './fixtures/original-camera';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { manualMapAssets } from './fixtures/map-assets';
import { expect, test, type Page } from '@playwright/test';
import { originalMapReplay, qaActor } from './fixtures/original-map';
import { originalAnimatedAgentGLB } from './fixtures/original-agent';
import { originalEquipmentCatalog, originalEquipmentGLB } from './fixtures/original-equipment';
import { worldQueries } from '../src/world/queries';
import type { Manifest } from '../src/world/format';
import type { FollowCamera } from '../src/follow-camera';

test('follow camera retracts at an opaque wall and reproduces its position after a seek', () => {
  // A 6 x 4 m wall facing the actor at viewer x = -1 m, in native Source inches.
  const floats = new Float32Array(4 * 15);
  [
    [-1, -1, -3],
    [-1, -1, 3],
    [-1, 3, 3],
    [-1, 3, -3],
  ].forEach((point, index) => floats.set(sourcePoint(point), index * 15));
  const manifest = {
    entities: [],
    chunks: [
      {
        sky: false,
        family: 'opaque',
        ranges: [{ first: 0, count: 6, vertices: 4, entity: -1, material: 0 }],
      },
    ],
  } as unknown as Manifest;
  const trace = worldQueries(
    manifest,
    new Uint8Array(floats.buffer),
    Uint32Array.of(0, 1, 2, 0, 2, 3),
  ).trace;
  const view: FollowCamera = { actor: '1', position: [-2.6, 1, 0], target: [0, 1, 0] };
  const clipped = trace(view);
  expect(clipped[0]).toBeGreaterThan(-1);
  expect(clipped[0]).toBeLessThan(0);
  const clear: FollowCamera = { ...view, position: [2.6, 1, 0] };
  const tracerTrace = trace.fork();
  expect(tracerTrace(clear)).toEqual(clear.position);
  expect(trace(view)).toEqual(clipped);
  expect(trace(clear)).toEqual(clear.position);
  expect(trace(view)).toEqual(clipped);
});

async function mode(page: Page, name: string) {
  await chooseCameraControl(page, name);
}

test('third-person follow renders the selected actor, follows real recorded transforms and backward seeks without changing POV or FOV', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings-v2',
      JSON.stringify({
        quality: 'low',
        cameraFov: 75,
        economy: true,
        autoHideControls: false,
        matchScore: false,
        xray: false,
        // This pixel assertion isolates the selected head/feet marker.
        // Other players' new health text is independently covered by spectator HUD tests.
        playerLabels: false,
        crosshair: false,
        killReplay: false,
        grenadeLanding: false,
      }),
    );
    const locations = new WeakMap<WebGLUniformLocation, string>(),
      floorPrograms = new WeakSet<WebGLProgram>(),
      activePrograms = new WeakMap<WebGL2RenderingContext, WebGLProgram | null>(),
      use = WebGL2RenderingContext.prototype.useProgram,
      get = WebGL2RenderingContext.prototype.getUniformLocation,
      vec = WebGL2RenderingContext.prototype.uniform3f,
      arr = WebGL2RenderingContext.prototype.uniform3fv,
      mat = WebGL2RenderingContext.prototype.uniformMatrix4fv;
    const state: { position: number[] | null; projection: number[] | null } = {
      position: null,
      projection: null,
    };
    // The native world program reports the camera; see the shared original camera probe.
    Object.defineProperty(window, 'qaFollowCamera', {
      get: () => {
        const view = (
          window as unknown as { qaOriginalCamera?: { position: number[]; projection: number[] } }
        ).qaOriginalCamera;
        return view?.position.length
          ? { position: view.position, projection: view.projection }
          : state;
      },
    });
    WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
      const location = get.call(this, program, name);
      if (location && name === 'roughness') floorPrograms.add(program);
      if (
        location &&
        (name === 'cameraPosition' || name === 'projectionMatrix' || name === 'modelViewMatrix')
      )
        locations.set(location, name);
      return location;
    };
    WebGL2RenderingContext.prototype.useProgram = function (program) {
      activePrograms.set(this, program);
      return use.call(this, program);
    };
    WebGL2RenderingContext.prototype.uniform3f = function (location, x, y, z) {
      if (location && locations.get(location) === 'cameraPosition') state.position = [x, y, z];
      return vec.call(this, location, x, y, z);
    };
    WebGL2RenderingContext.prototype.uniform3fv = function (location, value, ...rest) {
      if (location && locations.get(location) === 'cameraPosition')
        state.position = Array.from(value).slice(0, 3);
      return arr.call(this, location, value, ...rest);
    };
    WebGL2RenderingContext.prototype.uniformMatrix4fv = function (
      location,
      transpose,
      value,
      ...rest
    ) {
      const program = activePrograms.get(this);
      if (
        location &&
        program &&
        floorPrograms.has(program) &&
        locations.get(location) === 'projectionMatrix'
      )
        state.projection = Array.from(value);
      if (
        location &&
        locations.get(location) === 'modelViewMatrix' &&
        program &&
        floorPrograms.has(program)
      ) {
        // The original floor is the only standard material. Its model is exactly
        // the documented +90Y S2V transform. Invert the native orthonormal MV
        // translation, then rotate model-space camera coordinates into world.
        const m = Array.from(value),
          x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
          y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
          z = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
        state.position = [z, y, -x];
      }
      return mat.call(this, location, transpose, value, ...rest);
    };
  });
  const replay = originalMapReplay('de_follow_qa'),
    other = replay.players[1].id;
  replay.events = [];
  replay.grenades = [];
  replay.worldBounds = { minX: -768, maxX: 768, minY: -512, maxY: 512, minZ: 0, maxZ: 128 };
  replay.frames = [0, 64, 128].map((tick, index) => ({
    tick,
    players: replay.frames[0].players.map((player, i) => ({
      ...player,
      x: i ? [256, 256, 128][index] : [-256, 0, 256][index],
      y: i ? [0, -128, 0][index] : [0, 128, 0][index],
      yaw: i ? [180, 270, 360][index] : [0, 90, 180][index],
      duck: !i && index === 1 ? 1 : 0,
    })),
  }));
  // A disconnected actor has no recorded transform in this later slice.
  replay.frames[2].players = replay.frames[2].players.filter((player) => player.id !== other);
  await page.route('**/api/demos/follow-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'follow-fixture',
        name: 'Original follow camera QA, not game artwork',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
      },
    }),
  );
  await page.route('**/api/demos/follow-fixture/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await page.route('**/api/demos/follow-fixture/map-assets', (route) =>
    route.fulfill({
      json: manualMapAssets({
        model: nativeMap(replay.map).model('follow-fixture'),
        overview: null,
      }),
    }),
  );
  await nativeMap(replay.map).route(page);
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: '/map-assets/agents/ct.glb', t: '/map-assets/agents/t.glb' } }),
  );
  await page.route('**/map-assets/agents/*.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalAnimatedAgentGLB() }),
  );
  await page.route('**/api/assets/equipment-models', (route) =>
    route.fulfill({ json: originalEquipmentCatalog(['ak47']) }),
  );
  await page.route('**/api/assets/equipment-models/*.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalEquipmentGLB() }),
  );
  await installOriginalCameraProbe(page);
  await page.goto('/watch/follow-fixture?tick=0');
  const scene = page.locator('.scene'),
    position = () =>
      page.evaluate(
        () =>
          (window as unknown as { qaFollowCamera: { position: number[] | null } }).qaFollowCamera
            .position,
      );
  const checkPosition = async (expected: number[]) => {
    await expect
      .poll(async () => {
        const actual = await position();
        return actual
          ? Math.max(...actual.map((value, index) => Math.abs(value - expected[index])))
          : Infinity;
      })
      .toBeLessThan(0.00001);
  };
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  await mode(page, 'Free camera');
  await mode(page, 'Third-person follow');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  await expect(scene).toHaveAttribute(
    'data-equipment-ready-instances',
    new RegExp('held:' + qaActor + ':ak47'),
  );
  expect(await scene.getAttribute('data-equipment-ready-instances')).not.toContain('pov:');
  await checkPosition([-8.6524, 1.6, 1.6]);
  await page.locator('.timeline-slider').fill('64');
  await checkPosition([1.6, 0.9, -1.1012]);
  await page
    .locator(
      `.review-economy-frame .broadcast-player[data-player-id="${other}"] .broadcast-player-select`,
    )
    .click();
  await expectCameraControl(page, 'Player perspective');
  await checkPosition([6.5024, 1.65, 3.2512]);
  await mode(page, 'Third-person follow');
  await checkPosition([4.9024, 1.6, 1.1012]);
  await page.locator('.timeline-slider').fill('128');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '1');
  await checkPosition([4.9024, 1.6, 1.1012]);
  await page.locator('.timeline-slider').fill('0');
  await checkPosition([8.6524, 1.6, -1.6]);
  await expect(
    page.locator(
      `.review-economy-frame .broadcast-player[data-player-id="${other}"] .broadcast-player-select`,
    ),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { qaFollowCamera: { projection: number[] | null } }).qaFollowCamera
            .projection?.[5] || 0,
      ),
    )
    .toBeCloseTo(1 / Math.tan((75 * Math.PI) / 360), 5);
  await page.locator('.viewer-stage').focus();
  await page.keyboard.press('w');
  await checkPosition([8.6524, 1.6, -1.6]);
  await page.keyboard.press('h');
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'false');
  await expect
    .poll(() =>
      page
        .locator('.viewer-frame [data-viewer-chrome]')
        .evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              getComputedStyle(node).opacity === '0' &&
              getComputedStyle(node).visibility === 'hidden',
          ),
        ),
    )
    .toBe(true);
  const image = await page.locator('.scene canvas').screenshot();
  const selectedMarkerPixels = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        ),
        surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = surface.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, surface.width, surface.height).data;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const values = [pixels[i], pixels[i + 1], pixels[i + 2]];
        if (Math.min(...values) > 210 && Math.max(...values) - Math.min(...values) < 5) white++;
      }
      return white;
    },
    [...image],
  );
  expect(
    selectedMarkerPixels,
    'Selected head/feet identity markers must not obscure the close follow view',
  ).toBe(0);
  await page.screenshot({ path: info.outputPath('original-third-person-follow.png') });
});
