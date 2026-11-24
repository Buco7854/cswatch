import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('an occluded baked sun still admits a nearby point light and interpolates partial sun', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        "export * as T from 'three'; export {registerMapBakedLighting} from './src/map-baked-lighting';",
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
    const { T, registerMapBakedLighting } = await import(
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
    scene.add(new T.Mesh(plane, mat));
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
    function sample() {
      renderer.render(scene, camera);
      const pixels = new Uint8Array(48 * 24 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 48, 24, pixels);
      return [6, 18, 30].map((x) => pixels[(12 * 48 + x) * 4]);
    }
    const sunOnly = sample();
    point.intensity = 4;
    const both = sample();
    point.position.z = 7;
    const outOfRange = sample();
    point.intensity = 0;
    sun.position.z = -3;
    const back = sample();
    target.dispose();
    plane.dispose();
    mat.lightMap.dispose();
    atlas.dispose();
    mat.dispose();
    renderer.dispose();
    return { sunOnly, both, outOfRange, back };
  });
  expect(rows.back).toEqual([0, 0, 0]);
  expect(rows.sunOnly[0]).toBe(0);
  expect(rows.sunOnly[1]).toBeGreaterThan(0);
  expect(rows.sunOnly[2]).toBeGreaterThan(rows.sunOnly[1]);
  expect(rows.both[0]).toBeGreaterThan(0);
  expect(rows.outOfRange).toEqual(rows.sunOnly);
});
