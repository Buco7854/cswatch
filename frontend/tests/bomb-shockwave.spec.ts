import { chooseCameraControl } from './fixtures/viewer-transport';
import { nativeMap } from './fixtures/native-map';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { expect, test } from '@playwright/test';
import { indexBombShockwaves } from '../src/bomb-shockwave';
import { indexItems, type PresentItem } from '../src/item-state';
import { installDemoMapDescriptor } from './fixtures/map-assets';
import { originalMapReplay } from './fixtures/original-map';

const bomb: PresentItem = {
  id: 'item:8:4:80',
  tick: 80,
  present: true,
  equipment: 'plantedc4',
  kind: 'planted',
  x: 0,
  y: 0,
  z: 0,
};
const detonation = { type: 'bomb_exploded', tick: 128 };
const removed = { id: bomb.id, tick: 128, present: false as const };

test('C4 wave requires a detonation and recorded origin, including removal on the same tick', () => {
  const items = indexItems([bomb, removed]);
  const at = indexBombShockwaves([detonation, { type: 'bomb_defused', tick: 300 }], 64);
  expect(at(127.99, items)).toBeUndefined();
  const first = at(128, items)!;
  expect(first.position).toEqual([0, 0.12, -0]);
  const later = at(150, items)!;
  expect(later.radius).toBeGreaterThan(first.radius);
  expect(later.opacity).toBeLessThan(first.opacity);
  expect(at(183, items)).toBeUndefined();
  expect(at(300, items)).toBeUndefined();
  expect(at(128, items)).toEqual(first);
  expect(at(128, indexItems())).toBeUndefined();
  expect(at(128, indexItems([bomb, { ...bomb, id: 'item:9:4:80' }]))).toBeUndefined();
  const direct = indexBombShockwaves([{ ...detonation, x: 4, y: 10, z: 20 }], 64);
  expect(direct(128, indexItems())?.position).toEqual([0.1016, 0.628, -0.254]);
});

test('the normal WebGL viewer draws the C4 wave during the recorded window and respects reduced motion', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 960, height: 600 });
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings-v2',
      JSON.stringify({ quality: 'low', autoHideControls: false, utilities: true }),
    );
    const locations = new WeakSet<WebGLUniformLocation>();
    const probe = { draws: [] as number[] };
    Object.assign(window, { bombWaveProbe: probe });
    const proto = WebGL2RenderingContext.prototype;
    const getLocation = proto.getUniformLocation,
      uniform = proto.uniform1f;
    proto.getUniformLocation = function (program, name) {
      const location = getLocation.call(this, program, name);
      if (name === 'strength' && location) locations.add(location);
      return location;
    };
    proto.uniform1f = function (location, strength) {
      if (location && locations.has(location)) probe.draws.push(strength);
      return uniform.call(this, location, strength);
    };
  });
  const replay = originalMapReplay();
  replay.events = [detonation];
  replay.grenades = [];
  replay.itemState = {
    complete: false,
    coverage: { planted: true, dropped: false, projectile: false },
  };
  replay.itemSamples = [bomb, removed];
  const id = 'bomb-wave-qa',
    model = nativeMap(replay.map).model(id);
  await page.route(`**/api/demos/${id}`, (route) =>
    route.fulfill({
      json: { id, name: 'Original C4 effect QA', status: 'ready', public: true, map: replay.map },
    }),
  );
  await page.route(`**/api/demos/${id}/playback`, (route) => fulfillReplayFixture(route, replay));
  await installDemoMapDescriptor(page, id, { model, overview: null });
  await nativeMap(replay.map).route(page);
  await page.goto(`/watch/${id}`);
  const scene = page.locator('.scene'),
    slider = page.getByRole('slider', { name: 'Playback position' });
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  await chooseCameraControl(page, 'Overhead');
  const draws = () =>
    page.evaluate(
      () => (window as unknown as { bombWaveProbe: { draws: number[] } }).bombWaveProbe.draws,
    );
  await slider.fill('127');
  expect(await draws()).toEqual([]);
  await slider.fill('145');
  await expect.poll(draws).toEqual(expect.arrayContaining([expect.any(Number)]));
  const capture = () =>
    scene.locator('canvas').screenshot({
      style: 'body :not(canvas):not(:has(canvas)) { visibility: hidden !important; }',
    });
  const wave = await capture();
  await slider.fill('200');
  const expired = await capture();
  expect(wave.equals(expired)).toBe(false);
  await slider.fill('145');
  expect((await capture()).equals(wave)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await capture()).equals(wave)).toBe(false);
  await info.attach('recorded-c4-shockwave.png', { body: wave, contentType: 'image/png' });
});
