import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('dilute journal smoke attenuates a clear sightline at the reconstructed density', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
        export * as T from 'three';
        export { GRID, lightField, smokeTransmittance } from './src/smoke-field';
        export { SmokeVolumePass } from './src/smoke-volume';
      `,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
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
  const { alpha, expected } = await page.evaluate(async () => {
    const { T, GRID, lightField, SmokeVolumePass, smokeTransmittance } = await import(
      '/__recorded_smoke__/lib.js' as string
    );
    const density = new Uint8Array(GRID ** 3);
    for (let z = 12; z < 20; z++)
      for (let y = 12; y < 20; y++)
        for (let x = 12; x < 20; x++) density[x + GRID * (y + GRID * z)] = 20;
    const field = lightField(density, [0, 1, 0]);
    const cloud = {
      key: 'dilute',
      recorded: true,
      origin: [0, 0, 0],
      previous: field,
      current: field,
      bounds: field.bounds,
      amount: 1,
      scale: 1,
      mix: 1,
      drift: 0,
      tint: new T.Color(1, 1, 1),
      holes: [],
    };
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('canvas'), alpha: true });
    renderer.setSize(64, 64);
    const scene = new T.Scene();
    const group = new T.Group();
    scene.add(group);
    const camera = new T.PerspectiveCamera(60, 1, 0.1, 60);
    camera.position.z = 8;
    camera.updateMatrixWorld();
    const pass = new SmokeVolumePass(group, new T.Vector3(0, 1, 0));
    try {
      if (!pass.render(renderer, scene, camera, [cloud], cloud.tint, false, false, 1))
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
      renderer.dispose();
    }
  });
  expect(expected).toBeGreaterThan(0.5);
  expect(Math.abs(alpha - expected)).toBeLessThan(0.04);
});
