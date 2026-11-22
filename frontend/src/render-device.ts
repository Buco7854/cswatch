export type RenderDevice = 'software' | 'limited' | 'integrated' | 'hardware' | 'unknown';

/** Read the context that will draw the match. Keep the adapter string local and
 * use only the coarse classification for quality and diagnostics. */
export function renderDevice(gl: WebGLRenderingContext | WebGL2RenderingContext): RenderDevice {
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? '') : '';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|\bwarp\b/i.test(renderer))
    return 'software';
  if (
    gl.getParameter(gl.MAX_TEXTURE_SIZE) < 8192 ||
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) < 8192
  )
    return 'limited';
  if (
    /adreno|mali|powervr|videocore|tegra|apple gpu|intel.*(hd graphics|iris|uhd)|radeon.*\b[678]\d\dM\b/i.test(
      renderer,
    )
  )
    return 'integrated';
  if (/nvidia|geforce|radeon|intel.*arc|apple m\d/i.test(renderer)) return 'hardware';
  return 'unknown';
}
