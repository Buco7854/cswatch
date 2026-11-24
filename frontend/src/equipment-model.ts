import { Light, Mesh, SkinnedMesh, type Object3D, type Matrix4, type Skeleton } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Instances own node visibility and pose. Geometry, materials and images stay cache-owned. */
export function prepareEquipmentModel(scene: Object3D) {
  const result = clone(scene);
  // SkeletonUtils clones a palette per mesh even when several glTF primitives
  // use the same skin. Three uploads a bone texture per palette per render pass.
  const palettes = new Map<Matrix4[], Skeleton>();
  result.traverse((object) => {
    if (object instanceof SkinnedMesh) {
      const skin = object.skeleton;
      const shared = palettes.get(skin.boneInverses);
      if (
        shared &&
        shared.bones.length === skin.bones.length &&
        skin.bones.every((bone, index) => shared.bones[index] === bone)
      )
        object.skeleton = shared;
      else palettes.set(skin.boneInverses, skin);
    }
    if (object instanceof Light) object.visible = false;
    if (object instanceof Mesh) {
      object.castShadow = false;
      object.userData.playerShadowCaster = true;
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

/** Only the offline preparer's exact native attachment marker is accepted.
 * Keep the effect in the instance's own frame, including any authored bones. */
export function nativeMuzzleFrame(target: Matrix4, model: Object3D, marker: Object3D | undefined) {
  if (
    !marker ||
    marker.name !== 'cswatch_native_muzzle' ||
    marker.userData.cswatchNativeAttachment !== 'muzzle_flash'
  )
    return false;
  let ancestor: Object3D | null = marker,
    depth = 0;
  while (ancestor && ancestor !== model && depth++ < 256) ancestor = ancestor.parent;
  if (ancestor !== model) return false;
  model.updateWorldMatrix(true, false);
  marker.updateWorldMatrix(true, false);
  const determinant = model.matrixWorld.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return false;
  target.copy(model.matrixWorld).invert().multiply(marker.matrixWorld);
  return target.elements.every(Number.isFinite);
}
