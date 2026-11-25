import {
  GreaterDepth,
  AlwaysStencilFunc,
  EqualStencilFunc,
  ReplaceStencilOp,
  Mesh,
  MeshBasicMaterial,
  SkinnedMesh,
  type ColorRepresentation,
  type Material,
  type Side,
  type Object3D,
  type Texture,
} from 'three';

/**
 * Stencil bits shared by every actor in a frame. Visible body pixels set bit
 * 1 (the body's own material), occluded body pixels set bit 2 (an invisible
 * pass), and the outline only draws where neither bit is set: a thin ring
 * around the hidden part of a body, never a fill over it.
 */
const visibleBit = 1;
const hiddenBit = 2;
/** Outline width in CSS pixels at any distance. */
const outlinePixels = 2;
const outlineViewport = { value: 900 };

/** The compositor's CSS height; keeps outlines the same on-screen width. */
export function setXrayViewportHeight(height: number) {
  if (height > 0) outlineViewport.value = height;
}

type XrayTextures = {
  side?: Side;
  alphaTest?: number;
  map?: Texture | null;
  alphaMap?: Texture | null;
};

const normalVaryings = `#if ! ( defined( USE_ENVMAP ) || defined( USE_SKINNING ) )
#include <beginnormal_vertex>
#include <morphnormal_vertex>
#include <defaultnormal_vertex>
#endif`;

/** An invisible pass marking body pixels that are behind map geometry. */
export function xrayHiddenMaterial({
  side,
  alphaTest = 0,
  map = null,
  alphaMap = null,
}: XrayTextures) {
  const result = new MeshBasicMaterial({
    transparent: true,
    colorWrite: false,
    depthTest: true,
    depthFunc: GreaterDepth,
    depthWrite: false,
    side,
    alphaTest,
    map,
    alphaMap,
    stencilWrite: true,
    stencilFunc: EqualStencilFunc,
    stencilRef: hiddenBit,
    stencilFuncMask: visibleBit,
    stencilWriteMask: hiddenBit,
    stencilZPass: ReplaceStencilOp,
  });
  return result;
}

/** A team-coloured hull pushed out along the normals, drawn only around hidden pixels. */
export function xrayOutlineMaterial({
  color = '#ffffff',
  opacity = 1,
  side,
  alphaTest = 0,
  map = null,
  alphaMap = null,
}: XrayTextures & { color?: ColorRepresentation; opacity?: number }) {
  const result = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95 * opacity,
    depthTest: true,
    depthFunc: GreaterDepth,
    depthWrite: false,
    side,
    alphaTest,
    map,
    alphaMap,
    toneMapped: false,
    stencilWrite: true,
    stencilFunc: EqualStencilFunc,
    stencilRef: 0,
    stencilFuncMask: visibleBit | hiddenBit,
    stencilWriteMask: 0,
  });
  result.onBeforeCompile = (shader) => {
    shader.uniforms.xrayViewportHeight = outlineViewport;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float xrayViewportHeight;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
${normalVaryings}
float xrayDepth = isOrthographic ? 1.0 : - mvPosition.z;
mvPosition.xyz += normalize( transformedNormal ) *
  ( ${outlinePixels.toFixed(1)} * 2.0 * xrayDepth / ( xrayViewportHeight * projectionMatrix[ 1 ][ 1 ] ) );
gl_Position = projectionMatrix * mvPosition;`,
      );
    // Texture alpha keeps cutouts; the outline itself is one team colour.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\ndiffuseColor.rgb = diffuse;',
    );
  };
  result.customProgramCacheKey = () => 'cswatch-agent-xray-outline';
  return result;
}

/** An instance-owned second pass shares the posed body, never another skeleton or cached material. */
export function agentXray(root: Object3D) {
  const pairs: { source: Mesh; shells: Mesh[] }[] = [];
  const hidden = new Map<Material, MeshBasicMaterial>();
  const outlines = new Map<Material, MeshBasicMaterial>();
  const masks = new Map<Material, Material>();
  const sources: Mesh[] = [];
  let installed = false,
    disposed = false,
    leases = 0,
    generation = 0;
  root.traverse((node) => {
    if (node instanceof Mesh) sources.push(node);
  });
  function textures(source: Material): XrayTextures {
    const masked = source as Material & { map?: Texture; alphaMap?: Texture };
    return {
      side: source.side,
      alphaTest: source.alphaTest,
      map: masked.map ?? null,
      alphaMap: masked.alphaMap ?? null,
    };
  }
  function hiddenFor(source: Material) {
    let result = hidden.get(source);
    if (!result) {
      result = xrayHiddenMaterial(textures(source));
      result.visible = source.visible;
      hidden.set(source, result);
    }
    return result;
  }
  function outlineFor(source: Material) {
    let result = outlines.get(source);
    if (!result) {
      result = xrayOutlineMaterial({ ...textures(source), opacity: source.opacity });
      result.visible = source.visible;
      outlines.set(source, result);
    }
    return result;
  }
  function mask(source: Material) {
    let result = masks.get(source);
    if (result) return result;
    result = source.clone();
    // Material.copy omits shader patches (packed ORM samples, actor lighting).
    // The mask must draw exactly like its source and share its program.
    result.onBeforeCompile = source.onBeforeCompile;
    result.customProgramCacheKey = source.customProgramCacheKey;
    result.stencilWrite = false;
    result.stencilRef = visibleBit;
    result.stencilFunc = AlwaysStencilFunc;
    result.stencilZPass = ReplaceStencilOp;
    masks.set(source, result);
    return result;
  }
  const originals = new Map<Mesh, { material: Mesh['material']; renderOrder: number }>();
  for (const source of sources) {
    if (!source.parent) continue;
    originals.set(source, { material: source.material, renderOrder: source.renderOrder });
    // World opaque geometry must establish depth before visible body pixels
    // mark the stencil. Otherwise a later wall could leave a stale body mask.
    if (Array.isArray(source.material)) source.material.forEach(mask);
    else mask(source.material);
    const shells = [hiddenFor, outlineFor].map((pick, index) => {
      const mapped = Array.isArray(source.material)
        ? source.material.map(pick)
        : pick(source.material);
      const shell =
        source instanceof SkinnedMesh
          ? new SkinnedMesh(source.geometry, mapped)
          : new Mesh(source.geometry, mapped);
      if (source instanceof SkinnedMesh && shell instanceof SkinnedMesh) {
        shell.bindMode = source.bindMode;
        shell.bind(source.skeleton, source.bindMatrix);
      }
      shell.name = (index ? 'xray-outline:' : 'xray-hidden:') + source.name;
      shell.matrixAutoUpdate = false;
      // Every hidden mask is drawn before any outline in the transparent list.
      shell.renderOrder = 10 + index;
      shell.frustumCulled = source.frustumCulled;
      shell.visible = false;
      shell.castShadow = false;
      shell.receiveShadow = false;
      return shell;
    });
    pairs.push({ source, shells });
  }
  const retire = () => {
    if (installed) {
      for (const { shells } of pairs) for (const shell of shells) shell.removeFromParent();
      for (const [mesh, original] of originals) {
        mesh.material = original.material;
        mesh.renderOrder = original.renderOrder;
      }
      installed = false;
    }
    if (disposed) return;
    disposed = true;
    for (const value of hidden.values()) value.dispose();
    for (const value of outlines.values()) value.dispose();
    for (const value of masks.values()) value.dispose();
  };
  return {
    /** Construction never mutates a prepared instance during React render.
     * Each committed lifetime owns installation, including StrictMode's
     * cleanup/re-setup on the same memoized instance. */
    acquire() {
      if (leases++ === 0) {
        disposed = false;
        installed = true;
        for (const { source, shells } of pairs) {
          const original = originals.get(source)!;
          source.renderOrder = original.renderOrder;
          source.material = Array.isArray(original.material)
            ? original.material.map((value) => masks.get(value)!)
            : masks.get(original.material)!;
          source.parent?.add(...shells);
        }
      }
      const owner = generation;
      let released = false;
      return () => {
        if (released || generation !== owner) return;
        released = true;
        if (--leases === 0) retire();
      };
    },
    sample(color?: ColorRepresentation) {
      if (!installed) return;
      if (color !== undefined) for (const value of outlines.values()) value.color.set(color);
      for (const value of masks.values()) value.stencilWrite = color !== undefined;
      for (const { source, shells } of pairs) {
        source.renderOrder = color === undefined ? originals.get(source)!.renderOrder : 5;
        const visible = color !== undefined && source.visible;
        if (visible && source.matrixAutoUpdate) source.updateMatrix();
        for (const shell of shells) {
          shell.visible = visible;
          if (!visible) continue;
          shell.matrix.copy(source.matrix);
          shell.matrixWorldNeedsUpdate = true;
          shell.morphTargetInfluences = source.morphTargetInfluences;
        }
      }
    },
    dispose() {
      generation++;
      leases = 0;
      retire();
    },
  };
}
