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
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { NativeRenderer } from './renderer';
import { viewerToSource } from './space';
import { actorLighting } from './actor-lighting';
import type { SmokeLighting } from '../smoke-volume';

export interface FramePasses {
  sun?: import('three').DirectionalLight;
  smoke?: (framebuffer: WebGLFramebuffer, lighting: SmokeLighting) => void;
  equipment?: (render: (scene: Scene, camera: PerspectiveCamera) => void) => void;
}

// Tactical views hide the sky; a neutral dark grey (display-referred, independent of the theme)
// fills the space around the map instead of the sky cube's lower hemisphere.
const tacticalBackground = [0.003, 0.003, 0.003] as const;

type LinkedProgram = { usedTimes: number };
const retainedPrograms = new WeakMap<WebGLRenderer, Set<LinkedProgram>>();

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
  const [sx, sy, sz] = lighting.sun.direction,
    [sr, sg, sb] = lighting.sun.color;
  const smokeLighting: SmokeLighting = {
    probes: lighting.uniforms,
    sunDirection: new Vector3(sx, sz, -sy).normalize(),
    sunColor: new Color(sr, sg, sb),
  };
  const sourceEye = new Vector3();
  const originals: Color[] = [];
  // Link the programs of newly mounted meshes in the composed pass state, even
  // while they are culled, so a player or weapon entering view mid-playback
  // reuses a program instead of compiling and linking it inside that frame.
  const prepared = new WeakSet<Material>();
  const retained = retainedPrograms.get(renderer) ?? new Set<LinkedProgram>();
  retainedPrograms.set(renderer, retained);
  const fresh: Object3D[] = [];
  const freshScene = {
    traverse: (visit: (object: Object3D) => void) => fresh.forEach(visit),
    traverseVisible: () => {},
  } as unknown as Object3D;
  // X-ray shells are display overlays and keep their unlit shader.
  const xray = (material: Material) => material.depthFunc === GreaterDepth && 'color' in material;
  const custom = (material: Material) =>
    Boolean((material as Material & { isShaderMaterial?: boolean }).isShaderMaterial);
  function prepare(scene: Scene, camera: PerspectiveCamera) {
    scene.traverse((object) => {
      const material = (object as Mesh).material;
      if (!material) return;
      let added = false;
      for (const entry of Array.isArray(material) ? material : [material]) {
        // Custom shader effects warm their own programs in the state they draw in.
        if (prepared.has(entry) || custom(entry)) continue;
        prepared.add(entry);
        if (!xray(entry)) lighting.bind(entry);
        added = true;
      }
      if (added) fresh.push(object);
    });
    if (!fresh.length) return;
    try {
      renderer.compile(freshScene, camera, scene);
      // Keep each linked built-in material variant for the renderer's lifetime
      // (a bounded set). A corpse's instance-owned materials are disposed at the
      // round's end; without this lease the next round's first death would link
      // the same program again mid-playback. (Custom shader programs are keyed by
      // shader-cache entries that are renumbered once released.)
      for (const object of fresh) {
        const material = (object as Mesh).material;
        for (const entry of Array.isArray(material) ? material : [material]) {
          if (custom(entry)) continue;
          const program = (renderer.properties.get(entry) as { currentProgram?: LinkedProgram })
            .currentProgram;
          if (program && !retained.has(program)) {
            retained.add(program);
            program.usedTimes++;
          }
        }
      }
    } finally {
      fresh.length = 0;
    }
  }
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
    const scaled: Color[] = [];
    // Nothing moves between the opaque and transparent passes, so the scene
    // graph's world matrices are updated once per frame.
    let placed = false;
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
          } else if (xray(entry)) {
            // X-ray shells are display overlays: undo the grade's fixed scale for their tint.
            const color = (entry as Material & { color: Color }).color;
            (originals[scaled.length] ??= new Color()).copy(color);
            scaled.push(color);
            color.multiplyScalar(native.displayScale);
          } else lighting.bind(entry);
        }
      });
      const autoUpdate = scene.matrixWorldAutoUpdate;
      if (placed) scene.matrixWorldAutoUpdate = false;
      try {
        renderer.render(scene, camera);
      } finally {
        scene.matrixWorldAutoUpdate = autoUpdate;
        placed = true;
        for (const entry of hidden) entry.visible = true;
        scaled.forEach((color, index) => color.copy(originals[index]));
        hidden.length = 0;
        scaled.length = 0;
      }
    }
    try {
      renderer.toneMapping = NoToneMapping;
      scene.background = null;
      bindTarget();
      prepare(scene, camera);
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
            passes.smoke?.(framebuffer, smokeLighting);
            objects(true);
          },
          equipment: () =>
            passes.equipment?.((equipment, eye) => {
              bindTarget();
              prepare(equipment, eye);
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
