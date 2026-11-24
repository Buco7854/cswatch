// Verify the complete bind transform. A named one-bone
// mesh can still have an animated offset, incompatible weights, or a different pivot.
const identity = (matrix, tolerance = 0.00001) =>
  matrix.every((value, i) => Math.abs(value - (i % 5 === 0 ? 1 : 0)) <= tolerance);

function inversePair(a, b) {
  return identity(
    Array.from({ length: 16 }, (_, i) => {
      const row = i % 4,
        col = i - row;
      return (
        a[row] * b[col] +
        a[4 + row] * b[col + 1] +
        a[8 + row] * b[col + 2] +
        a[12 + row] * b[col + 3]
      );
    }),
  );
}

export function rigidMapMesh(document, node, animated, cachedMeshes) {
  const mesh = node.getMesh();
  const skin = node.getSkin();
  if (!mesh || mesh.listPrimitives().some((p) => p.listTargets().length)) return;
  if (!skin) return mesh;
  const [joint, second] = skin.listJoints();
  if (!joint || second || !identity(node.getWorldMatrix()) || node.getParentNode()) return;
  const inverse = skin.getInverseBindMatrices();
  if (
    !inverse ||
    inverse.getCount() !== 1 ||
    !inversePair(joint.getMatrix(), inverse.getElement(0, []))
  )
    return;
  for (let ancestor = joint; ancestor; ancestor = ancestor.getParentNode())
    if (animated.has(ancestor)) return;
  if (animated.has(node)) return;
  if (cachedMeshes.has(mesh)) return cachedMeshes.get(mesh);
  const primitives = mesh.listPrimitives();
  let vertices = 0;
  for (const p of primitives) {
    const joints = p.getAttribute('JOINTS_0'),
      weights = p.getAttribute('WEIGHTS_0');
    const count = p.getAttribute('POSITION')?.getCount() ?? 0;
    vertices += count;
    if (
      !count ||
      vertices > 100000 ||
      joints?.getType() !== 'VEC4' ||
      weights?.getType() !== 'VEC4' ||
      joints.getCount() !== count ||
      weights.getCount() !== count ||
      p.listSemantics().some((s) => /^(JOINTS|WEIGHTS)_[1-9]/.test(s))
    )
      return;
    const w = [];
    for (let i = 0; i < count; i++) {
      weights.getElement(i, w);
      if (w[0] !== 1 || w[1] !== 0 || w[2] !== 0 || w[3] !== 0) return;
    }
    if (joints.getArray().some((v) => v !== 0)) return;
  }
  // Keep shared source primitives, UVs, material bindings and other users of this mesh intact.
  const rigid = document.createMesh(mesh.getName()).setExtras(mesh.getExtras());
  for (const p of primitives)
    rigid.addPrimitive(p.clone().setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null));
  cachedMeshes.set(mesh, rigid);
  return rigid;
}

export function useRigidMapMesh(document, node, matrix, animated, cachedMeshes) {
  for (let ancestor = node; ancestor; ancestor = ancestor.getParentNode())
    if (animated.has(ancestor)) return false;
  const mesh = rigidMapMesh(document, node, animated, cachedMeshes);
  if (!mesh) return false;
  if (node.getSkin()) node.setMatrix(matrix).setSkin(null).setMesh(mesh);
  return true;
}
export function preparePlacedDoor(document, node, tag, matrix, animated, cachedMeshes) {
  if (!useRigidMapMesh(document, node, matrix, animated, cachedMeshes)) return false;
  const mesh = node.getMesh();
  node
    .setMesh(null)
    .setSkin(null)
    .setExtras({ ...node.getExtras(), cswatchDoor: tag });
  addDoorStage(document, node, mesh, { stage: 0, modelId: tag.modelId });
  return true;
}

export function addDoorStage(document, door, mesh, stage) {
  // Keep the stage transform separate from the mesh, whose local transform may
  // acquire a quantization decode scale/offset when an immutable tier is written.
  const holder = document
    .createNode('Door stage ' + stage.stage)
    .setExtras({ cswatchDoorStage: stage });
  if (stage.stage !== 0) holder.setScale([0, 0, 0]);
  holder.addChild(document.createNode(mesh.getName()).setMesh(mesh));
  door.addChild(holder);
}
