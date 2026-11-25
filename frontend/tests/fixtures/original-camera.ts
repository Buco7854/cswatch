import type { Page } from '@playwright/test';

type CameraView = {
  position: number[];
  view: number[];
  matrix: number[];
  projection: number[];
  drawingBuffer: number[];
};

/** Observe the actual rendered camera through the native world program's own uniforms,
 * without depending on React/Three private instance fields or test app hooks. */
export async function installOriginalCameraProbe(page: Page) {
  await page.addInitScript(() => {
    const locations = new WeakMap<WebGLUniformLocation, string>();
    const programs = new WeakMap<WebGL2RenderingContext, WebGLProgram | null>();
    const eyes = new WeakMap<WebGLProgram, number[]>();
    const capture = {
      position: [] as number[],
      view: [] as number[],
      matrix: [] as number[],
      projection: [] as number[],
      drawingBuffer: [] as number[],
    };
    (window as unknown as { qaOriginalCamera: typeof capture }).qaOriginalCamera = capture;
    const location = WebGL2RenderingContext.prototype.getUniformLocation;
    const matrix = WebGL2RenderingContext.prototype.uniformMatrix4fv;
    const vector = WebGL2RenderingContext.prototype.uniform3fv;
    const use = WebGL2RenderingContext.prototype.useProgram;
    // Column-major 4x4 product a * b.
    const multiply = (a: number[], b: number[]) =>
      Array.from({ length: 16 }, (_, index) => {
        const row = index % 4,
          column = index - row;
        return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column + k], 0);
      });
    // General 4x4 inverse by cofactors, column-major.
    const invert = (m: number[]) => {
      const out = new Array<number>(16);
      for (let i = 0; i < 16; i++) {
        const row = i % 4,
          column = Math.floor(i / 4);
        const minor = [0, 1, 2, 3]
          .filter((r) => r !== column)
          .map((r) => [0, 1, 2, 3].filter((c) => c !== row).map((c) => m[c * 4 + r]));
        const det3 =
          minor[0][0] * (minor[1][1] * minor[2][2] - minor[1][2] * minor[2][1]) -
          minor[0][1] * (minor[1][0] * minor[2][2] - minor[1][2] * minor[2][0]) +
          minor[0][2] * (minor[1][0] * minor[2][1] - minor[1][1] * minor[2][0]);
        out[i] = ((row + column) % 2 ? -1 : 1) * det3;
      }
      const det = m[0] * out[0] + m[1] * out[4] + m[2] * out[8] + m[3] * out[12];
      return out.map((x) => x / det);
    };
    const inch = 1 / 0.0254;
    // Viewer metres (Y up) to Source inches (Z up), and the original map root's +90 degree Y turn.
    const viewerToSource = [inch, 0, 0, 0, 0, 0, inch, 0, 0, -inch, 0, 0, 0, 0, 0, 1];
    const mapRoot = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
    WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
      const value = location.call(this, program, name);
      if (value) locations.set(value, name);
      return value;
    };
    WebGL2RenderingContext.prototype.useProgram = function (program) {
      programs.set(this, program);
      return use.call(this, program);
    };
    WebGL2RenderingContext.prototype.uniform3fv = function (at, values, ...rest) {
      const program = programs.get(this);
      if (program && at && locations.get(at) === 'eye') {
        const eye = Array.from(values as number[]);
        eyes.set(program, eye);
        capture.position = [eye[0] * 0.0254, eye[2] * 0.0254, -eye[1] * 0.0254];
      }
      return (vector as (...args: unknown[]) => void).call(this, at, values, ...rest);
    };
    WebGL2RenderingContext.prototype.uniformMatrix4fv = function (at, transpose, values) {
      const program = programs.get(this);
      const eye = program && eyes.get(program);
      const name = program && at ? locations.get(at) : undefined;
      // The sky pass draws every frame with the inverse view-projection; culling can skip
      // every world draw, so both supply the camera.
      if (name === 'viewProjection' || name === 'unproject') {
        // Split the native view-projection: rows 0 and 1 are the projection scales times
        // orthonormal view rows, and row 3 is the negated view Z row.
        const m =
          name === 'unproject'
            ? invert(Array.from(values as number[]))
            : Array.from(values as number[]);
        const row = (r: number) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
        const [r0, r1, r2, r3] = [0, 1, 2, 3].map(row);
        // The view rows carry the 0.0254 inch-to-metre scale of the Source world.
        const p00 = Math.hypot(r0[0], r0[1], r0[2]) / 0.0254,
          p11 = Math.hypot(r1[0], r1[1], r1[2]) / 0.0254;
        const p22 =
            -(r2[0] * r3[0] + r2[1] * r3[1] + r2[2] * r3[2]) /
            (r3[0] * r3[0] + r3[1] * r3[1] + r3[2] * r3[2]),
          p23 = r2[3] + p22 * r3[3];
        const viewRows = [
          r0.map((x) => x / p00),
          r1.map((x) => x / p11),
          r3.map((x) => -x),
          [0, 0, 0, 1],
        ];
        const sourceView = Array.from({ length: 16 }, (_, i) => viewRows[i % 4][Math.floor(i / 4)]);
        capture.view = multiply(sourceView, viewerToSource);
        capture.matrix = multiply(capture.view, mapRoot);
        capture.projection = [p00, 0, 0, 0, 0, p11, 0, 0, 0, 0, p22, -1, 0, 0, p23, 0];
        capture.drawingBuffer = [this.drawingBufferWidth, this.drawingBufferHeight];
        if (eye) capture.position = [eye[0] * 0.0254, eye[2] * 0.0254, -eye[1] * 0.0254];
      }
      return matrix.call(this, at, transpose, values);
    };
  });
}
export function originalCameraView(page: Page): Promise<CameraView> {
  return page.evaluate(
    () => (window as unknown as { qaOriginalCamera: CameraView }).qaOriginalCamera,
  );
}

/** Read the source floor's origin even when camera framing offsets it. */
export async function originalFloorPixel(page: Page) {
  await page.waitForFunction(
    () => {
      const view = (window as unknown as { qaOriginalCamera: CameraView }).qaOriginalCamera;
      return view.projection.length === 16 && Math.abs(view.matrix[6]) > 0.99;
    },
    undefined,
    { timeout: 1000 },
  );
  const { matrix, projection } = await originalCameraView(page);
  const canvas = await page.locator('.scene canvas').boundingBox();
  if (!canvas || !projection.length) return [NaN, NaN, NaN];
  const clip = [0, 1, 2, 3].map(
    (row) =>
      projection[row] * matrix[12] +
      projection[row + 4] * matrix[13] +
      projection[row + 8] * matrix[14] +
      projection[row + 12] * matrix[15],
  );
  const x = Math.floor(canvas.x + ((1 + clip[0] / clip[3]) * canvas.width) / 2);
  const y = Math.floor(canvas.y + ((1 - clip[1] / clip[3]) * canvas.height) / 2);
  const bytes = await page.screenshot({
    clip: { x, y, width: 1, height: 1 },
    style: '.actor-overlays { opacity: 0 !important; }',
  });
  return page.evaluate(
    async (png) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(png)], { type: 'image/png' }),
      );
      const surface = new OffscreenCanvas(1, 1);
      const context = surface.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    },
    [...bytes],
  );
}
