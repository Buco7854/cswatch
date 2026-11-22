import { Frustum, Matrix4, Sphere, Vector3, type Camera, type Object3D } from 'three';

/** Bounds include rifle aim and the shipped clips' sprawled death poses. */
export function agentPoseVisibility() {
  const frustum = new Frustum();
  const matrix = new Matrix4();
  const bounds = new Sphere(new Vector3(), 3);
  return (camera: Camera, rig: Object3D, xray: boolean) => {
    if (xray) return true;
    camera.updateWorldMatrix(true, false);
    frustum.setFromProjectionMatrix(
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    rig.getWorldPosition(bounds.center);
    bounds.center.y += 0.85;
    return frustum.intersectsSphere(bounds);
  };
}
