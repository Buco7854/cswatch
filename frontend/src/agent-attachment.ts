import { Bone, Matrix4, type Object3D } from 'three';
const sourceWeaponToViewer = new Matrix4().makeRotationX(Math.PI / 2);
/** The genuine wpn frame is Source X-forward/Z-up. Equipment is already viewer Y-up.
 * Read a cloned bone without parenting equipment into the owned skinned hierarchy. */
export function nativeWeaponFrame(target: Matrix4, parent: Object3D, bone: Object3D | null) {
  if (!(bone instanceof Bone)) return false;
  let ancestor: Object3D | null = bone,
    depth = 0;
  while (ancestor && ancestor !== parent && depth++ < 256) ancestor = ancestor.parent;
  if (ancestor !== parent) return false;
  parent.updateWorldMatrix(true, false);
  bone.updateWorldMatrix(true, false);
  if (
    !Number.isFinite(parent.matrixWorld.determinant()) ||
    Math.abs(parent.matrixWorld.determinant()) < 1e-12
  )
    return false;
  target
    .copy(parent.matrixWorld)
    .invert()
    .multiply(bone.matrixWorld)
    .multiply(sourceWeaponToViewer);
  return target.elements.every(Number.isFinite);
}
