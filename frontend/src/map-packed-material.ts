import { Mesh, MeshStandardMaterial, ShaderChunk, type Object3D } from 'three';

const metalness = ShaderChunk.metalnessmap_fragment.replace(
  'texture2D( metalnessMap, vMetalnessMapUv )',
  'texelRoughness',
);
const occlusion = ShaderChunk.aomap_fragment.replace(
  'texture2D( aoMap, vAoMapUv )',
  'texelRoughness',
);

/** The glTF metallic-roughness image stores both channels in the same texel.
 * Reuse the stock roughness lookup for maps that share the exact Texture,
 * including its UV channel, transform and sampler. Keep Three's PBR equations.
 */
export function reusePackedMapSamples(scenes: readonly Object3D[]) {
  const seen = new Set<MeshStandardMaterial>();
  for (const scene of scenes)
    scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!(material instanceof MeshStandardMaterial) || seen.has(material)) continue;
        seen.add(material);
        const packed = material.roughnessMap;
        if (!packed || material.metalnessMap !== packed) continue;
        const sharedAo = material.aoMap === packed;
        const compile = material.onBeforeCompile;
        const key = material.customProgramCacheKey();
        material.onBeforeCompile = function (shader, renderer) {
          compile.call(this, shader, renderer);
          if (!shader.fragmentShader.includes('#include <roughnessmap_fragment>')) return;
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <metalnessmap_fragment>',
            metalness,
          );
          if (sharedAo)
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <aomap_fragment>',
              occlusion,
            );
        };
        material.customProgramCacheKey = () => key + (sharedAo ? ':packed-orm' : ':packed-mr');
      }
    });
}
