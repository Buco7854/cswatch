import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { HalfFloatType, LinearFilter, Vector2, WebGLRenderTarget } from 'three';
import { intermediateGradeTarget } from '../map-grade-target';
import type { MapEnvironment } from '../../../shared/map-assets';
import { createGradeOutput, loadGradeLut, MapGradeContext, type AuthoredGrade } from '../map-grade';

const attachmentBudget = 384 * 1024 ** 2;
const attachmentBytesPerPixel = 12; // RGBA16F and DEPTH24_STENCIL8

export default function SceneGrade({
  environment,
  low,
  revision,
  manualWorld,
  children,
}: {
  environment: MapEnvironment | null;
  low: boolean;
  revision: number;
  manualWorld: boolean;
  children: ReactNode;
}) {
  const gl = useThree((state) => state.gl);
  const context = gl.getContext() as WebGL2RenderingContext;
  const [loaded, setLoaded] = useState<AuthoredGrade & { url: string }>();
  const grade = environment?.grade;
  const url = environment?.gradeUrl;
  const renderableFloat =
    gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float');
  useEffect(() => {
    if (
      !grade ||
      !url ||
      !globalThis.crypto?.subtle ||
      context.getParameter(context.MAX_3D_TEXTURE_SIZE) < grade.lut.size
    )
      return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    loadGradeLut(url, grade, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setLoaded({ grade, bytes, url });
      })
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [context, grade, url]);
  const authored = loaded && loaded.grade === grade && loaded.url === url ? loaded : undefined;
  return (
    <MapGradeContext.Provider value={authored?.grade}>
      {renderableFloat && (
        <GradeFrames key={revision} authored={authored} low={low} manualWorld={manualWorld} />
      )}
      {children}
    </MapGradeContext.Provider>
  );
}

function GradeFrames({
  authored,
  low,
  manualWorld,
}: {
  authored?: AuthoredGrade;
  low: boolean;
  manualWorld: boolean;
}) {
  const resources = useRef<{
    target: WebGLRenderTarget;
    intermediate?: WebGLRenderTarget;
    output: ReturnType<typeof createGradeOutput>;
    size: Vector2;
    samples: number[];
    discardAttachments: number[];
    maxEdge: number;
    tested: Vector2;
    usable: boolean;
  }>(null);
  const { gl, invalidate } = useThree();
  useLayoutEffect(() => {
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      stencilBuffer: true,
      resolveDepthBuffer: false,
      resolveStencilBuffer: false,
    });
    const context = gl.getContext() as WebGL2RenderingContext;
    const available = (format: number): number[] =>
      Array.from(context.getInternalformatParameter(context.RENDERBUFFER, format, context.SAMPLES));
    const samples: number[] = [];
    if (low || context.getContextAttributes()?.antialias) {
      const depth = available(context.DEPTH24_STENCIL8);
      const max = Math.min(low ? Infinity : 4, context.getParameter(context.MAX_SAMPLES));
      samples.push(
        ...available(context.RGBA16F)
          .filter((n) => n > 1 && n <= max && depth.includes(n))
          .sort((a, b) => (low ? a - b : b - a)),
      );
    }
    samples.push(0);
    const output = createGradeOutput();
    output.material.uniforms.sceneColor.value = target.texture;
    resources.current = {
      target,
      output,
      size: new Vector2(),
      samples,
      discardAttachments: [context.DEPTH_ATTACHMENT, context.STENCIL_ATTACHMENT],
      maxEdge: Math.min(
        gl.capabilities.maxTextureSize,
        context.getParameter(context.MAX_RENDERBUFFER_SIZE),
      ),
      tested: new Vector2(),
      usable: false,
    };
    return () => {
      const intermediate = resources.current?.intermediate;
      resources.current = null;
      if (gl.getRenderTarget() === target || gl.getRenderTarget() === intermediate)
        gl.setRenderTarget(null);
      intermediate?.dispose();
      output.dispose();
      target.dispose();
    };
  }, [gl, low]);
  useLayoutEffect(() => {
    const { output } = resources.current!;
    output.setGrade(authored);
    invalidate();
  }, [authored, gl, invalidate, low]);

  useFrame(({ gl }) => {
    const frame = resources.current;
    if (!frame || gl.getRenderTarget()) return;
    const { target, size, samples, maxEdge } = frame;
    gl.getDrawingBufferSize(size);
    if (!size.x || !size.y) return;
    if (!frame.tested.equals(size)) {
      // Preserve the selected resolution before spending memory on MSAA.
      // Scale only when a single-sample target would exceed allocation limits.
      const scale = Math.min(
        1,
        maxEdge / Math.max(size.x, size.y),
        Math.sqrt(attachmentBudget / (attachmentBytesPerPixel * size.x * size.y)),
      );
      const width = Math.max(1, Math.floor(size.x * scale));
      const height = Math.max(1, Math.floor(size.y * scale));
      const context = gl.getContext();
      frame.tested.copy(size);
      frame.usable = false;
      frame.intermediate?.dispose();
      frame.intermediate = undefined;
      for (const count of samples) {
        if (width * height * attachmentBytesPerPixel * (count + 1) > attachmentBudget) continue;
        target.dispose();
        target.samples = count;
        target.setSize(width, height);
        gl.setRenderTarget(target);
        if (context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE) {
          frame.usable = true;
          frame.intermediate = intermediateGradeTarget(gl, target);
          break;
        }
        gl.setRenderTarget(null);
      }
      if (!frame.usable) target.dispose();
    }
    if (frame.usable)
      gl.setRenderTarget(!manualWorld && frame.intermediate ? frame.intermediate : target);
  }, 0.99);

  useFrame(({ gl, scene, camera }) => {
    const frame = resources.current;
    if (!frame || gl.getRenderTarget() !== frame.target) {
      if (manualWorld) gl.render(scene, camera);
      return;
    }
    const autoClear = gl.autoClear;
    try {
      if (manualWorld) gl.render(scene, camera);
      // The world, sky and POV have finished. Keep the color resolve and let
      // tiled GPUs discard the multisampled depth/stencil before unbinding.
      if (frame.target.samples > 0) {
        const context = gl.getContext() as WebGL2RenderingContext;
        context.invalidateFramebuffer(context.DRAW_FRAMEBUFFER, frame.discardAttachments);
      }
      gl.setRenderTarget(null);
      // The output triangle writes every pixel, including alpha.
      gl.autoClear = false;
      const { output } = frame;
      gl.render(output.scene, output.camera);
    } finally {
      gl.autoClear = autoClear;
      gl.setRenderTarget(null);
    }
  }, 3);
  return null;
}
