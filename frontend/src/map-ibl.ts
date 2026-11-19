import {
  CubeReflectionMapping,
  CubeTexture,
  PMREMGenerator,
  Vector4,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';

type CubeFace = CanvasImageSource & { width: number; height: number };

/** The full-resolution backdrop is not an appropriate PMREM input on a phone.
 * A 128/256 cube retains broad skylight and rough reflections with a bounded
 * 1.5/6 MiB half-float target, independent of the installed backdrop size.
 * Filtering also temporarily needs an equal blur target, approximately 0.5/2
 * MiB of mipmapped RGBA cube upload and 0.375/1.5 MiB of canvas pixels. Thus the
 * incremental GPU surface peak is approximately 3.5/14 MiB, not 1.5/6 MiB.
 * These estimates exclude the existing backdrop, driver and shader overhead. */
export function mapIblSize(cube: CubeTexture, low: boolean): number {
  const faces = cube.images as CubeFace[];
  if (
    faces.length !== 6 ||
    faces.some(
      (face) =>
        !face ||
        !Number.isInteger(face.width) ||
        face.width < 16 ||
        face.width > 2048 ||
        face.height !== face.width ||
        face.width !== faces[0].width,
    )
  )
    throw new Error('Skylight needs six decoded bounded square faces');
  return Math.min(low ? 128 : 256, 2 ** Math.floor(Math.log2(faces[0].width)));
}

/** Owned, renderer-local filtering of the already decoded official sky. This
 * supplies approximate outdoor irradiance/reflections, not native lightmaps or
 * local reflection probes. The original backdrop and its images stay untouched. */
export function createMapSkyLighting(
  renderer: WebGLRenderer,
  cube: CubeTexture,
  low: boolean,
): { texture: Texture; size: number; dispose: () => void } {
  const size = mapIblSize(cube, low),
    canvases: HTMLCanvasElement[] = [],
    width = 3 * Math.max(size, 112),
    height = 4 * size;
  if (Math.max(width, height) > renderer.capabilities.maxTextureSize)
    throw new Error('Skylight exceeds renderer texture dimensions');
  // PMREM uses RGBA16F. WebGL2 texture sampling support alone does not make
  // that format renderable. Either extension provides this exact format.
  if (
    !renderer.extensions.has('EXT_color_buffer_float') &&
    !renderer.extensions.has('EXT_color_buffer_half_float')
  )
    throw new Error('Half-float skylight rendering is unavailable');
  const input = new CubeTexture(canvases),
    generator = new PMREMGenerator(renderer),
    previousTarget = renderer.getRenderTarget(),
    previousFace = renderer.getActiveCubeFace(),
    previousMip = renderer.getActiveMipmapLevel(),
    previousViewport = renderer.getViewport(new Vector4()),
    previousScissor = renderer.getScissor(new Vector4()),
    previousScissorTest = renderer.getScissorTest(),
    previousCurrentViewport = renderer.getCurrentViewport(new Vector4()),
    context = renderer.getContext(),
    previousCurrentScissor = new Vector4().fromArray(context.getParameter(context.SCISSOR_BOX)),
    previousCurrentScissorTest = context.isEnabled(context.SCISSOR_TEST),
    previousXr = renderer.xr.enabled,
    previousAutoClear = renderer.autoClear,
    previousToneMapping = renderer.toneMapping,
    setRenderTarget = renderer.setRenderTarget;
  let target: Parameters<WebGLRenderer['setRenderTarget']>[0] | undefined;
  const checked = new WeakSet<object>();
  // The public generator does not return its output when a draw throws. Its
  // first private target is its output, followed by its owned blur temporary.
  // Observe this synchronous conversion only, restoring the exact method before
  // any renderer use or cleanup. This also releases a partially written output.
  renderer.setRenderTarget = function (next, ...rest) {
    if (!target && next && next !== previousTarget) target = next;
    const result = setRenderTarget.call(this, next, ...rest);
    if (next && next !== previousTarget && !checked.has(next)) {
      // Capability advertisement is not proof of a complete allocation. Check
      // both private color targets before their first conversion/blur draw.
      if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE)
        throw new Error('Skylight framebuffer is incomplete');
      checked.add(next);
    }
    return result;
  };
  let ready = false;
  try {
    for (const face of cube.images as CubeFace[]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvases.push(canvas);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Skylight downsampling is unavailable');
      context.drawImage(face, 0, 0, size, size);
    }
    input.colorSpace = cube.colorSpace;
    input.mapping = CubeReflectionMapping;
    input.flipY = cube.flipY;
    input.needsUpdate = true;
    const filtered = generator.fromCubemap(input);
    if (filtered !== target) {
      filtered.dispose();
      throw new Error('Skylight target ownership is unavailable');
    }
    filtered.texture.name = 'cswatch filtered local sky';
    ready = true;
    let disposed = false;
    return {
      texture: filtered.texture,
      size,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        filtered.dispose();
      },
    };
  } finally {
    // PMREM restores its renderer on success. Also restore on conversion failure,
    // before releasing its private target and intermediate resources.
    renderer.setRenderTarget = setRenderTarget;
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    if (previousTarget) {
      // Global getters describe the default framebuffer, not a bound target's
      // current viewport/scissor. Binding uses these target-local properties.
      // Temporarily restore the captured current state through that public API,
      // then return the foreign target's metadata without changing its pixels.
      const viewport = previousTarget.viewport.clone(),
        scissor = previousTarget.scissor.clone(),
        scissorTest = previousTarget.scissorTest;
      try {
        previousTarget.viewport.copy(previousCurrentViewport);
        previousTarget.scissor.copy(previousCurrentScissor);
        previousTarget.scissorTest = previousCurrentScissorTest;
        renderer.setRenderTarget(previousTarget, previousFace, previousMip);
      } finally {
        previousTarget.viewport.copy(viewport);
        previousTarget.scissor.copy(scissor);
        previousTarget.scissorTest = scissorTest;
      }
    } else {
      renderer.setRenderTarget(null, previousFace, previousMip);
      // Default binding floors logical coordinates at fractional DPR, while a
      // later public setViewport/setScissor rounds them. Preserve either form.
      if (!renderer.getCurrentViewport(new Vector4()).equals(previousCurrentViewport))
        renderer.setViewport(previousViewport);
      if (
        !new Vector4()
          .fromArray(context.getParameter(context.SCISSOR_BOX))
          .equals(previousCurrentScissor)
      )
        renderer.setScissor(previousScissor);
    }
    renderer.xr.enabled = previousXr;
    renderer.autoClear = previousAutoClear;
    renderer.toneMapping = previousToneMapping;
    generator.dispose();
    input.dispose();
    for (const canvas of canvases) canvas.width = canvas.height = 0;
    if (!ready) target?.dispose();
  }
}

/** Independent landscape/POV passes share the world's light, then restore their
 * own state. The callback's failure must not leave a retired cube installed. */
export function withSceneEnvironment<T>(source: Scene, target: Scene, render: () => T): T {
  const environment = target.environment,
    intensity = target.environmentIntensity,
    rotation = target.environmentRotation.clone();
  try {
    target.environment = source.environment;
    target.environmentIntensity = source.environmentIntensity;
    target.environmentRotation.copy(source.environmentRotation);
    return render();
  } finally {
    target.environment = environment;
    target.environmentIntensity = intensity;
    target.environmentRotation.copy(rotation);
  }
}
