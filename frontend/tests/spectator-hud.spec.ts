import { chooseCameraControl } from './fixtures/viewer-transport';
import { fulfillReplayFixture, replayFixture } from './fixtures/streamed-replay';
import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { installDemoMapDescriptor } from './fixtures/map-assets';
import { originalMapGLB, originalMapReplay, qaActor } from './fixtures/original-map';
import { selectOptionsCategory } from './fixtures/viewer-options';
import { originalAnimatedAgentGLB } from './fixtures/original-agent';

const opponent = '76561198000000002',
  teammate = '76561198000000003';
function mapWithWall() {
  const source = originalMapGLB();
  const jsonLength = source.readUInt32LE(12),
    offset = 20 + jsonLength;
  const document = JSON.parse(source.subarray(20, offset).toString());
  const sourceBin = source.subarray(offset + 8, offset + 8 + source.readUInt32LE(offset));
  const points = [-5, 0, 0, 5, 0, 0, 5, 4, 0, -5, 0, 0, 5, 4, 0, -5, 4, 0];
  const wall = Buffer.alloc(points.length * 4);
  points.forEach((part, index) => wall.writeFloatLE(part, index * 4));
  const bin = Buffer.concat([sourceBin, wall]);
  const view = document.bufferViews.length,
    accessor = document.accessors.length;
  document.bufferViews.push({
    buffer: 0,
    byteOffset: sourceBin.length,
    byteLength: wall.length,
    target: 34962,
  });
  document.accessors.push({
    bufferView: view,
    componentType: 5126,
    count: 6,
    type: 'VEC3',
    min: [-5, 0, 0],
    max: [5, 4, 0],
  });
  const material = document.materials.length;
  document.materials.push({
    pbrMetallicRoughness: {
      baseColorFactor: [0.2, 0.22, 0.24, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    doubleSided: true,
  });
  const mesh = document.meshes.length,
    node = document.nodes.length;
  document.meshes.push({ primitives: [{ attributes: { POSITION: accessor }, material }] });
  document.nodes.push({ name: 'Original QA occluding wall, not CS2 artwork', mesh });
  document.scenes[0].nodes.push(node);
  document.buffers[0].byteLength = bin.length;
  const raw = Buffer.from(JSON.stringify(document)),
    json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32);
  raw.copy(json);
  const output = Buffer.alloc(28 + json.length + bin.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  output.writeUInt32LE(bin.length, 20 + json.length);
  output.writeUInt32LE(0x004e4942, 24 + json.length);
  bin.copy(output, 28 + json.length);
  return output;
}
async function fixture(
  page: Page,
  id: string,
  options: { wall?: boolean; death?: boolean; native?: boolean | 'head'; flash?: boolean } = {},
) {
  const data = originalMapReplay();
  data.grenades = [];
  data.players.push({ id: teammate, name: 'Original QA teammate', team: 3 });
  data.frames = Array.from({ length: 21 }, (_, index) => ({
    tick: index * 32,
    players: [
      {
        ...data.frames[0].players[0],
        x: -200,
        y: 0,
        yaw: 0,
        health: options.death && index >= 2 ? 0 : 75,
        alive: !(options.death && index >= 2),
        flash: options.flash ? (index === 1 || index === 2 ? 1.03 : 0) : undefined,
      },
      {
        ...data.frames[0].players[1],
        x: 200,
        y: 0,
        health: 37,
        duck: options.native === 'head' && index >= 2 ? 1 : 0,
      },
      { ...data.frames[0].players[0], id: teammate, x: -200, y: 200, health: 64 },
    ],
  }));
  data.events = [
    {
      type: 'player_hurt',
      tick: 32,
      user_steamid: qaActor,
      attacker_steamid: opponent,
      dmg_health: 25,
    },
    ...(options.death
      ? [
          {
            type: 'player_death',
            tick: 64,
            user_steamid: qaActor,
            attacker_steamid: opponent,
            weapon: 'ak47',
          },
        ]
      : []),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    for (const key of ['viewer-settings-v2', 'viewer-settings-v2-mobile'])
      localStorage.setItem(
        key,
        JSON.stringify({
          quality: 'low',
          xray: true,
          playerLabels: true,
          economy: key === 'viewer-settings-v2',
          autoHideControls: false,
          killReplay: false,
          grenadeLanding: false,
          radar: false,
          killfeed: false,
        }),
      );
  });
  await page.route(`**/api/demos/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name: 'Original spectator QA positions',
        status: 'ready',
        public: true,
        owned: false,
        map: data.map,
      },
    }),
  );
  await page.route(`**/api/demos/${id}/playback`, (route) => fulfillReplayFixture(route, data));
  const model = `/map-assets/${data.map}/desktop/scene.glb`;
  await installDemoMapDescriptor(page, id, {
    model,
    mobile: null,
    overview: null,
    environment: null,
  });
  await page.route('**' + model, (route) =>
    route.fulfill({
      contentType: 'model/gltf-binary',
      body: options.wall ? mapWithWall() : originalMapGLB(),
    }),
  );
  if (options.native) {
    await page.route('**/api/assets/agents', (route) =>
      route.fulfill({ json: { ct: '/map-assets/agents/ct.glb', t: '/map-assets/agents/t.glb' } }),
    );
    await page.route('**/map-assets/agents/*.glb', (route) =>
      route.fulfill({
        contentType: 'model/gltf-binary',
        body: originalAnimatedAgentGLB(options.native === 'head' ? 'head_0' : undefined),
      }),
    );
  }
  return data;
}
async function camera(page: Page, name: string) {
  await chooseCameraControl(page, name);
}
async function option(
  page: Page,
  category: 'Visuals' | 'Playback',
  name: string,
  checked: boolean,
) {
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, category);
  await page.getByRole('switch', { name: new RegExp('^' + name) }).setChecked(checked);
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
}
test('player names and real health render through an actual wall, obey X-ray and remain clear in both themes on desktop and phone', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await fixture(page, 'spectator-labels', { wall: true });
  await page.goto('/watch/spectator-labels');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  const label = page.locator(`.actor-label[data-player="${opponent}"]`);
  await expect(label).toBeVisible();
  await expect(label).toHaveAccessibleName('Original QA opponent, 37 health');
  await expect(label.locator('.actor-label-track > span')).toHaveAttribute('style', 'width: 37%;');
  const throughWall = await page.locator('.scene canvas').screenshot();
  await option(page, 'Visuals', 'X-ray silhouettes', false);
  await expect(label).toBeHidden();
  const occluded = await page.locator('.scene canvas').screenshot();
  const proxyPixels = await page.evaluate(
    async ({ on, off }) => {
      const read = async (bytes: number[]) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return {
          width: canvas.width,
          height: canvas.height,
          pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };
      const first = await read(on),
        last = await read(off);
      let count = 0;
      for (
        let y = Math.round(first.height / 2) + 20;
        y < Math.min(first.height, first.height / 2 + 140);
        y++
      )
        for (let x = Math.round(first.width / 2) - 30; x < first.width / 2 + 30; x++) {
          const at = (y * first.width + x) * 4;
          if (
            first.pixels[at] > first.pixels[at + 2] * 1.1 &&
            Math.abs(first.pixels[at] - last.pixels[at]) > 10
          )
            count++;
        }
      return count;
    },
    { on: [...throughWall], off: [...occluded] },
  );
  expect(
    proxyPixels,
    'Occluded player proxy must draw real pixels behind the wall',
  ).toBeGreaterThan(20);
  await option(page, 'Visuals', 'X-ray silhouettes', true);
  await expect(label).toBeVisible();
  for (const theme of ['dark', 'light'])
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
        await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
        await page.getByRole('menuitem', { name: `Switch to ${theme} theme`, exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      }
      await expect(label).toBeVisible();
      expect((await label.boundingBox())!.width).toBeLessThanOrEqual(144);
      await page.screenshot({
        path: info.outputPath(`spectator-${theme}-${width}.png`),
        animations: 'disabled',
      });
    }
  await option(page, 'Visuals', 'Player names and health', false);
  await expect(page.locator('.actor-label')).toHaveCount(0);
});
test('native labels project the posed head and restore the same placement on backward seeks', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1100, height: 800 });
  await fixture(page, 'spectator-head-label', { wall: true, native: 'head' });
  await page.goto('/watch/spectator-head-label?tick=0');
  const scene = page.locator('.scene');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  const label = page.locator(`.actor-label[data-player="${opponent}"]`);
  const offset = async () => {
    const bounds = (await label.boundingBox())!;
    const canvas = (await scene.locator('canvas').boundingBox())!;
    return bounds.y + bounds.height / 2 - (canvas.y + canvas.height / 2);
  };
  // The fixture's posed head plus the label gap lies below the viewer's fixed eye height.
  // The generic standing-height label would be above it.
  // Convert the original pixel thresholds to the wider default projection.
  const projectionScale = Math.tan((48 * Math.PI) / 360) / Math.tan((73.74 * Math.PI) / 360);
  await expect.poll(offset).toBeGreaterThan(5 * projectionScale);
  const standing = await offset();
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await slider.fill('64');
  await expect.poll(offset).toBeGreaterThan(standing + 35 * projectionScale);
  await slider.fill('0');
  await expect.poll(async () => Math.abs((await offset()) - standing)).toBeLessThan(1);
});

test('first-person hurt feedback follows recorded ticks, remains optional and leaves no stale effect after seeking', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await fixture(page, 'spectator-damage');
  await page.goto('/watch/spectator-damage');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await slider.fill('32');
  await expect(page.locator('.spectator-damage')).toBeVisible();
  await page.screenshot({
    path: info.outputPath('spectator-recorded-hurt.png'),
    animations: 'disabled',
  });
  await slider.fill('0');
  await expect(page.locator('.spectator-damage')).toHaveCount(0);
  await slider.fill('48');
  await expect(page.locator('.spectator-damage')).toBeVisible();
  await option(page, 'Visuals', 'Damage feedback', false);
  await expect(page.locator('.spectator-damage')).toHaveCount(0);
});

test('first-person flash feedback follows recorded pawn state, presentation and reduced motion', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await fixture(page, 'spectator-flash', { flash: true });
  await page.goto('/watch/spectator-flash');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await slider.fill('32');
  const indicator = page.getByText('Flashed', { exact: true });
  const tint = page.locator('.spectator-flash-tint');
  await expect(indicator).toBeVisible();
  await expect(tint).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('combobox', { name: 'Flashbang feedback', exact: true }).click();
  await page.getByRole('option', { name: 'Strong tint', exact: true }).click();
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  await expect(tint).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(tint).toBeHidden();
  await expect(indicator).toBeVisible();
  await slider.fill('96');
  await expect(indicator).toHaveCount(0);
  await slider.fill('32');
  await expect(indicator).toBeVisible();
  await camera(page, 'Overhead');
  await expect(indicator).toHaveCount(0);
});

test('prepared actors draw their skinned silhouette behind real geometry and release it when X-ray is disabled', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1100, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixture(page, 'spectator-native-xray', { wall: true, native: true });
  await page.goto('/watch/spectator-native-xray');
  const scene = page.locator('.scene');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '2');
  await expect(scene).toHaveAttribute('data-agent-fallback-count', '0');
  const canvas = scene.locator('canvas');
  const on = await canvas.screenshot();
  await option(page, 'Visuals', 'X-ray silhouettes', false);
  const off = await canvas.screenshot();
  const changed = await page.evaluate(
    async ({ on, off }) => {
      const pixels = async (bytes: number[]) => {
        const image = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        );
        const surface = new OffscreenCanvas(image.width, image.height),
          context = surface.getContext('2d')!;
        context.drawImage(image, 0, 0);
        image.close();
        return {
          width: surface.width,
          height: surface.height,
          data: context.getImageData(0, 0, surface.width, surface.height).data,
        };
      };
      const a = await pixels(on),
        b = await pixels(off);
      let amber = 0;
      for (let y = Math.floor(a.height * 0.4); y < a.height * 0.75; y++)
        for (let x = Math.floor(a.width * 0.4); x < a.width * 0.6; x++) {
          const at = (y * a.width + x) * 4;
          if (a.data[at] > a.data[at + 2] * 1.1 && Math.abs(a.data[at] - b.data[at]) > 10) amber++;
        }
      return amber;
    },
    { on: [...on], off: [...off] },
  );
  expect(
    changed,
    'The prepared body must produce actual team-colored occluded pixels',
  ).toBeGreaterThan(20);
  await option(page, 'Visuals', 'X-ray silhouettes', true);
  await page.getByRole('slider', { name: 'Playback position' }).fill('96');
  await expect(scene).toHaveAttribute('data-agent-error-count', '0');
  await page.screenshot({ path: info.outputPath('native-body-xray.png') });
  expect(errors).toEqual([]);
});
test('French spectator controls fit the phone options panel and reduced motion does not animate the damage cue', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page, 'spectator-fr');
  await page.goto('/watch/spectator-fr');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  await page.getByRole('button', { name: 'Viewer menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Français', exact: true }).click();
  await expect(page.locator(`.actor-label[data-player="${opponent}"]`)).toHaveAccessibleName(
    'Original QA opponent, 37 points de vie',
  );
  await page.getByRole('slider', { name: 'Position de lecture' }).fill('32');
  await expect(page.locator('.spectator-damage')).toBeVisible();
  expect(
    await page
      .locator('.spectator-damage')
      .evaluate((element) => element.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('switch', { name: /^Noms et vie des joueurs/ })).toBeChecked();
  await expect(page.getByRole('switch', { name: /^Indicateur de dégâts/ })).toBeChecked();
  const dialog = page.locator('.viewer-options-dialog');
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await selectOptionsCategory(page, 'Playback');
  await expect(
    page.getByRole('switch', { name: /^Suivre un autre joueur après la mort/ }),
  ).toBeChecked();
  await page.screenshot({
    path: info.outputPath('spectator-french-phone-options.png'),
    animations: 'disabled',
  });
});

test('native X-ray does not tint a fully visible character with its own hidden surfaces', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const data = await fixture(page, 'spectator-native-visible', { wall: true, native: true });
  // Both actors stand before the actual wall. No part of the prepared body
  // should be painted as occluded merely because it has rear-facing surfaces.
  data.players = data.players.slice(0, 2);
  for (const frame of data.frames) {
    frame.players = frame.players.slice(0, 2);
    frame.players[1].x = -150;
  }
  await page.goto('/watch/spectator-native-visible');
  const scene = page.locator('.scene');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  await expect(scene).toHaveAttribute('data-agent-ready-count', '1');
  // A locator screenshot also includes DOM drawn above the canvas. Isolate
  // actual rendered pixels so focus restoration/roster transitions cannot
  // masquerade as a change to the native artwork.
  const capture = () =>
    scene.locator('canvas').screenshot({
      style: 'body :not(canvas):not(:has(canvas)) { visibility: hidden !important; }',
    });
  const on = await capture();
  await option(page, 'Visuals', 'X-ray silhouettes', false);
  const off = await capture();
  await info.attach('visible-native-xray-on', { body: on, contentType: 'image/png' });
  await info.attach('visible-native-xray-off', { body: off, contentType: 'image/png' });
  await writeFile(info.outputPath('visible-native-xray-on.png'), on);
  await writeFile(info.outputPath('visible-native-xray-off.png'), off);
  expect(
    on.equals(off),
    'Visible native geometry must retain its actual artwork with X-ray enabled',
  ).toBe(true);
});
test('three seconds after a watched death POV follows a living teammate and a later explicit seek does not trigger another switch', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await fixture(page, 'spectator-follow', { death: true });
  await page.goto('/watch/spectator-follow?tick=0');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Player perspective');
  const selected = page.getByRole('button', {
    name: 'Select player Original QA reviewer',
    exact: true,
  });
  await selected.click();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 100));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.clock.runFor(3500);
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(700);
  await expect(
    page.getByRole('button', { name: 'Select player Original QA teammate', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await selected.click();
  await page.getByRole('slider', { name: 'Playback position' }).fill('400');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.clock.runFor(1000);
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
});

test('a chunk stall after the watched death freezes its camera delay and resumes the same pending follow', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const data = await fixture(page, 'spectator-buffer', { death: true });
  const { frames } = data;
  const { manifest } = await replayFixture(data);
  const chunks = [
    {
      version: 3 as const,
      index: 0,
      frames: frames.filter((frame) => frame.tick <= 128),
      grenades: [],
      voice: [],
      sounds: [],
      itemSamples: [],
    },
    {
      version: 3 as const,
      index: 1,
      frames: frames.filter((frame) => frame.tick >= 128),
      grenades: [],
      voice: [],
      sounds: [],
      itemSamples: [],
    },
  ];
  await page.route('**/api/demos/spectator-buffer/playback', (route) =>
    route.fulfill({
      json: {
        ...manifest,
        firstTick: 0,
        lastTick: 640,
        chunks: chunks.map((chunk, index) => ({
          index,
          startTick: index === 0 ? 0 : 128,
          firstFrameTick: chunk.frames[0].tick,
          endTick: chunk.frames.at(-1)!.tick,
          frames: chunk.frames.length,
          bytes: Buffer.byteLength(JSON.stringify(chunk)),
        })),
      },
    }),
  );
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/demos/spectator-buffer/playback/chunks/*', async (route) => {
    const index = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    if (index === 1) await held;
    await route.fulfill({ json: chunks[index] }).catch(() => {});
  });
  try {
    await page.goto('/watch/spectator-buffer?tick=0');
    await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
    await camera(page, 'Player perspective');
    const selected = page.getByRole('button', {
      name: 'Select player Original QA reviewer',
      exact: true,
    });
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 100));
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.runFor(5000);
    await expect(page.locator('.replay-buffer')).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('128');
    release();
    await expect
      .poll(async () => {
        await page.clock.runFor(25);
        return page.locator('.replay-buffer').count();
      })
      .toBe(0);
    await page.clock.runFor(1000);
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await page.clock.runFor(1500);
    await expect(
      page.getByRole('button', { name: 'Select player Original QA teammate', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  } finally {
    release();
  }
});

test('recorded-map free camera turns in place, moves with ZQSD, preserves its view and ignores gestures while Options is open', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.addInitScript(() => {
    const locations = new WeakMap<WebGLUniformLocation, string>();
    const programs = new WeakMap<WebGL2RenderingContext, WebGLProgram | null>();
    const matrices = new WeakMap<WebGLProgram, number[]>();
    const capture = { position: [] as number[], matrix: [] as number[] };
    (window as unknown as { qaFreeView: typeof capture }).qaFreeView = capture;
    const location = WebGL2RenderingContext.prototype.getUniformLocation;
    const matrix = WebGL2RenderingContext.prototype.uniformMatrix4fv;
    const use = WebGL2RenderingContext.prototype.useProgram;
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
      const value = location.call(this, program, name);
      if (value) locations.set(value, name);
      return value;
    };
    WebGL2RenderingContext.prototype.useProgram = function (program) {
      programs.set(this, program);
      return use.call(this, program);
    };
    WebGL2RenderingContext.prototype.uniformMatrix4fv = function (at, transpose, values) {
      const program = programs.get(this);
      if (program && at && locations.get(at) === 'modelViewMatrix')
        matrices.set(program, Array.from(values));
      return matrix.call(this, at, transpose, values);
    };
    WebGL2RenderingContext.prototype.drawArrays = function (mode, first, count) {
      const program = programs.get(this),
        m = program && matrices.get(program);
      if (count === 18 && m) {
        // The original floor is the only18-vertex non-indexed draw. Invert its
        // actual orthonormal model-view transform, then apply S2V's +90Y base.
        const x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
          y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
          z = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
        capture.position = [z, y, -x];
        capture.matrix = [...m];
      }
      return draw.call(this, mode, first, count);
    };
  });
  await fixture(page, 'spectator-free');
  await page.goto('/watch/spectator-free?tick=0');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await camera(page, 'Free camera');
  const view = () =>
    page.evaluate(
      () =>
        (window as unknown as { qaFreeView: { position: number[]; matrix: number[] } }).qaFreeView,
    );
  await expect.poll(async () => (await view()).position[1]).toBeCloseTo(1.65, 3);
  const before = await view(),
    canvas = page.locator('.scene canvas'),
    bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width * 0.45,
    y = bounds.y + bounds.height * 0.6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 25, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => JSON.stringify((await view()).matrix))
    .not.toBe(JSON.stringify(before.matrix));
  const turned = await view();
  for (let axis = 0; axis < 3; axis++)
    expect(turned.position[axis]).toBeCloseTo(before.position[axis], 4);
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
  await page.keyboard.down('z');
  try {
    await expect
      .poll(async () => JSON.stringify((await view()).position))
      .not.toBe(JSON.stringify(turned.position));
  } finally {
    await page.keyboard.up('z');
  }
  const moved = await view();
  await page.mouse.wheel(0, 80);
  await expect
    .poll(async () => JSON.stringify((await view()).position))
    .not.toBe(JSON.stringify(moved.position));
  const saved = await view();
  await camera(page, 'Player perspective');
  await expect.poll(async () => (await view()).position[0]).toBeCloseTo(-5.08, 3);
  await camera(page, 'Free camera');
  await expect
    .poll(async () =>
      (await view()).position.every(
        (part, index) => Math.abs(part - saved.position[index]) < 0.0001,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  const frozen = await view();
  await canvas.dispatchEvent('pointerdown', {
    pointerId: 71,
    pointerType: 'mouse',
    button: 0,
    clientX: x,
    clientY: y,
    bubbles: true,
  });
  await canvas.dispatchEvent('pointermove', {
    pointerId: 71,
    pointerType: 'mouse',
    buttons: 1,
    clientX: x + 300,
    clientY: y + 100,
    bubbles: true,
  });
  await canvas.dispatchEvent('pointerup', {
    pointerId: 71,
    pointerType: 'mouse',
    button: 0,
    clientX: x + 300,
    clientY: y + 100,
    bubbles: true,
  });
  expect((await view()).position).toEqual(frozen.position);
  expect((await view()).matrix).toEqual(frozen.matrix);
  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window),
      cancel = window.cancelAnimationFrame.bind(window);
    const callbacks = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    window.requestAnimationFrame = (callback) => {
      const id = --sequence;
      callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!callbacks.delete(id)) cancel(id);
    };
    (window as unknown as { releaseFreeFocusFrame: () => Promise<number> }).releaseFreeFocusFrame =
      () => {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
        const pending = [...callbacks.values()];
        callbacks.clear();
        return new Promise((resolve) =>
          request((time) => {
            for (const callback of pending) callback(time);
            request(() => resolve(pending.length));
          }),
        );
      };
  });
  await page.getByRole('button', { name: 'Close viewer options', exact: true }).click();
  const orientation = (await view()).matrix.filter((_, index) =>
    [0, 1, 2, 4, 5, 6, 8, 9, 10].includes(index),
  );
  await canvas.dispatchEvent('pointerdown', {
    pointerId: 101,
    pointerType: 'touch',
    button: 0,
    clientX: x,
    clientY: y,
    bubbles: true,
  });
  // Release the old dialog's deferred focus while the first camera finger is
  // already held. It must yield to that newer visible focus destination.
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { releaseFreeFocusFrame: () => Promise<number> }
      ).releaseFreeFocusFrame(),
    ),
  ).toBeGreaterThan(0);
  await expect(page.locator('.viewer-stage')).toBeFocused();
  await canvas.dispatchEvent('pointerdown', {
    pointerId: 102,
    pointerType: 'touch',
    button: 0,
    clientX: x + 100,
    clientY: y,
    bubbles: true,
  });
  await canvas.dispatchEvent('pointermove', {
    pointerId: 101,
    pointerType: 'touch',
    buttons: 1,
    clientX: x - 20,
    clientY: y + 20,
    bubbles: true,
  });
  await canvas.dispatchEvent('pointermove', {
    pointerId: 102,
    pointerType: 'touch',
    buttons: 1,
    clientX: x + 140,
    clientY: y + 20,
    bubbles: true,
  });
  await canvas.dispatchEvent('pointerup', {
    pointerId: 101,
    pointerType: 'touch',
    button: 0,
    clientX: x - 20,
    clientY: y + 20,
    bubbles: true,
  });
  await canvas.dispatchEvent('pointerup', {
    pointerId: 102,
    pointerType: 'touch',
    button: 0,
    clientX: x + 140,
    clientY: y + 20,
    bubbles: true,
  });
  await expect
    .poll(async () => JSON.stringify((await view()).position))
    .not.toBe(JSON.stringify(frozen.position));
  expect(
    (await view()).matrix.filter((_, index) => [0, 1, 2, 4, 5, 6, 8, 9, 10].includes(index)),
  ).toEqual(orientation);
  await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'true');
});
