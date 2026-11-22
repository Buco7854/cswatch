import { chooseCameraControl } from './fixtures/viewer-transport';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { test, expect } from '@playwright/test';
import { originalAnimatedAgentGLB } from './fixtures/original-agent';
import {
  originalMapReplay,
  originalMapGLB,
  qaActor,
  qaMap,
  qaOverview,
  originalOverviewPNG,
} from './fixtures/original-map';
import { installDemoMapDescriptor } from './fixtures/map-assets';
import { originalEquipmentCatalog, originalEquipmentGLB } from './fixtures/original-equipment';
import { Matrix4, Vector3 } from '../node_modules/three/build/three.module.js';

test('directional clips deform skinned actors from recorded speed and duck on desktop and phone with deterministic seek recovery', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    for (const key of ['viewer-settings-v2', 'viewer-settings-v2-mobile'])
      localStorage.setItem(
        key,
        JSON.stringify({
          quality: innerWidth < 600 ? 'low' : 'high',
          autoHideControls: false,
          xray: false,
          matchScore: false,
          crosshair: false,
          killReplay: false,
          grenadeLanding: false,
        }),
      );
    const state = { ys: [] as number[] };
    (window as unknown as { qaNativeBones: typeof state }).qaNativeBones = state;
    const capture = (args: unknown[]) => {
      const data = args[8];
      if (args.length === 9 && data instanceof Float32Array && data.length >= 16) {
        state.ys.push(data[13]);
        if (state.ys.length > 256) state.ys.splice(0, state.ys.length - 256);
      }
    };
    const uniforms = new WeakMap<WebGLUniformLocation, string>(),
      programs = new WeakMap<WebGLProgram, { mv?: number[]; color?: number[] }>(),
      active = new WeakMap<WebGL2RenderingContext, WebGLProgram | null>();
    const matrices = { floor: null as number[] | null, held: null as number[] | null };
    (window as unknown as { qaHeldMatrices: typeof matrices }).qaHeldMatrices = matrices;
    const location = WebGL2RenderingContext.prototype.getUniformLocation,
      program = WebGL2RenderingContext.prototype.useProgram,
      matrix = WebGL2RenderingContext.prototype.uniformMatrix4fv,
      color = WebGL2RenderingContext.prototype.uniform3f,
      draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.getUniformLocation = function (p, name) {
      const value = location.call(this, p, name);
      if (value) uniforms.set(value, name);
      return value;
    };
    WebGL2RenderingContext.prototype.useProgram = function (p) {
      active.set(this, p);
      return program.call(this, p);
    };
    const data = (gl: WebGL2RenderingContext) => {
      const p = active.get(gl);
      if (!p) return;
      let value = programs.get(p);
      if (!value) {
        value = {};
        programs.set(p, value);
      }
      return value;
    };
    WebGL2RenderingContext.prototype.uniformMatrix4fv = function (location, transpose, values) {
      const value = data(this);
      if (value && location && uniforms.get(location) === 'modelViewMatrix')
        value.mv = Array.from(values);
      return matrix.call(this, location, transpose, values);
    };
    WebGL2RenderingContext.prototype.uniform3f = function (location, r, g, b) {
      const value = data(this);
      if (value && location && uniforms.get(location) === 'diffuse') value.color = [r, g, b];
      return color.call(this, location, r, g, b);
    };
    WebGL2RenderingContext.prototype.drawArrays = function (mode, first, count) {
      const value = data(this);
      if (value?.mv) {
        if (count === 18) matrices.floor = [...value.mv];
        if (count === 36 && value.color?.[0] === 1 && value.color[1] === 0 && value.color[2] === 1)
          matrices.held = [...value.mv];
      }
      return draw.call(this, mode, first, count);
    };
    const image = WebGL2RenderingContext.prototype.texImage2D,
      sub = WebGL2RenderingContext.prototype.texSubImage2D;
    WebGL2RenderingContext.prototype.texImage2D = function (...args) {
      capture(args);
      return image.apply(this, args as Parameters<typeof image>);
    } as typeof image;
    WebGL2RenderingContext.prototype.texSubImage2D = function (...args) {
      capture(args);
      return sub.apply(this, args as Parameters<typeof sub>);
    } as typeof sub;
  });
  const replay = originalMapReplay();
  replay.events = [];
  replay.grenades = [];
  const player = replay.frames[0].players.find((p) => p.id === qaActor)!;
  replay.frames = Array.from({ length: 41 }, (_, i) => {
    const tick = i * 8,
      x =
        tick <= 64
          ? tick
          : tick <= 128
            ? 64 + (tick - 64) * 4
            : tick <= 192
              ? 320
              : tick <= 256
                ? 320 + (tick - 192)
                : 384;
    return {
      tick,
      players: [
        {
          ...player,
          weapon: 'ak47',
          pitch: 0,
          x,
          y: 0,
          z: 0,
          yaw: 0,
          // Change stance after stopping to leave the previous run phase intact.
          duck: tick >= 136 && tick < 256 ? 1 : 0,
        },
      ],
    };
  });
  replay.worldBounds = { minX: -768, maxX: 768, minY: -512, maxY: 512, minZ: 0, maxZ: 128 };
  await page.route('**/api/demos/native-locomotion-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'native-locomotion-fixture',
        name: 'Original synthetic locomotion QA, not game clips',
        status: 'ready',
        public: true,
        owned: false,
        map: qaMap,
      },
    }),
  );
  await page.route('**/api/demos/native-locomotion-fixture/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await installDemoMapDescriptor(page, 'native-locomotion-fixture', {
    model: `/map-assets/${qaMap}/desktop/scene.glb`,
    mobile: null,
    overview: qaOverview,
  });
  await page.route(`**/map-assets/${qaMap}/desktop/scene.glb`, (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalMapGLB() }),
  );
  await page.route(`**/api/maps/${qaMap}/overview.png`, (route) =>
    route.fulfill({ contentType: 'image/png', body: originalOverviewPNG() }),
  );
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: '/map-assets/agents/ct.glb', t: null } }),
  );
  await page.route('**/map-assets/agents/ct.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalAnimatedAgentGLB('wpn') }),
  );
  await page.route('**/api/assets/equipment-models', (route) =>
    route.fulfill({ json: originalEquipmentCatalog(['ak47']) }),
  );
  await page.route('**/api/assets/equipment-models/ak47.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalEquipmentGLB() }),
  );
  for (const [width, height, theme] of [
    [1280, 800, 'dark'],
    [390, 844, 'light'],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
    await page.goto('/watch/native-locomotion-fixture');
    const scene = page.locator('.scene');
    await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
    // See the tracked actor from above before probing the bone and attachment.
    await chooseCameraControl(page, 'Overhead');
    await expect(scene).toHaveAttribute('data-agent-ready-count', '1');
    if (width < 600) {
      await expect(page.locator('.map-verification-short')).toHaveText('Unverified');
      expect(
        await page
          .locator('.viewer-context')
          .evaluate((element) =>
            [...element.children].every((child) => child.scrollWidth <= child.clientWidth),
          ),
      ).toBe(true);
    }
    const check = async (tick: number, expected: number) => {
      await page.evaluate(() => {
        (window as unknown as { qaNativeBones: { ys: number[] } }).qaNativeBones.ys = [];
      });
      await page.locator('.timeline-slider').fill(String(tick));
      await expect
        .poll(() =>
          page.evaluate(
            (target) =>
              (window as unknown as { qaNativeBones: { ys: number[] } }).qaNativeBones.ys.some(
                (y) => Math.abs(y - target) < 0.0001,
              ),
            expected,
          ),
        )
        .toBe(true);
      const world = await page.evaluate(
        () =>
          (
            window as unknown as {
              qaHeldMatrices: { floor: number[] | null; held: number[] | null };
            }
          ).qaHeldMatrices,
      );
      expect(world.floor).not.toBeNull();
      expect(world.held).not.toBeNull();
      const view = new Matrix4()
        .fromArray(world.floor!)
        .multiply(new Matrix4().makeRotationY(-Math.PI / 2));
      const actual = new Vector3().setFromMatrixPosition(
        view.invert().multiply(new Matrix4().fromArray(world.held!)),
      );
      const source = replay.frames.find((frame) => frame.tick === tick)!.players[0];
      expect(
        actual.distanceTo(new Vector3(source.x * 0.0254 + 0.4, 1.3 + expected, 0)),
      ).toBeLessThan(0.0001);
    };
    await check(16, 0.04);
    await check(80, 0.15);
    await check(144, -0.6);
    await check(208, -0.55);
    await check(272, 0);
    await check(16, 0.04);
    await page.screenshot({
      path: info.outputPath(`original-directional-agent-${theme}-${width}.png`),
    });
    await chooseCameraControl(page, '2D tactical · low power');
    await expect(page.locator('.tactical-plot')).toBeVisible();
    await chooseCameraControl(page, 'Free camera');
    await expect(scene).toHaveAttribute('data-agent-ready-count', '1');
    await check(208, -0.55);
  }
});
