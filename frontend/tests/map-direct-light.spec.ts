import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('an occluded baked sun still admits a nearby point light and interpolates partial sun', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        "export * as T from 'three'; export {registerMapBakedLighting} from './src/map-baked-lighting'; export {playerShadows} from './src/player-shadows';",
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'esm',
  });
  await page.route('**/__direct_light__/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('.js')
        ? { contentType: 'text/javascript', body: bundle.outputFiles[0].text }
        : { contentType: 'text/html', body: '<canvas></canvas>' },
    ),
  );
  await page.goto('/__direct_light__/');
  const rows = await page.evaluate(async () => {
    const { T, registerMapBakedLighting, playerShadows } = await import(
      /* @vite-ignore */ '/__direct_light__/test.js' as string
    );
    const canvas = document.querySelector('canvas')!;
    const renderer = new T.WebGLRenderer({ canvas });
    const scene = new T.Scene(),
      camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    const mat = new T.MeshStandardMaterial({ color: 0x666666, roughness: 1 });
    const plane = new T.PlaneGeometry(2, 2);
    plane.setAttribute('uv1', plane.getAttribute('uv'));
    const floor = new T.Mesh(plane, mat);
    scene.add(floor);
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data[i * 4 + 3] = [255, 128, 1, 1][i % 4];
    const atlas = new T.DataTexture(data, 4, 4);
    atlas.needsUpdate = true;
    const parser = {
      associations: new Map([[mat, { materials: 0 }]]),
      json: {
        textures: [{}],
        materials: [
          {
            extensions: {
              CSWATCH_baked_lighting: {
                schemaVersion: 1,
                irradianceTexture: { index: 0, texCoord: 1 },
              },
            },
          },
        ],
      },
      getDependency: () => Promise.resolve(atlas),
    };
    let binding: { afterRoot: (g: { scenes: unknown[] }) => Promise<void> };
    registerMapBakedLighting({
      register: (f: (p: typeof parser) => typeof binding) => {
        binding = f(parser);
      },
    });
    await binding!.afterRoot({ scenes: [scene] });
    const sun = new T.DirectionalLight(0xffffff, 1.5);
    const point = new T.PointLight(0xffffff, 0, 4);
    sun.position.z = 3;
    point.position.z = 1;
    scene.add(sun, point);
    const target = new T.WebGLRenderTarget(48, 24);
    renderer.setRenderTarget(target);
    function draw() {
      renderer.render(scene, camera);
      const pixels = new Uint8Array(48 * 24 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 48, 24, pixels);
      return pixels;
    }
    const samples = (pixels: Uint8Array) => [6, 18, 30].map((x) => pixels[(12 * 48 + x) * 4]);
    const sample = () => samples(draw());
    const sunOnly = sample();
    point.intensity = 4;
    const both = sample();
    point.position.z = 7;
    const outOfRange = sample();
    point.intensity = 0;
    sun.position.z = -3;
    const back = sample();
    // Same front-facing plane, opposite painted normals, oblique sun. Mark
    // fragments entering the actual shadow receiver in a separate diagnostic pass.
    const normals = new T.DataTexture(new Uint8Array([0, 128, 160, 255, 255, 128, 160, 255]), 2, 1);
    normals.needsUpdate = true;
    sun.position.set(2, 0, 1);
    const shadow = playerShadows();
    function compareReceiver(material: typeof mat) {
      floor.material = material;
      material.normalMap = normals;
      material.needsUpdate = true;
      const reference = draw();
      const release = shadow.receivers(floor);
      const candidate = draw();
      const drawError = renderer.getContext().getError();
      const receiver = floor.material;
      const original = receiver.onBeforeCompile;
      const key = receiver.customProgramCacheKey();
      receiver.onBeforeCompile = (shader: Parameters<typeof original>[0], gl: typeof renderer) => {
        original.call(receiver, shader, gl);
        shader.fragmentShader = shader.fragmentShader
          .replace(
            'float playerSunVisibility() {',
            'bool visited = false; float playerSunVisibility() { visited = true;',
          )
          .replace(
            '#include <opaque_fragment>',
            '#include <opaque_fragment>\ngl_FragColor.rgb = vec3(visited ? 1.0 : 0.0);',
          );
      };
      receiver.customProgramCacheKey = () => key + '-probe-visited';
      receiver.needsUpdate = true;
      const diagnostic = draw();
      const visited = diagnostic.filter((value, i) => i % 4 === 0 && value !== 0).length;
      release();
      return {
        reference: samples(reference),
        matched: candidate.every((value, i) => value === reference[i]),
        visited,
        drawError,
      };
    }
    const standard = new T.MeshStandardMaterial({ color: 0x999999, roughness: 0.5 });
    const coat = new T.MeshPhysicalMaterial({
      color: 0x999999,
      clearcoat: 1,
      clearcoatRoughness: 0.5,
    });
    const ordinary = compareReceiver(standard),
      painted = compareReceiver(mat),
      coated = compareReceiver(coat);
    normals.dispose();
    standard.dispose();
    coat.dispose();
    shadow.dispose();
    target.dispose();
    plane.dispose();
    mat.lightMap.dispose();
    atlas.dispose();
    mat.dispose();
    renderer.dispose();
    return { sunOnly, both, outOfRange, back, ordinary, painted, coated };
  });
  expect(rows.back).toEqual([0, 0, 0]);
  expect(rows.sunOnly[0]).toBe(0);
  expect(rows.sunOnly[1]).toBeGreaterThan(0);
  expect(rows.sunOnly[2]).toBeGreaterThan(rows.sunOnly[1]);
  expect(rows.both[0]).toBeGreaterThan(0);
  expect(rows.outOfRange).toEqual(rows.sunOnly);
  for (const row of [rows.ordinary, rows.painted, rows.coated]) {
    expect(row.drawError).toBe(0);
    expect(row.matched).toBe(true);
  }
  expect(rows.ordinary.reference[2]).toBeGreaterThan(rows.ordinary.reference[1]);
  expect(rows.ordinary.visited).toBe(24 * 24);
  expect(rows.painted.visited).toBe(24 * 24);
  expect(rows.coated.visited).toBe(48 * 24);
  expect(rows.coated.reference[1]).toBeGreaterThan(0);
});
