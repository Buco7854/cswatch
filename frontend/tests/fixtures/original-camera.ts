import type { Page } from '@playwright/test';

type CameraView = { position: number[]; matrix: number[] };

/** Observe the actual rendered camera through the original QA floor's draw,
 * without depending on React/Three private instance fields or test app hooks. */
export async function installOriginalCameraProbe(page: Page) {
  await page.addInitScript(() => {
    const locations = new WeakMap<WebGLUniformLocation, string>();
    const programs = new WeakMap<WebGL2RenderingContext, WebGLProgram | null>();
    const matrices = new WeakMap<WebGLProgram, number[]>();
    const capture = { position: [] as number[], matrix: [] as number[] };
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
      if (program && at && locations.get(at) === 'modelViewMatrix')
        matrices.set(program, Array.from(values));
      return matrix.call(this, at, transpose, values);
    };
    WebGL2RenderingContext.prototype.drawArrays = function (mode, first, count) {
      const program = programs.get(this),
        m = program && matrices.get(program);
      if (count === 18 && m) {
        // The original floor is the only 18-vertex non-indexed draw. Invert its
        // orthonormal model-view transform, then apply the documented +90Y base.
        const x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
          y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
          z = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
        capture.position = [z, y, -x];
        capture.matrix = [...m];
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
