import { installOriginalCameraProbe } from './fixtures/original-camera';
import { chooseCameraControl, choosePlaybackSpeed } from './fixtures/viewer-transport';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { test, expect, type Page } from '@playwright/test';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { createHash } from 'node:crypto';
import { povFar, povNear, povOffset, povProjection, staticPovAttachment } from '../src/pov-camera';
import { originalMapReplay, qaActor } from './fixtures/original-map';
import { installMapFixture } from './fixtures/map-assets';
import { originalEquipmentCatalog, originalEquipmentGLB } from './fixtures/original-equipment';

type PoseCapture = {
  view: number[] | null;
  equipment: { modelView: number[]; projection: number[] }[];
};

async function fixture(page: Page, id: string, gpu = false, quality: 'low' | 'auto' = 'low') {
  const data = originalMapReplay('de_pacing_qa');
  data.events = [];
  data.grenades = [];
  data.rounds = [];
  data.frames = [0, 4, 8, 1280].map((tick, index) => ({
    tick,
    players: data.frames[0].players.map((p, i) => ({
      ...p,
      x: i ? 128 : index * 8,
      y: i ? 0 : index * 4,
      z: index * 2,
      yaw: index ? 1 : 359,
      pitch: index ? 10 : 350,
      duck: index ? 1 : 0,
      weapon: 'ak47',
    })),
  }));
  if (gpu) data.frames[2].players = data.frames[2].players.filter((p) => p.id !== qaActor);
  await page.addInitScript((quality) => {
    localStorage.setItem('cswatch.language', 'en');
    for (const key of ['viewer-settings-v2', 'viewer-settings-v2-mobile'])
      localStorage.setItem(
        key,
        JSON.stringify({
          quality,
          autoHideControls: false,
          autoSkipFreeze: false,
          autoSkipTimeouts: false,
          matchScore: false,
          economy: false,
          xray: false,
          crosshair: false,
          killReplay: false,
          grenadeLanding: false,
        }),
      );
  }, quality);
  await page.route(`**/api/demos/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name: 'Original pacing QA positions, not a CS2 recording',
        status: 'ready',
        owned: false,
        public: true,
        map: data.map,
      },
    }),
  );
  await page.route(`**/api/demos/${id}/playback`, (route) => fulfillReplayFixture(route, data));
  await installMapFixture(page, data.map, id);
  await page.route('**/api/assets/agents', (route) =>
    route.fulfill({ json: { ct: null, t: null } }),
  );
  await page.route('**/api/assets/equipment-models', (route) =>
    route.fulfill({ json: originalEquipmentCatalog(['ak47']) }),
  );
  await page.route('**/api/assets/equipment-models/ak47.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalEquipmentGLB() }),
  );
  return data;
}
test('Auto reduces the actual 3D drawing buffer in response to slow continuous playback', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 800, height: 600 });
  await fixture(page, 'adaptive-quality', false, 'auto');
  await page.goto('/watch/adaptive-quality');
  const scene = page.locator('.scene');
  const canvas = scene.locator('canvas');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  const before = await canvas.evaluate((element) => element.width);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  for (let frame = 0; frame < 65; frame++) await page.clock.fastForward(50);
  await expect.poll(() => canvas.evaluate((element) => element.width)).toBeLessThan(before);
  // Each level is held for eight seconds before the next resize.
  for (let frame = 0; frame < 70; frame++) await page.clock.fastForward(200);
  await expect(scene).toHaveAttribute('data-render-resolution', '50');
  const floor = await canvas.evaluate((element) => element.width);
  expect(floor).toBeLessThan(before);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await scene.getAttribute('data-render-resolution');
  await page.clock.fastForward(5000);
  await expect(scene).toHaveAttribute('data-render-resolution', paused!);
});

test('visible playback follows elapsed time after a long animation frame, rebases seeks and honors speed', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await fixture(page, 'clock-pacing');
  await page.goto('/watch/clock-pacing');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await chooseCameraControl(page, '2D tactical · low power');
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await slider.fill('0');
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.clock.fastForward(1000);
  expect(Number(await slider.inputValue())).toBeCloseTo(64, 0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await slider.fill('400');
  await choosePlaybackSpeed(page, '2×');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.clock.fastForward(500);
  expect(Number(await slider.inputValue())).toBeCloseTo(464, 0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.clock.fastForward(5000);
  expect(Number(await slider.inputValue())).toBeCloseTo(464, 0);
});

test('POV camera and equipment share interpolated recorded angles, eye height and identity at sub-sample seeks', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  // Compare the common camera/attachment transform with the optional stride disabled.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const names = new WeakMap<WebGLUniformLocation, string>(),
      get = WebGL2RenderingContext.prototype.getUniformLocation,
      mat = WebGL2RenderingContext.prototype.uniformMatrix4fv,
      vec = WebGL2RenderingContext.prototype.uniform3f,
      use = WebGL2RenderingContext.prototype.useProgram,
      draw = WebGL2RenderingContext.prototype.drawArrays,
      drawIndexed = WebGL2RenderingContext.prototype.drawElements,
      clear = WebGL2RenderingContext.prototype.clear,
      colors = new WeakMap<WebGLProgram, boolean>(),
      modelViews = new WeakMap<WebGLProgram, number[]>(),
      projections = new WeakMap<WebGLProgram, number[]>();
    let program: WebGLProgram | null = null;
    const state: PoseCapture = { view: null, equipment: [] };
    (window as unknown as { qaPoseGPU: typeof state }).qaPoseGPU = state;
    // The native world program's view replaces the old floor-derived camera.
    Object.defineProperty(state, 'view', {
      get: () =>
        (window as unknown as { qaOriginalCamera?: { view: number[] } }).qaOriginalCamera?.view
          ?.length
          ? (window as unknown as { qaOriginalCamera: { view: number[] } }).qaOriginalCamera.view
          : null,
      set: () => {},
    });
    WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
      const location = get.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    WebGL2RenderingContext.prototype.useProgram = function (value) {
      program = value;
      return use.call(this, value);
    };
    WebGL2RenderingContext.prototype.clear = function (mask) {
      if (mask & this.COLOR_BUFFER_BIT) state.equipment = [];
      return clear.call(this, mask);
    };
    WebGL2RenderingContext.prototype.uniform3f = function (location, x, y, z) {
      if (location && program && names.get(location) === 'diffuse')
        colors.set(program, x === 1 && y === 0 && z === 1);
      return vec.call(this, location, x, y, z);
    };
    WebGL2RenderingContext.prototype.uniformMatrix4fv = function (
      location,
      transpose,
      value,
      ...rest
    ) {
      const name = location && names.get(location);
      if (name === 'viewMatrix') state.view = Array.from(value);
      if (name === 'modelViewMatrix' && program) modelViews.set(program, Array.from(value));
      if (name === 'projectionMatrix' && program) projections.set(program, Array.from(value));
      return mat.call(this, location, transpose, value, ...rest);
    };
    const capture = (count: number) => {
      const currentModelView = program ? modelViews.get(program) : undefined;
      // The original three-room floor is 18 non-indexed vertices beneath the documented
      // +90Y S2V root. Its GPU model-view provides the real camera even when viewMatrix
      // is optimized out of this standard-material shader.
      if (count === 18 && currentModelView) {
        const m = currentModelView;
        state.view = [
          m[8],
          m[9],
          m[10],
          m[11],
          m[4],
          m[5],
          m[6],
          m[7],
          -m[0],
          -m[1],
          -m[2],
          -m[3],
          m[12],
          m[13],
          m[14],
          m[15],
        ];
      }
      const projection = program && projections.get(program);
      if (program && colors.get(program) && currentModelView && projection)
        state.equipment.push({ modelView: currentModelView, projection });
    };
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      capture(args[2]);
      return draw.apply(this, args);
    };
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      capture(args[1]);
      return drawIndexed.apply(this, args);
    };
  });
  await installOriginalCameraProbe(page);
  await fixture(page, 'pose-pacing', true);
  await page.goto('/watch/pose-pacing');
  const scene = page.locator('.scene'),
    slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  await chooseCameraControl(page, 'Player perspective');
  await slider.fill('2');
  await expect(scene).toHaveAttribute(
    'data-equipment-ready-instances',
    new RegExp('pov:' + qaActor + ':ak47'),
  );
  const pose = () =>
    page.evaluate(() => (window as unknown as { qaPoseGPU: PoseCapture }).qaPoseGPU);
  const expectedEye = new Vector3(0.1016, 1.3254, -0.0508);
  await expect
    .poll(async () => {
      const p = await pose();
      if (!p.view) return Infinity;
      const camera = new Matrix4().fromArray(p.view).invert(),
        v = new Vector3().setFromMatrixPosition(camera);
      return v.distanceTo(expectedEye);
    })
    .toBeLessThan(1e-5);
  const matrices = await pose(),
    camera = new Matrix4().fromArray(matrices.view!).invert();
  const direction = new Vector3(0, 0, -1).transformDirection(camera);
  expect(direction.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-5);
  const [forward, up, right] = staticPovAttachment(
    originalEquipmentCatalog(['ak47']).items.ak47.bounds,
  ).position;
  // At recorded yaw/pitch zero the player faces world +X, with +Z to their right.
  const expectedProp = expectedEye
    .clone()
    .add(new Vector3(forward + povOffset.forward, up + povOffset.up, right + povOffset.right));
  const { aspect, fov } = povProjection(1440 / 900);
  const projection = new PerspectiveCamera(fov, aspect, povNear, povFar).projectionMatrix.elements;
  await expect
    .poll(async () => {
      const p = await pose();
      if (!p.equipment.length || !p.view) return Infinity;
      const viewInverse = new Matrix4().fromArray(p.view).invert();
      return Math.min(
        ...p.equipment
          .filter((draw) =>
            draw.projection.every((value, index) => Math.abs(value - projection[index]) < 1e-5),
          )
          .map(({ modelView }) =>
            new Vector3()
              .setFromMatrixPosition(
                viewInverse.clone().multiply(new Matrix4().fromArray(modelView)),
              )
              .distanceTo(expectedProp),
          ),
      );
    })
    .toBeLessThan(1e-5);
  await slider.fill('8');
  await expect(scene).toHaveAttribute('data-equipment-ready-instances', /^(?!.*pov:)/);
  const held = await pose();
  expect(new Matrix4().fromArray(held.view!).invert().elements).toEqual(camera.elements);
  await slider.fill('2');
  await expect(scene).toHaveAttribute(
    'data-equipment-ready-instances',
    new RegExp('pov:' + qaActor + ':ak47'),
  );
});

test('retiring a model during bounded embedded-image parsing finishes without false texture errors, disposes late bitmaps and reloads safely', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window),
      decode = window.createImageBitmap.bind(window),
      close = ImageBitmap.prototype.close;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve)),
      bitmaps: ImageBitmap[] = [];
    const state = {
      started: 0,
      closed: 0,
      decoded: 0,
      hold: true,
      release: () => {
        state.hold = false;
        release();
      },
    };
    (window as unknown as { qaLocalParse: typeof state }).qaLocalParse = state;
    window.fetch = async (input, options) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url.startsWith('blob:') && state.hold) {
        state.started++;
        await gate;
      }
      return fetchOriginal(input, options);
    };
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = await decode(...args);
      state.decoded++;
      bitmaps.push(bitmap);
      return bitmap;
    }) as typeof createImageBitmap;
    ImageBitmap.prototype.close = function () {
      if (bitmaps.includes(this)) state.closed++;
      return close.call(this);
    };
  });
  await fixture(page, 'local-parse');
  const source = originalEquipmentGLB(),
    jsonSize = source.readUInt32LE(12),
    json = JSON.parse(source.subarray(20, 20 + jsonSize).toString()),
    bin = source.subarray(28 + jsonSize),
    webp = Buffer.from(
      'UklGRioAAABXRUJQVlA4TB0AAAAvD8ADAA9wkaR3KR8mc/5jCWLBZP7S3RlE9D90AQA=',
      'base64',
    );
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: webp.length });
  json.images = [{ bufferView: json.bufferViews.length - 1, mimeType: 'image/webp' }];
  json.textures = [{ extensions: { EXT_texture_webp: { source: 0 } } }];
  json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  json.extensionsUsed.push('EXT_texture_webp');
  json.extensionsRequired = ['EXT_texture_webp'];
  const binary = Buffer.concat([bin, webp, Buffer.alloc((4 - (webp.length % 4)) % 4)]);
  json.buffers[0].byteLength = binary.length;
  const serialized = Buffer.from(JSON.stringify(json)),
    padded = Buffer.concat([serialized, Buffer.alloc((4 - (serialized.length % 4)) % 4, 32)]),
    header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(binary.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const textured = Buffer.concat([header, padded, binHeader, binary]),
    catalog = originalEquipmentCatalog(['ak47']);
  catalog.items.ak47 = {
    ...catalog.items.ak47,
    sha256: createHash('sha256').update(textured).digest('hex'),
    bytes: textured.length,
    decodedTextureBytes: 1024,
  };
  await page.route('**/api/assets/equipment-models', (route) => route.fulfill({ json: catalog }));
  await page.route('**/api/assets/equipment-models/ak47.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: textured }),
  );
  // The synthetic equipment bundle has no separately authored POV rig.
  await page.route('**/api/assets/viewmodels/**', (route) => route.fulfill({ status: 204 }));
  await page.goto('/watch/local-parse');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { qaLocalParse: { started: number } }).qaLocalParse.started,
      ),
    )
    .toBe(1);
  await chooseCameraControl(page, '2D tactical · low power');
  await expect(page.locator('.scene canvas')).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { qaLocalParse: { release: () => void } }).qaLocalParse.release(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { qaLocalParse: { closed: number } }).qaLocalParse.closed,
      ),
    )
    .toBe(1);
  expect(errors).toEqual([]);
  await chooseCameraControl(page, 'Free camera');
  await expect(page.locator('.scene')).toHaveAttribute('data-equipment-ready-count', '2');
  const state = await page.evaluate(() => {
    const { decoded, closed } = (
      window as unknown as { qaLocalParse: { decoded: number; closed: number } }
    ).qaLocalParse;
    return { decoded, closed };
  });
  expect(state).toEqual({ decoded: 2, closed: 1 });
  expect(errors).toEqual([]);
});
