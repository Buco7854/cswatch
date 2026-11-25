import { Mesh, Texture, type Material, type Object3D } from 'three';

type TextureEvidence = {
  scene: Object3D;
  parser: {
    json: {
      materials?: { pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
    };
    associations: Map<unknown, { materials?: number }>;
  };
};

/** GLTFLoader resolves missing images to null; a parsed mesh alone is not a ready map. */
export function assertBaseColorTextures({ scene, parser }: TextureEvidence): void {
  const definitions = parser.json.materials || [];
  const checked = new Set<Material>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (checked.has(material)) continue;
      checked.add(material);
      const index = parser.associations.get(material)?.materials;
      if (
        index === undefined ||
        definitions[index]?.pbrMetallicRoughness?.baseColorTexture === undefined
      )
        continue;
      const texture = (material as Material & { map?: Texture | null }).map;
      const image = texture?.image as { width?: number; height?: number } | undefined;
      if (!(texture instanceof Texture) || !image || !(image.width! > 0) || !(image.height! > 0))
        throw new Error('Required base color texture failed to load');
    }
  });
}
