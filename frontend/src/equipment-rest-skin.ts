import { AttachedBindMode, Matrix4, Mesh, SkinnedMesh, type Object3D } from 'three';

// The world model follows its recorded parent transform. Only the optional
// independent off hand moves inside it (dual pistols or a grenade lighter).
// First-person rigs and player bodies have their own animated loading path.
export function retainEquipmentRestGeometry(scene: Object3D) {
  const moving = new Set<Object3D>();
  scene.getObjectByName('weapon_hand_l')?.traverse((node) => moving.add(node));
  const identity = new Matrix4().elements;
  const current = new Matrix4();
  scene.updateMatrixWorld(true);

  function atRest(mesh: SkinnedMesh) {
    const geometry = mesh.geometry;
    if (
      mesh.bindMode !== AttachedBindMode ||
      moving.has(mesh) ||
      mesh.children.length ||
      Object.keys(geometry.morphAttributes).length
    )
      return false;
    const position = geometry.getAttribute('position');
    const weights = geometry.getAttribute('skinWeight');
    const joints = geometry.getAttribute('skinIndex');
    const box = geometry.boundingBox;
    if (
      !box ||
      !position ||
      !weights ||
      !joints ||
      weights.itemSize !== 4 ||
      joints.itemSize !== 4 ||
      weights.count !== position.count ||
      joints.count !== position.count
    )
      return false;
    const reach = Math.max(
      1,
      ...box.min.toArray().map(Math.abs),
      ...box.max.toArray().map(Math.abs),
    );
    if (!Number.isFinite(reach)) return false;
    const eligible = mesh.skeleton.bones.map((bone, index) => {
      if (moving.has(bone)) return false;
      current
        .copy(mesh.bindMatrixInverse)
        .multiply(bone.matrixWorld)
        .multiply(mesh.skeleton.boneInverses[index])
        .multiply(mesh.bindMatrix);
      // A rigid export can retain floating point round-off in its inverse bind.
      // Bound each weighted joint's local displacement to ten micrometres and
      // its normal deviation to one millionth before dropping skinning.
      for (let row = 0; row < 3; row++) {
        let linear = 0;
        for (let i = row; i <= row + 8; i += 4)
          linear += Math.abs(current.elements[i] - identity[i]);
        if (!(linear <= 1e-6 && linear * reach + Math.abs(current.elements[12 + row]) <= 9e-6))
          return false;
      }
      return true;
    });
    for (let i = 0; i < weights.count; i++) {
      let sum = 0;
      for (let channel = 0; channel < 4; channel++) {
        const weight = weights.getComponent(i, channel);
        if (weight === 0) continue;
        if (!(weight > 0) || !eligible[joints.getComponent(i, channel)]) return false;
        sum += weight;
      }
      if (!(Math.abs(sum - 1) * reach <= 1e-7)) return false;
    }
    return true;
  }

  scene.traverse((parent) => {
    parent.children.forEach((node, index) => {
      if (!(node instanceof SkinnedMesh) || !atRest(node)) return;
      // At load time preserve the glTF node order, material and geometry. All
      // attachment bones remain in place for grip placement and muzzle effects.
      const mesh = new Mesh(node.geometry, node.material).copy(node, false);
      mesh.parent = parent;
      parent.children[index] = mesh;
      node.parent = null;
    });
  });
}
