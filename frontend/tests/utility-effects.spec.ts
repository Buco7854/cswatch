import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { nativeMap } from './fixtures/native-map';
import { expect, test } from '@playwright/test';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { indexFireEffects, maxFireSprites } from '../src/utility-effects';
import { burstKind, maxBursts, maxImpactSprites, sampleGrenadeBursts } from '../src/grenade-burst';
import { impactSurfaces } from '../src/impact-surfaces';
import { buildUtilityZoneIndex } from '../src/utility-state';
import type { InfernoBank } from '../../shared/inferno-state.mjs';

import { installDemoMapDescriptor } from './fixtures/map-assets';
import { originalMapReplay } from './fixtures/original-map';

const events = [
  { type: 'inferno_startburn', tick: 101, entityid: 10, x: 96, y: -32, z: 12 },
  { type: 'inferno_expire', tick: 244, entityid: 10, x: 96, y: -32, z: 12 },
];
const bank: InfernoBank = {
  version: 1,
  tracks: [
    {
      entity: 10,
      serial: 1,
      end: 300,
      updates: [
        [101, [[0, 96 * 32, -32 * 32, 12 * 32]]],
        [130, [[1, 128 * 32, 64 * 32, 80 * 32]]],
        [244, [[0], [1]]],
      ],
    },
  ],
};

test('recorded fire follows individual world points and samples identically after forward and backward seeks', () => {
  const at = indexFireEffects(bank, events, 64);
  expect(at(100.9, false)).toEqual([]);
  expect(at(120, false)).toHaveLength(1);
  const peak = at(160.5, false);
  expect(peak.map((point) => point.position)).toEqual([
    [128 * 0.0254, 80 * 0.0254, -64 * 0.0254],
    [96 * 0.0254, 12 * 0.0254, 32 * 0.0254],
  ]);
  expect(peak.every((point) => point.variant === 0 && point.strength === 1)).toBe(true);
  expect(at(251, false)[0].strength).toBeLessThan(1);
  const scorched = at(268, false);
  expect(scorched).toHaveLength(2);
  expect(scorched.every(({ strength, secondary }) => strength === 0 && secondary > 0)).toBe(true);
  expect(at(350, false)).toEqual([]);
  expect(at(160.5, false)).toEqual(peak);
  expect(at(160.5, true).every(({ age, strength }) => age === 0 && strength < 1)).toBe(true);
});

test('event-only soft patch stops at recorded expiry and is capped with concurrent effects', () => {
  const at = indexFireEffects(undefined, events, 64);
  expect(at(161, false)).toHaveLength(7);
  expect(at(161, false).every((point) => point.variant === 1)).toBe(true);
  const cooling = at(270, false);
  expect(cooling).toHaveLength(7);
  expect(cooling.every((point) => point.strength === 0)).toBe(true);
  expect(at(350, false)).toEqual([]);
  const crowded = indexFireEffects(
    undefined,
    Array.from({ length: 100 }, () => events[0]),
    64,
  );
  expect(crowded(160, false)).toHaveLength(maxFireSprites);
});

test('HE has an early lit core, a cooling fireball and a longer rising dust tail', () => {
  const event = { ...events[0], type: 'hegrenade_detonate' };
  const zonesAt = buildUtilityZoneIndex([event], 64, true);
  const eventOnlyAt = buildUtilityZoneIndex([event], 64);
  const at = (age: number, reduced = false) => {
    const tick = event.tick + age * 64;
    return sampleGrenadeBursts(zonesAt(tick), tick, 64, reduced);
  };
  const kinds = (age: number) => new Set(at(age)[0].sprites.map(({ variant }) => variant));
  expect(at(-0.01)).toEqual([]);
  const early = at(0.03);
  expect(early[0].origin).toEqual([96 * 0.0254, 12 * 0.0254, 32 * 0.0254]);
  expect(early[0].light).toBeGreaterThan(80);
  expect(kinds(0.03)).toEqual(new Set([0, 1, 2, 3, 4]));
  expect(kinds(0.12)).toEqual(new Set([0, 1, 2]));
  expect(kinds(0.8)).toEqual(new Set([burstKind.dust]));
  expect(at(1.4)[0].sprites[0].strength).toBeLessThan(at(0.8)[0].sprites[0].strength);
  expect(at(1.56)).toEqual([]);
  expect(eventOnlyAt(event.tick + 0.8 * 64)).toEqual([]);
  expect(at(0.03)).toEqual(early);
  expect(at(0.12, true)[0]).toMatchObject({ light: 0 });
  expect(new Set(at(0.12, true)[0].sprites.map((s) => s.variant))).toEqual(
    new Set([burstKind.dust]),
  );

  const dense = buildUtilityZoneIndex(
    Array.from({ length: 35 }, () => event),
    64,
    true,
  );
  const overlapping = sampleGrenadeBursts(dense(103), 103, 64, false);
  expect(overlapping).toHaveLength(maxBursts);
  expect(overlapping.flatMap((b) => b.sprites).length).toBeLessThanOrEqual(maxImpactSprites);
});

test('flash leaves a short cool wisp and reduced motion omits its pop', () => {
  const zoneAt = buildUtilityZoneIndex([{ ...events[0], type: 'flashbang_detonate' }], 64, true);
  const at = (age: number, reduced = false) => {
    const tick = 101 + age * 64;
    return sampleGrenadeBursts(zoneAt(tick), tick, 64, reduced);
  };
  expect(at(0.03)[0].light).toBeGreaterThan(75);
  expect(at(0.03)[0].sprites.map((s) => s.variant)).toContain(burstKind.flash);
  expect(new Set(at(0.2)[0].sprites.map((s) => s.variant))).toEqual(new Set([burstKind.wisp]));
  expect(at(0.03, true)[0].light).toBe(0);
  expect(at(0.53)).toEqual([]);
});

test('impact contact planes face the playable side of a corner', () => {
  const root = new Group(),
    material = new MeshBasicMaterial();
  for (const [x, y, z, w, h, d] of [
    [0, -1, 0, 10, 2, 10],
    [-1.2, 1, 0, 1, 4, 10],
    [0, 1, -1.2, 10, 4, 1],
  ]) {
    const mesh = new Mesh(new BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  const { planes, vertices } = impactSurfaces(root, [0, 0.01, 0]);
  expect(vertices.length).toBeGreaterThan(0);
  expect(vertices.length % 9).toBe(0);
  expect(planes.map((v) => [v.x, v.y, v.z].map((axis) => Math.round(axis) + 0))).toEqual([
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ]);
  root.children.forEach((mesh) => (mesh as Mesh).geometry.dispose());
  material.dispose();
});

test('the production WebGL viewer submits only active, depth-tested utility sprites', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 960, height: 600 });
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings-v2',
      JSON.stringify({
        quality: 'high',
        autoHideControls: false,
        utilities: true,
        shotEffects: false,
        shotTracers: false,
      }),
    );
    const programs = new WeakSet<WebGLProgram>();
    const contactLocations = new WeakSet<WebGLUniformLocation>();
    const probe = {
      spriteDraws: [] as { depthTest: boolean; depthWrite: boolean }[],
      frames: 0,
      contactDepthUploads: 0,
      compiles: 0,
      links: 0,
      burstCompiles: 0,
    };
    Object.assign(window, { utilityDraws: probe });
    const proto = WebGL2RenderingContext.prototype;
    const attrib = proto.getAttribLocation;
    const draw = proto.drawElementsInstanced;
    const clear = proto.clear;
    const uniformLocation = proto.getUniformLocation;
    const uniformInt = proto.uniform1i;
    const compile = proto.compileShader;
    const link = proto.linkProgram;
    proto.compileShader = function (shader) {
      probe.compiles++;
      if (this.getShaderSource(shader)?.includes('contactDepthReady')) probe.burstCompiles++;
      return compile.call(this, shader);
    };
    proto.linkProgram = function (program) {
      probe.links++;
      return link.call(this, program);
    };
    proto.getUniformLocation = function (program, name) {
      const location = uniformLocation.call(this, program, name);
      if (name === 'contactDepthReady' && location) contactLocations.add(location);
      return location;
    };
    proto.uniform1i = function (location, value) {
      if (value && location && contactLocations.has(location)) probe.contactDepthUploads++;
      return uniformInt.call(this, location, value);
    };
    proto.getAttribLocation = function (program, name) {
      const location = attrib.call(this, program, name);
      if (name === 'aEffect' && location >= 0) programs.add(program);
      return location;
    };
    proto.drawElementsInstanced = function (...args) {
      const program = this.getParameter(this.CURRENT_PROGRAM);
      if (programs.has(program))
        probe.spriteDraws.push({
          depthTest: this.isEnabled(this.DEPTH_TEST),
          depthWrite: this.getParameter(this.DEPTH_WRITEMASK),
        });
      return draw.apply(this, args);
    };
    proto.clear = function (mask) {
      probe.frames++;
      return clear.call(this, mask);
    };
  });
  const replay = originalMapReplay();
  replay.events = [{ type: 'hegrenade_detonate', tick: 127, x: 0, y: 0, z: 6 }];
  replay.infernos = {
    version: 1,
    tracks: [{ entity: 1, serial: 7, end: 144, updates: [[100, [[0, 0, 0, 128]]]] }],
  };
  replay.grenades = [];
  const id = 'utility-sprite-qa';
  const model = nativeMap(replay.map).model(id);
  await page.route(`**/api/demos/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name: 'Original utility effects QA',
        status: 'ready',
        public: true,
        map: replay.map,
      },
    }),
  );
  await page.route(`**/api/demos/${id}/playback`, (route) => fulfillReplayFixture(route, replay));
  await installDemoMapDescriptor(page, id, { model, overview: null });
  await nativeMap(replay.map).route(page);
  const shaderFaults: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /shader|WebGL/i.test(message.text()))
      shaderFaults.push(message.text());
  });
  await page.goto(`/watch/${id}`);
  const scene = page.locator('.scene');
  await expect(scene).toHaveAttribute('data-map-model-state', 'ready');
  const inspect = (reset = false) =>
    page.evaluate((reset) => {
      const probe = (
        window as unknown as {
          utilityDraws: {
            frames: number;
            contactDepthUploads: number;
            compiles: number;
            links: number;
            burstCompiles: number;
            spriteDraws: { depthTest: boolean; depthWrite: boolean }[];
          };
        }
      ).utilityDraws;
      if (reset) {
        probe.frames = 0;
        probe.contactDepthUploads = 0;
        probe.spriteDraws = [];
      }
      return probe;
    }, reset);
  const slider = page.getByRole('slider', { name: 'Playback position' });
  await slider.fill('99');
  await expect.poll(async () => (await inspect()).burstCompiles).toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const warm = await inspect();
  expect(warm.spriteDraws).toEqual([]);
  await slider.fill('130');
  await expect.poll(async () => (await inspect()).spriteDraws.length).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => (await inspect()).contactDepthUploads).toBeGreaterThan(0);
  expect((await inspect()).spriteDraws.every((draw) => draw.depthTest && !draw.depthWrite)).toBe(
    true,
  );
  await inspect(true);
  await slider.fill('256');
  await expect.poll(async () => (await inspect()).frames).toBeGreaterThan(0);
  expect(await inspect()).toMatchObject({ spriteDraws: [], contactDepthUploads: 0 });
  await slider.fill('130');
  await expect.poll(async () => (await inspect()).spriteDraws.length).toBeGreaterThanOrEqual(3);
  expect(await inspect()).toMatchObject({ compiles: warm.compiles, links: warm.links });
  expect(shaderFaults).toEqual([]);
});
