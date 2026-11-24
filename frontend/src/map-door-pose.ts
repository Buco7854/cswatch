import { Matrix4, Object3D, Vector3 } from 'three';

type SourceOrigin = readonly [number, number, number];

/** Apply the observed world yaw relative to the closed orientation around the native hinge. Detailed meshes
 * keep local vertices; Compact can bake that same placement into its vertices. */
export function mapDoorPose(root: Object3D, node: Object3D, origin: SourceOrigin) {
  const parent = node.parent;
  if (!parent) return;
  node.updateWorldMatrix(true, false);
  if (Math.abs(parent.matrixWorld.determinant()) < 1e-12) return;
  const toParent = parent.matrixWorld.clone().invert().multiply(root.matrixWorld);
  const initial = node.matrix.clone();
  const auto = node.matrixAutoUpdate;
  const hinge = new Vector3(origin[1], origin[2], origin[0]).multiplyScalar(0.0254);
  const left = toParent.clone().multiply(new Matrix4().makeTranslation(hinge.x, hinge.y, hinge.z));
  const right = new Matrix4()
    .makeTranslation(-hinge.x, -hinge.y, -hinge.z)
    .multiply(toParent.clone().invert())
    .multiply(initial);
  const matrix = new Matrix4();
  const apply = (value: Matrix4) => {
    if (node.matrix.equals(value)) return false;
    node.matrixAutoUpdate = false;
    node.matrix.copy(value);
    // A sealed map skips traversal of stationary children. Update only the moved subtree.
    node.updateMatrixWorld(true);
    return true;
  };
  return {
    set(yawDelta: number) {
      if (yawDelta % 360 === 0) return apply(initial);
      return apply(
        matrix
          .makeRotationY((yawDelta * Math.PI) / 180)
          .premultiply(left)
          .multiply(right),
      );
    },
    dispose() {
      apply(initial);
      node.matrixAutoUpdate = auto;
    },
  };
}
