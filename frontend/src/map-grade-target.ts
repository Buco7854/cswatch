import { HalfFloatType, WebGLRenderTarget, type WebGLRenderer } from 'three';

class IntermediateGradeTarget extends WebGLRenderTarget {
  constructor(readonly owner: WebGLRenderTarget) {
    super(owner.width, owner.height, { type: HalfFloatType, stencilBuffer: true });
  }
}

/** Borrow Three's already allocated MSAA framebuffer using its external-target API (also
 * used by WebXR). The owner's textures, sample count and depth/stencil storage stay intact.
 * The wrapper has zero samples so intermediate render calls don't resolve the color. */
export function intermediateGradeTarget(gl: WebGLRenderer, target: WebGLRenderTarget) {
  const external = gl as WebGLRenderer & {
    setRenderTargetFramebuffer?: (target: WebGLRenderTarget, framebuffer: WebGLFramebuffer) => void;
  };
  if (
    !target.samples ||
    !external.setRenderTargetFramebuffer ||
    gl.extensions.has('WEBGL_multisampled_render_to_texture')
  )
    return;
  const context = gl.getContext();
  const framebuffer = context.getParameter(context.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  if (!framebuffer) return;
  const wrapper = new IntermediateGradeTarget(target);
  external.setRenderTargetFramebuffer(wrapper, framebuffer);
  return wrapper;
}

/** Rebind the same multisampled attachments through their owner so Three resolves once
 * after the final world or viewmodel render, before the grade samples its texture. */
export function beginFinalGradePass(gl: WebGLRenderer) {
  const current = gl.getRenderTarget();
  if (current instanceof IntermediateGradeTarget) gl.setRenderTarget(current.owner);
}
