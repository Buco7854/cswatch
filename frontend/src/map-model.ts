import {
  Group,
  Light,
  Mesh,
  Scene,
  Texture,
  type AnimationClip,
  type Material,
  type Object3D,
} from 'three';
import { preparedWater } from './source-water-material';
import { preparedGlass } from './source-glass-material';
import { StaticMapGroup } from './static-map-group';
import { readSourceSun, type SourceSun } from './source-sun';

type MapModelResult = {
  main: Group;
  sky: Scene | null;
  sun: SourceSun | null;
};

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
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      object.castShadow = materials.some(
        (material: Material) =>
          preparedGlass(material)?.castsShadow !== false && !preparedWater(material),
      );
      object.receiveShadow = true;
    }
  });
  return copy;
}

export function prepareMapModel(
  scene: Object3D,
  clips: readonly AnimationClip[] = [],
): MapModelResult {
  const main = new StaticMapGroup(),
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
  if (!roots.length) {
    main.seal(clips);
    return { main, sky: null, sun: readSourceSun(main) };
  }
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
  sky.updateMatrixWorld(true);
  main.seal(clips);
  // The main world's stationary shadow atlas was compiled for its own sun.
  // Decorative sky prefabs can carry a separately oriented light.
  return { main, sky, sun: readSourceSun(main) };
}
