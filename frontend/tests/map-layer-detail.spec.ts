import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('paint on a two-detail map surface blends detail colors and strengths independently', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        "export * as T from 'three'; export {applyLayerShader} from './src/map-material-layers';",
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'esm',
  });
  await page.route('**/__layer_detail__/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('.js')
        ? { contentType: 'text/javascript', body: bundle.outputFiles[0].text }
        : { contentType: 'text/html', body: '<canvas></canvas>' },
    ),
  );
  await page.goto('/__layer_detail__/');
  const pixels = await page.evaluate(async () => {
    const { T, applyLayerShader } = await import('/__layer_detail__/lib.js' as string);
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('canvas')! });
    renderer.setSize(18, 6, false);
    renderer.outputColorSpace = T.LinearSRGBColorSpace;
    const scene = new T.Scene(),
      camera = new T.OrthographicCamera(-1.5, 1.5, 0.5, -0.5, 0.01, 10);
    camera.position.z = 1;
    const solid = (value: number) => {
      const texture = new T.DataTexture(new Uint8Array([value, value, value, 255]), 1, 1);
      texture.needsUpdate = true;
      return texture;
    };
    const material = new T.MeshBasicMaterial({ map: solid(128) });
    material.onBeforeCompile = (shader: Parameters<typeof applyLayerShader>[0]) =>
      applyLayerShader(shader, {
        color: solid(128),
        blend: solid(128),
        detail: { texture: solid(32), scale: [2, 2], strength: 0.25 },
        secondDetail: { texture: solid(224), scale: [4, 4], strength: 0.75 },
      });
    for (const [index, paint] of [0, 0.5, 1].entries()) {
      const geometry = new T.PlaneGeometry(1, 1);
      const values = new Float32Array(4 * geometry.attributes.position.count);
      for (let j = 0; j < values.length; j += 4) values[j] = paint;
      geometry.setAttribute('_texcoord_4', new T.BufferAttribute(values, 4));
      const tile = new T.Mesh(geometry, material);
      tile.position.x = index - 1;
      scene.add(tile);
    }
    renderer.render(scene, camera);
    const result: number[] = [];
    const gl = renderer.getContext(),
      pixel = new Uint8Array(4);
    for (const x of [3, 9, 15]) {
      gl.readPixels(x, 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      result.push(pixel[0]);
    }
    renderer.dispose();
    return result;
  });
  for (const [i, expected] of [104, 128, 201].entries()) {
    expect(Math.abs(pixels[i] - expected)).toBeLessThanOrEqual(2);
  }
});
