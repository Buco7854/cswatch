import {
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  NearestMipmapLinearFilter,
  Texture,
  type Object3D,
} from 'three';

/** Called on private decoder output before it enters the shared model cache.
 * Three caps the request to each renderer's supported anisotropy. */
export function improveMapTextureDetail(scenes: readonly Object3D[]) {
  const seen = new Set<object>();
  for (const scene of scenes) {
    scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (seen.has(material)) continue;
        seen.add(material);
        // Masked foliage retains the authored cutoff. Multisampled map targets
        // turn the derivative-smoothed edge into fragment coverage.
        if (material.alphaTest > 0 && !material.transparent) material.alphaToCoverage = true;
        // Keep the indirect, normal and other auxiliary maps at their authored
        // sampling cost. The visible color is the texture most affected at grazing angles.
        const value = 'map' in material ? material.map : undefined;
        if (
          value instanceof Texture &&
          value.magFilter !== NearestFilter &&
          (value.minFilter === LinearMipmapLinearFilter ||
            value.minFilter === NearestMipmapLinearFilter) &&
          (value.generateMipmaps || value.mipmaps.length > 1)
        )
          value.anisotropy = Math.max(value.anisotropy, 4);
      }
    });
  }
}
