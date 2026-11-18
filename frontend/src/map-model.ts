import {
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  Light,
  Mesh,
  Scene,
  Texture,
  type Material,
  type Object3D,
} from 'three';

type MapTextureEvidence = {
  scene: Object3D;
  parser: {
    json: {
      materials?: { pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
    };
    associations: Map<unknown, { materials?: number }>;
  };
};

/** GLTFLoader resolves missing images to null; a parsed mesh alone is not a ready map. */
export function assertMapBaseColorTextures({ scene, parser }: MapTextureEvidence): void {
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
        throw new Error('Required map base color texture failed to load');
    }
  });
}

/** World owns approximate glTF lighting; Source engine intensities use other units. */
export function cloneMapModel(scene: Object3D): Object3D {
  const copy = scene.clone(true);
  copy.traverse((object) => {
    if (object instanceof Light) {
      object.visible = false;
      object.intensity = 0;
    }
    if (object instanceof Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return copy;
}

export function prepareMapModel(scene: Object3D): { main: Group; sky: Scene | null } {
  const main = new Group(),
    copy = cloneMapModel(scene),
    roots: Object3D[] = [];
  main.rotation.y = Math.PI / 2;
  main.add(copy);
  main.updateMatrixWorld(true);
  main.traverse((object) => {
    const tag = object.userData?.cswatch;
    if (tag?.kind !== 'skybox' || tag.schemaVersion !== 1) return;
    for (let parent = object.parent; parent; parent = parent.parent)
      if (roots.includes(parent)) return;
    roots.push(object);
  });
  if (!roots.length) return { main, sky: null };
  const sky = new Scene();
  for (const root of roots) {
    const matrix = root.matrixWorld.clone();
    root.removeFromParent();
    root.matrix.copy(matrix);
    root.matrixAutoUpdate = false;
    root.traverse((object) => {
      if (object instanceof Mesh) {
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
    sky.add(root);
  }
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(-25, 40, 12);
  sky.add(new AmbientLight(0xffffff, 0.35), new HemisphereLight('#e1ecf0', '#7c694b', 0.6), sun);
  sky.updateMatrixWorld(true);
  return { main, sky };
}
