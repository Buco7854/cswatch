import type { Page } from '@playwright/test';

type CameraView = {
  position: number[];
  matrix: number[];
  projection: number[];
  drawingBuffer: number[];
};

/** Observe the actual rendered camera through the original QA floor's draw,
 * without depending on React/Three private instance fields or test app hooks. */
export async function installOriginalCameraProbe(page: Page) {
  await page.addInitScript(() => {
    const locations = new WeakMap<WebGLUniformLocation, string>();
    const programs = new WeakMap<WebGL2RenderingContext, WebGLProgram | null>();
    const matrices = new WeakMap<WebGLProgram, number[]>();
    const worldMatrices = new WeakMap<WebGLProgram, number[]>();
    const viewMatrices = new WeakMap<WebGLProgram, number[]>();
    const projections = new WeakMap<WebGLProgram, number[]>();
    const capture = {
      position: [] as number[],
      matrix: [] as number[],
      projection: [] as number[],
      drawingBuffer: [] as number[],
    };
    (window as unknown as { qaOriginalCamera: typeof capture }).qaOriginalCamera = capture;
    const location = WebGL2RenderingContext.prototype.getUniformLocation;
    const matrix = WebGL2RenderingContext.prototype.uniformMatrix4fv;
    const use = WebGL2RenderingContext.prototype.useProgram;
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
      const value = location.call(this, program, name);
      if (value) locations.set(value, name);
      return value;
    };
    WebGL2RenderingContext.prototype.useProgram = function (program) {
      programs.set(this, program);
      return use.call(this, program);
    };
    WebGL2RenderingContext.prototype.uniformMatrix4fv = function (at, transpose, values) {
      const program = programs.get(this);
      if (program && at) {
        const name = locations.get(at);
        if (name === 'modelViewMatrix') matrices.set(program, Array.from(values));
        if (name === 'modelMatrix') worldMatrices.set(program, Array.from(values));
        if (name === 'viewMatrix') viewMatrices.set(program, Array.from(values));
        if (name === 'projectionMatrix') projections.set(program, Array.from(values));
      }
      return matrix.call(this, at, transpose, values);
    };
    WebGL2RenderingContext.prototype.drawArrays = function (mode, first, count) {
      const program = programs.get(this);
      if (count !== 18 || !program) return draw.call(this, mode, first, count);
      let m = matrices.get(program);
      if (!m) {
        // The original Source shader supplies model and view matrices separately.
        const world = worldMatrices.get(program),
          view = viewMatrices.get(program);
        if (world && view)
          m = world.map((_, index) => {
            const row = index % 4,
              column = index - row;
            return (
              view[row] * world[column] +
              view[row + 4] * world[column + 1] +
              view[row + 8] * world[column + 2] +
              view[row + 12] * world[column + 3]
            );
          });
      }
      if (m && Math.abs(Math.hypot(m[0], m[1], m[2]) - 1) < 0.001) {
        // The original floor is the unscaled 18-vertex non-indexed draw. Invert its
        // orthonormal model-view transform, then apply the documented +90Y base.
        const x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
          y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
          z = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
        capture.position = [z, y, -x];
        capture.matrix = [...m];
        capture.projection = projections.get(program) || [];
        capture.drawingBuffer = [this.drawingBufferWidth, this.drawingBufferHeight];
      }
      return draw.call(this, mode, first, count);
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
