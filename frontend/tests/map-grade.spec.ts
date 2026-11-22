import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const curves = [
  {
    shoulder: 0,
    linear: 0.001,
    angle: 0.001,
    toe: 1,
    numerator: 1,
    denominator: 1,
    whiteStops: 1.5,
  },
  {
    shoulder: 0.22,
    linear: 0.3,
    angle: 0.1,
    toe: 0.2,
    numerator: 0.01,
    denominator: 0.3,
    whiteStops: 4,
  },
];
const inputs = Array.from({ length: 129 }, (_, i) => i * 2 ** -6);
const exposure = { min: 0.8, max: 1, bias: 0 };

// Independent double-precision reference, in the original rational form.
function cpuGrade(input: number, curve: (typeof curves)[number]) {
  const f = (x: number) =>
    (x * (curve.shoulder * x + curve.linear * curve.angle) + curve.toe * curve.numerator) /
      (x * (curve.shoulder * x + curve.linear) + curve.toe * curve.denominator) -
    curve.numerator / curve.denominator;
  const white = Math.pow(2, curve.whiteStops);
  const x = Math.min(white, input * exposure.min * 2 ** exposure.bias * 2.8);
  const y = f(x) / f(white);
  return Math.round(255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055));
}

test('WebGL authored grade matches a neutral ramp reference and samples RGB LUT axes', async ({
  page,
}) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    stdin: {
      contents: "export { createGradeOutput } from './frontend/src/map-grade';",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: 'esm',
    external: ['three'],
  });
  await page.route('**/__qa_grade__/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'grade.js')
      return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (name === 'three.module.js' || name === 'three.core.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: await readFile(root + 'frontend/node_modules/three/build/' + name),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><script type="importmap">{"imports":{"three":"./three.module.js"}}</script>',
    });
  });
  await page.goto('/__qa_grade__/index.html');
  const output = await page.evaluate(
    async ({ inputs, curves, exposure }) => {
      const base = location.origin + '/__qa_grade__/';
      const T = await import(base + 'three.module.js');
      const { createGradeOutput } = await import(base + 'grade.js');
      const renderer = new T.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
      renderer.setSize(inputs.length, 1);
      renderer.toneMapping = T.ACESFilmicToneMapping;
      const context = renderer.getContext();
      const source = new T.DataTexture(
        new Float32Array(inputs.flatMap((x) => [x, x, x, 1])),
        inputs.length,
        1,
        T.RGBAFormat,
        T.FloatType,
      );
      source.needsUpdate = true;
      const render = (curve, axisTest: boolean) => {
        const data = new Uint8Array(32);
        for (let i = 0; i < 8; i++)
          data.set(
            axisTest
              ? [255 * (i & 1), 0, 0, 255]
              : [255 * (i & 1), 255 * ((i >> 1) & 1), 255 * (i >> 2), 255],
            i * 4,
          );
        const out = createGradeOutput({ curve, exposure, lut: { size: 2 } }, data);
        out.material.uniforms.sceneColor.value = source;
        renderer.render(out.scene, out.camera);
        const pixels = new Uint8Array(inputs.length * 4);
        context.readPixels(0, 0, inputs.length, 1, context.RGBA, context.UNSIGNED_BYTE, pixels);
        out.dispose();
        return Array.from(pixels);
      };
      const ramps = curves.map((curve) => render(curve, false));
      source.image.data.set([0, 2, 2, 1, 2, 0, 0, 1]);
      source.needsUpdate = true;
      const axes = render(curves[0], true).slice(0, 8);
      source.dispose();
      renderer.dispose();
      return { ramps, axes };
    },
    { inputs, curves, exposure },
  );
  for (const [index, curve] of curves.entries()) {
    const expected = inputs.map((input) => cpuGrade(input, curve));
    const maximumError = Math.max(
      ...output.ramps[index].map((pixel, i) =>
        Math.abs(pixel - (i % 4 === 3 ? 255 : expected[Math.floor(i / 4)])),
      ),
    );
    expect(maximumError).toBeLessThanOrEqual(1);
  }
  // Mirage's rational expression simplifies to x/(1+0.001*x), normalized
  // at sqrt(8). At scene 0.25, 0.50, 1.00 this gives linear 0.19844,
  // 0.39665, 0.79242 and sRGB bytes 123, 169, 230.
  expect([16, 32, 64].map((i) => output.ramps[0][i * 4])).toEqual([123, 169, 230]);
  expect(output.axes).toEqual([0, 0, 0, 255, 255, 0, 0, 255]);
});
