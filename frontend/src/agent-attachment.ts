import { Bone, Matrix4, Vector3, type Object3D } from 'three';
const viewerToSourceWeapon = new Matrix4().makeRotationX(Math.PI / 2);
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
    .multiply(viewerToSourceWeapon);
  return target.elements.every(Number.isFinite);
}

export type WeaponAnchor = {
  weapon: Bone;
  right: readonly [Object3D, Object3D] | undefined;
  left: readonly [Object3D, Object3D] | undefined;
};

/** The two knuckles bound the handle in the authored hand pose. */
export function weaponAnchor(root: Object3D): WeaponAnchor | undefined {
  const weapon = root.getObjectByName('wpn');
  if (!(weapon instanceof Bone)) return;
  const palm = (side: 'R' | 'L') => {
    const thumb = root.getObjectByName('finger_thumb_1_' + side);
    const middle = root.getObjectByName('finger_middle_0_' + side);
    if (thumb instanceof Bone && middle instanceof Bone) return [thumb, middle] as const;
  };
  return { weapon, right: palm('R'), left: palm('L') };
}

/** Keep the clip's authored weapon axes. Bring the model's own grip into
 * contact with the sampled hand, including after upper-body blending. */
export function fitWeaponGrip(
  frame: Matrix4,
  grip: Object3D,
  model: Object3D,
  parent: Object3D,
  palm: NonNullable<WeaponAnchor['right']>,
  scratch: [Vector3, Vector3, Vector3, Matrix4],
) {
  const [center, middle, offset, inverse] = scratch;
  grip.getWorldPosition(offset);
  model.worldToLocal(offset);
  parent.worldToLocal(palm[0].getWorldPosition(center).lerp(palm[1].getWorldPosition(middle), 0.5));
  inverse.copy(frame).setPosition(0, 0, 0);
  center.sub(offset.applyMatrix4(inverse));
  frame.setPosition(center);
}
