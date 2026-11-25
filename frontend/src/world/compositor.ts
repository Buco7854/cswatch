import {
  Color,
  DepthStencilFormat,
  GreaterDepth,
  DepthTexture,
  HalfFloatType,
  UnsignedInt248Type,
  NoToneMapping,
  PerspectiveCamera,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type Mesh,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { NativeRenderer } from './renderer';
import { viewerToSource } from './space';
import { actorLighting } from './actor-lighting';

export interface FramePasses {
  sun?: import('three').DirectionalLight;
  smoke?: (framebuffer: WebGLFramebuffer) => void;
  equipment?: (render: (scene: Scene, camera: PerspectiveCamera) => void) => void;
}

// Tactical views hide the sky; a neutral dark grey (display-referred, independent of the theme)
// fills the space around the map instead of the sky cube's lower hemisphere.
const tacticalBackground = [0.003, 0.003, 0.003] as const;

export function compositor(renderer: WebGLRenderer, native: NativeRenderer) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  // Actor x-ray shells test the stencil mask written by their own bodies.
  const depth = new DepthTexture(1, 1, UnsignedInt248Type);
  depth.format = DepthStencilFormat;
  const hdr = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    depthTexture: depth,
    stencilBuffer: true,
    samples: 0,
  });
  const lighting = actorLighting(renderer, native);
  const sourceEye = new Vector3();
  function frame(
    scene: Scene,
    camera: PerspectiveCamera,
    tactical: boolean,
    passes: FramePasses,
    shadow?: { texture: WebGLTexture; projection: Float32Array; bias: number },
    nearFade = 0,
  ) {
    hdr.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
    const previousTarget = renderer.getRenderTarget(),
      autoClear = renderer.autoClear,
      toneMapping = renderer.toneMapping;
    const background = scene.background;
    function bindTarget() {
      renderer.resetState();
      renderer.setRenderTarget(hdr);
      renderer.autoClear = false;
    }
    const hidden: Material[] = [];
    const scaled: [Color, Color][] = [];
    function objects(transparent: boolean) {
      bindTarget();
      scene.traverseVisible((object) => {
        const material = (object as Mesh).material;
        if (!material) return;
        for (const entry of Array.isArray(material) ? material : [material]) {
          if (!entry.visible) continue;
          if (entry.transparent !== transparent) {
            entry.visible = false;
            hidden.push(entry);
          } else if (entry.depthFunc === GreaterDepth && 'color' in entry) {
            // X-ray shells are display overlays: undo the grade's fixed scale for their tint.
            const color = (entry as Material & { color: Color }).color;
            scaled.push([color, color.clone()]);
            color.multiplyScalar(native.displayScale);
          } else lighting.bind(entry);
        }
      });
      try {
        renderer.render(scene, camera);
      } finally {
        for (const entry of hidden) entry.visible = true;
        for (const [color, original] of scaled) color.copy(original);
        hidden.length = 0;
        scaled.length = 0;
      }
    }
    try {
      renderer.toneMapping = NoToneMapping;
      scene.background = null;
      bindTarget();
      const framebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer;
      const texture = (renderer.properties.get(hdr.texture) as { __webglTexture: WebGLTexture })
        .__webglTexture;
      const pos = sourceEye
        .setFromMatrixPosition(camera.matrixWorld)
        .applyMatrix4(viewerToSource)
        .toArray();
      return native.render({ pos, ang: [0, 0], fov: camera.fov }, 0, {
        skybox3D: !tactical,
        fog: !tactical,
        background: tactical ? tacticalBackground : undefined,
        nearFade,
        shadow,
        composed: {
          camera,
          framebuffer,
          hdr: texture,
          opaque: () => objects(false),
          transparent: () => {
            bindTarget();
            passes.smoke?.(framebuffer);
            objects(true);
          },
          equipment: () =>
            passes.equipment?.((equipment, eye) => {
              bindTarget();
              renderer.clearDepth();
              equipment.traverseVisible((object) => {
                const material = (object as Mesh).material;
                if (material)
                  for (const entry of Array.isArray(material) ? material : [material])
                    lighting.bind(entry);
              });
              renderer.render(equipment, eye);
            }),
        },
      });
    } finally {
      scene.background = background;
      renderer.resetState();
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = autoClear;
      renderer.toneMapping = toneMapping;
    }
  }
  return {
    frame,
    dispose() {
      hdr.dispose();
      lighting.dispose();
    },
  };
}
