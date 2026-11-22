import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { HalfFloatType, LinearFilter, Vector2, WebGLRenderTarget } from 'three';
import { mapGradeFile } from '../../../shared/map-grade.mjs';
import type { MapGrade } from '../../../shared/map-grade.mjs';
import { createGradeOutput, loadGradeLut, mapGradeLighting, mapGradeTargets } from '../map-grade';

export default function SceneGrade({
  grade,
  firstFace,
  manualWorld,
}: {
  grade: MapGrade;
  firstFace: string;
  manualWorld: boolean;
}) {
  const gl = useThree((state) => state.gl);
  const context = gl.getContext() as WebGL2RenderingContext;
  const url = firstFace.slice(0, -'px.png'.length) + mapGradeFile;
  const [loaded, setLoaded] = useState<{ grade: MapGrade; url: string; bytes: Uint8Array }>();
  useEffect(() => {
    if (
      !globalThis.crypto?.subtle ||
      (!gl.extensions.has('EXT_color_buffer_float') &&
        !gl.extensions.has('EXT_color_buffer_half_float')) ||
      context.getParameter(context.MAX_3D_TEXTURE_SIZE) < grade.lut.size
    )
      return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    loadGradeLut(url, grade, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setLoaded({ grade, url, bytes });
      })
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [context, gl, grade, url]);
  return loaded?.grade === grade && loaded.url === url ? (
    <GradeFrames grade={grade} bytes={loaded.bytes} manualWorld={manualWorld} />
  ) : null;
}

function GradeFrames({
  grade,
  bytes,
  manualWorld,
}: {
  grade: MapGrade;
  bytes: Uint8Array;
  manualWorld: boolean;
}) {
  const resources = useRef<{
    output: ReturnType<typeof createGradeOutput>;
    target: WebGLRenderTarget;
    size: Vector2;
    usable: boolean;
    checked: boolean;
    samples: number[];
    maxEdge: number;
  }>(null);
  const { gl, invalidate } = useThree();
  useLayoutEffect(() => {
    const output = createGradeOutput(grade, bytes);
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      stencilBuffer: true,
    });
    mapGradeTargets.add(target);
    if (grade.lighting) mapGradeLighting.set(target, grade.lighting);
    const context = gl.getContext() as WebGL2RenderingContext;
    const available = (format: number): number[] =>
      Array.from(context.getInternalformatParameter(context.RENDERBUFFER, format, context.SAMPLES));
    const depthSamples = available(context.DEPTH24_STENCIL8);
    const maxSamples = Math.min(4, context.getParameter(context.MAX_SAMPLES));
    const antialias = context.getContextAttributes()?.antialias === true;
    const samples = antialias
      ? available(context.RGBA16F).filter(
          (count) => count <= maxSamples && depthSamples.includes(count),
        )
      : [0];
    output.material.uniforms.sceneColor.value = target.texture;
    resources.current = {
      output,
      target,
      size: new Vector2(),
      usable: false,
      checked: false,
      samples,
      maxEdge: Math.min(
        gl.capabilities.maxTextureSize,
        context.getParameter(context.MAX_RENDERBUFFER_SIZE),
      ),
    };
    invalidate();
    return () => {
      resources.current = null;
      if (gl.getRenderTarget() === target) gl.setRenderTarget(null);
      output.dispose();
      target.dispose();
    };
  }, [grade, bytes, gl, invalidate]);

  useFrame(({ gl }) => {
    const frame = resources.current;
    if (!frame || gl.getRenderTarget()) return;
    const { target, size } = frame;
    gl.getDrawingBufferSize(size);
    // Grade at the exact viewer drawing-buffer size. If the device cannot
    // fit multisampled HDR at this resolution, keep the native canvas path.
    const context = gl.getContext() as WebGL2RenderingContext;
    const width = Math.max(1, size.x),
      height = Math.max(1, size.y);
    const budget = 384 * 1024 ** 2;
    const samples = frame.samples.find((count) => width * height * 12 * (count + 1) <= budget);
    if (Math.max(width, height) > frame.maxEdge || samples === undefined) {
      if (frame.checked) {
        target.dispose();
        frame.checked = frame.usable = false;
      }
      return;
    }
    if (
      !frame.checked ||
      target.width !== width ||
      target.height !== height ||
      target.samples !== samples
    ) {
      frame.checked = true;
      if (target.samples !== samples) target.dispose();
      target.samples = samples;
      target.setSize(width, height);
      gl.setRenderTarget(target);
      frame.usable =
        context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
      if (!frame.usable) {
        gl.setRenderTarget(null);
        target.dispose();
      }
    } else if (frame.usable) gl.setRenderTarget(target);
    // Three writes ordinary render targets in scene-linear space. The
    // fullscreen material also opts out of Three's display tone mapping.
  }, 0.99);

  useFrame(({ gl, scene, camera }) => {
    const frame = resources.current;
    if (!frame || gl.getRenderTarget() !== frame.target) {
      if (manualWorld) gl.render(scene, camera);
      return;
    }
    try {
      if (manualWorld) gl.render(scene, camera);
      gl.setRenderTarget(null);
      gl.render(frame.output.scene, frame.output.camera);
    } finally {
      gl.setRenderTarget(null);
    }
  }, 3);
  return null;
}
