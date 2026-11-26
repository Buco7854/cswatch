import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite's ?raw imports, as the shader modules use them.
const rawText = {
  name: 'raw-text',
  setup(plugin: import('esbuild').PluginBuild) {
    plugin.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }) => ({
      path: resolve(resolveDir, path.slice(0, -'?raw'.length)),
      namespace: 'raw-text',
    }));
    plugin.onLoad({ filter: /.*/, namespace: 'raw-text' }, async ({ path }) => ({
      contents: await readFile(path, 'utf8'),
      loader: 'text',
      resolveDir: dirname(path),
    }));
  },
};

// Label occlusion marches the same four-inch samples, noise and per-sample alpha as the volume shader.
test('label occlusion matches the drawn opacity of dense and dilute journal smoke', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
        export * as T from 'three';
        export { GRID, densityField, smokeTransmittance } from './src/smoke-field';
        export { SmokeVolumePass } from './src/smoke-volume';
      `,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    plugins: [rawText],
    write: false,
    format: 'esm',
  });
  await page.route('**/__recorded_smoke__/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('.js')
        ? { contentType: 'text/javascript', body: bundle.outputFiles[0].text }
        : { contentType: 'text/html', body: '<canvas></canvas>' },
    ),
  );
  await page.goto('/__recorded_smoke__/');
  const results = await page.evaluate(async () => {
    const { T, GRID, densityField, SmokeVolumePass, smokeTransmittance } = await import(
      '/__recorded_smoke__/lib.js' as string
    );
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('canvas'), alpha: true });
    renderer.setSize(64, 64);
    const camera = new T.PerspectiveCamera(60, 1, 0.1, 60);
    camera.position.z = 8;
    camera.updateMatrixWorld();
    const lighting = { sunDirection: new T.Vector3(0, 1, 0), sunColor: new T.Color(1, 1, 1) };
    const draw = (value: number) => {
      const density = new Uint8Array(GRID ** 3);
      for (let z = 12; z < 20; z++)
        for (let y = 12; y < 20; y++)
          for (let x = 12; x < 20; x++) density[x + GRID * (y + GRID * z)] = value;
      const field = densityField(density);
      const cloud = {
        key: 'journal-' + value,
        recorded: true,
        origin: [0, 0, 0],
        previous: field,
        current: field,
        bounds: field.bounds,
        amount: 1,
        scale: 1,
        mix: 1,
        age: 4,
        holes: [],
      };
      const scene = new T.Scene();
      const group = new T.Group();
      scene.add(group);
      const pass = new SmokeVolumePass(group);
      try {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        if (!pass.render(renderer, scene, camera, [cloud], lighting, false, false, 1))
          throw new Error('Smoke render target unavailable');
        renderer.render(scene, camera);
        const pixel = new Uint8Array(4);
        const gl = renderer.getContext();
        gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return {
          alpha: pixel[3] / 255,
          expected: 1 - smokeTransmittance(cloud, [0, 0, 8], [0, 0, -8]),
        };
      } finally {
        pass.dispose();
      }
    };
    try {
      return { dense: draw(255), dilute: draw(20) };
    } finally {
      renderer.dispose();
    }
  });
  // A saturated journal hides what lies behind it.
  expect(results.dense.expected).toBeGreaterThan(0.95);
  expect(Math.abs(results.dense.alpha - results.dense.expected)).toBeLessThan(0.04);
  // A dilute edge erodes into the noise and leaves the sightline mostly clear.
  expect(results.dilute.expected).toBeLessThan(0.5);
  expect(Math.abs(results.dilute.alpha - results.dilute.expected)).toBeLessThan(0.04);
});
