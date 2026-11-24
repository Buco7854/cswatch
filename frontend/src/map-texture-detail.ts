import {
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  NearestMipmapLinearFilter,
  Texture,
  type Object3D,
} from 'three';

/** Configure the prepared world before its first upload. Three caps anisotropy
 * to the device limit. Compact worlds carry vertex colors. */
export function improveMapTextureDetail(scenes: readonly Object3D[], tier: string | undefined) {
  if (tier !== 'desktop' && tier !== 'mobile') return;
  const seen = new Set<object>();
  const colors = new Set<Texture>();
  const alphaSources = new Set<Texture['source']>();
  for (const scene of scenes) {
    scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (seen.has(material)) continue;
        seen.add(material);
        // Multisampled desktop targets use the authored mask as edge coverage.
        if (tier === 'desktop' && material.alphaTest > 0 && !material.transparent)
          material.alphaToCoverage = true;
        const color = 'map' in material ? material.map : undefined;
        if (!(color instanceof Texture)) continue;
        if (tier === 'mobile' && (material.alphaTest > 0 || material.transparent)) {
          // GLTFLoader can clone a sampler while sharing its underlying image.
          // Keep cutout/transparent imagery at its original cost and coverage.
          alphaSources.add(color.source);
        } else colors.add(color);
      }
    });
  }
  for (const color of colors) {
    if (
      !alphaSources.has(color.source) &&
      color.magFilter !== NearestFilter &&
      (color.minFilter === LinearMipmapLinearFilter ||
        color.minFilter === NearestMipmapLinearFilter) &&
      (color.generateMipmaps || color.mipmaps.length > 1)
    )
      color.anisotropy = Math.max(color.anisotropy, tier === 'desktop' ? 4 : 2);
  }
}
