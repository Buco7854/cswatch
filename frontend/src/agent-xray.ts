import {
  GreaterDepth,
  AlwaysStencilFunc,
  NotEqualStencilFunc,
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

/** Edge alpha of an occluded body; its interior keeps this fraction of it. */
const rimOpacity = 0.65;
const fillFraction = 0.25;

/**
 * A team-coloured outline with a faint fill, drawn only where the body is
 * behind map geometry and not already visible. Alpha follows the view angle
 * so the silhouette edge stays readable while the inside lets the scene show.
 */
export function xrayMaterial({
  color = '#ffffff',
  opacity = 1,
  side,
  alphaTest = 0,
  map = null,
  alphaMap = null,
}: {
  color?: ColorRepresentation;
  opacity?: number;
  side?: Side;
  alphaTest?: number;
  map?: Texture | null;
  alphaMap?: Texture | null;
}) {
  const result = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: rimOpacity * opacity,
    depthTest: true,
    depthFunc: GreaterDepth,
    depthWrite: false,
    side,
    alphaTest,
    map,
    alphaMap,
    toneMapped: false,
    stencilWrite: true,
    stencilFunc: NotEqualStencilFunc,
    stencilRef: 1,
    stencilWriteMask: 0,
  });
  // Preserve texture alpha/cutouts while the silhouette uses one team color.
  result.onBeforeCompile = (shader) => {
    const varyings = 'varying vec3 vXrayNormal;\nvarying vec3 vXrayView;';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + varyings)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
#if ! ( defined( USE_ENVMAP ) || defined( USE_SKINNING ) )
#include <beginnormal_vertex>
#include <morphnormal_vertex>
#include <defaultnormal_vertex>
#endif
vXrayNormal = transformedNormal;
vXrayView = - mvPosition.xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + varyings)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
diffuseColor.rgb = diffuse;
float xrayFacing = abs( dot( normalize( vXrayNormal ), normalize( vXrayView ) ) );
diffuseColor.a *= mix( 1.0, ${fillFraction.toFixed(2)}, smoothstep( 0.02, 0.32, xrayFacing ) );`,
      );
  };
  result.customProgramCacheKey = () => 'cswatch-agent-xray-rim';
  return result;
}

/** An instance-owned second pass shares the posed body, never another skeleton or cached material. */
export function agentXray(root: Object3D) {
  const pairs: { source: Mesh; shell: Mesh }[] = [];
  const materials = new Map<Material, MeshBasicMaterial>();
  const masks = new Map<Material, Material>();
  const sources: Mesh[] = [];
  let installed = false,
    disposed = false,
    leases = 0,
    generation = 0;
  root.traverse((node) => {
    if (node instanceof Mesh) sources.push(node);
  });
  function material(source: Material) {
    let result = materials.get(source);
    if (result) return result;
    const masked = source as Material & { map?: Texture; alphaMap?: Texture };
    result = xrayMaterial({
      opacity: source.opacity,
      side: source.side,
      alphaTest: source.alphaTest,
      map: masked.map ?? null,
      alphaMap: masked.alphaMap ?? null,
    });
    result.visible = source.visible;
    materials.set(source, result);
    return result;
  }
  function mask(source: Material) {
    let result = masks.get(source);
    if (result) return result;
    result = source.clone();
    result.stencilWrite = false;
    result.stencilRef = 1;
    result.stencilFunc = AlwaysStencilFunc;
    result.stencilZPass = ReplaceStencilOp;
    masks.set(source, result);
    return result;
  }
  const originals = new Map<Mesh, { material: Mesh['material']; renderOrder: number }>();
  for (const source of sources) {
    if (!source.parent) continue;
    const mapped = Array.isArray(source.material)
      ? source.material.map(material)
      : material(source.material);
    originals.set(source, { material: source.material, renderOrder: source.renderOrder });
    // World opaque geometry must establish depth before visible body pixels
    // mark the stencil. Otherwise a later wall could leave a stale body mask.
    if (Array.isArray(source.material)) source.material.forEach(mask);
    else mask(source.material);
    const shell =
      source instanceof SkinnedMesh
        ? new SkinnedMesh(source.geometry, mapped)
        : new Mesh(source.geometry, mapped);
    if (source instanceof SkinnedMesh && shell instanceof SkinnedMesh) {
      shell.bindMode = source.bindMode;
      shell.bind(source.skeleton, source.bindMatrix);
    }
    shell.name = 'xray:' + source.name;
    shell.matrixAutoUpdate = false;
    shell.renderOrder = 10;
    shell.frustumCulled = source.frustumCulled;
    shell.visible = false;
    shell.castShadow = false;
    shell.receiveShadow = false;
    pairs.push({ source, shell });
  }
  const retire = () => {
    if (installed) {
      for (const { shell } of pairs) shell.removeFromParent();
      for (const [mesh, original] of originals) {
        mesh.material = original.material;
        mesh.renderOrder = original.renderOrder;
      }
      installed = false;
    }
    if (disposed) return;
    disposed = true;
    for (const value of materials.values()) value.dispose();
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
        for (const { source, shell } of pairs) {
          const original = originals.get(source)!;
          source.renderOrder = original.renderOrder;
          source.material = Array.isArray(original.material)
            ? original.material.map((value) => masks.get(value)!)
            : masks.get(original.material)!;
          source.parent?.add(shell);
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
      for (const value of materials.values()) {
        if (color !== undefined) value.color.set(color);
      }
      for (const value of masks.values()) value.stencilWrite = color !== undefined;
      for (const { source, shell } of pairs) {
        source.renderOrder = color === undefined ? originals.get(source)!.renderOrder : 5;
        shell.visible = color !== undefined && source.visible;
        if (!shell.visible) continue;
        if (source.matrixAutoUpdate) source.updateMatrix();
        shell.matrix.copy(source.matrix);
        shell.matrixWorldNeedsUpdate = true;
        shell.morphTargetInfluences = source.morphTargetInfluences;
      }
    },
    dispose() {
      generation++;
      leases = 0;
      retire();
    },
  };
}
