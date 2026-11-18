import { Light, Mesh, SkinnedMesh, type Object3D } from 'three';
import type { EquipmentModelTransform } from '../../shared/equipment-models';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Instances own node visibility and pose. Geometry, materials and images stay cache-owned. */
export function prepareEquipmentModel(scene: Object3D) {
  const result = clone(scene);
  result.traverse((object) => {
    if (object instanceof Light) object.visible = false;
    if (object instanceof Mesh) {
      object.castShadow = false;
      object.receiveShadow = true;
    }
  });
  return result;
}

/** SkeletonUtils creates instance-owned skeletons; their bone textures are never cache-owned. */
export function disposeEquipmentInstance(scene: Object3D) {
  const skeletons = new Set<SkinnedMesh['skeleton']>();
  scene.traverse((object) => {
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
}

/** Static spectator placement adapts to portrait horizontal FOV without scaling game geometry. */
export function fitPovAttachment(
  preset: EquipmentModelTransform,
  aspect: number,
): EquipmentModelTransform {
  const lateral = Math.min(1, Math.max(0.1, Number.isFinite(aspect) ? aspect : 1.6) / 1.6);
  return {
    ...preset,
    position: [preset.position[0], preset.position[1], preset.position[2] * lateral],
  };
}
