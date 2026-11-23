import { SkinnedMesh, Vector3, type Object3D } from 'three';
import type { FollowCamera } from './follow-camera';

type FloorTrace = (ray: Pick<FollowCamera, 'target' | 'position'>) => FollowCamera['position'];

/** Find nearby support under the skinned body. The recorded horizontal anchor stays fixed. */
export function createCorpseFloor(root: Object3D) {
  const meshes: SkinnedMesh[] = [];
  root.traverse((node) => {
    if (node instanceof SkinnedMesh && node.geometry.attributes.position) meshes.push(node);
  });
  if (!meshes.length) return;
  const vertex = new Vector3(),
    origin = new Vector3();
  const floorByCell = new Map<string, number>();
  const lowest = new Map<string, [number, number, number]>();
  let previousTrace: FloorTrace | undefined;
  let previousAge = -1;

  return (age: number, trace: FloorTrace | undefined) => {
    if (trace !== previousTrace) {
      floorByCell.clear();
      previousAge = -1;
      previousTrace = trace;
    }
    if (age === previousAge) return;
    previousAge = age;
    root.position.y = 0;
    if (!trace) return;
    root.getWorldPosition(origin);
    root.updateMatrixWorld(true);
    lowest.clear();
    const sampleStride = Math.max(
      1,
      Math.ceil(
        meshes.reduce((count, mesh) => count + mesh.geometry.attributes.position.count, 0) / 512,
      ),
    );
    for (const mesh of meshes) {
      const positions = mesh.geometry.attributes.position;
      for (let index = 0; index < positions.count; index += sampleStride) {
        vertex.fromBufferAttribute(positions, index);
        mesh.applyBoneTransform(index, vertex).applyMatrix4(mesh.matrixWorld);
        if (Math.abs(vertex.y - origin.y) > 0.5) continue;
        const x = Math.floor(vertex.x * 7),
          z = Math.floor(vertex.z * 7);
        const cell = x + ':' + z;
        if ((lowest.get(cell)?.[1] ?? Infinity) > vertex.y)
          lowest.set(cell, [(x + 0.5) / 7, vertex.y, (z + 0.5) / 7]);
      }
    }
    let lift = 0;
    const points = [...lowest].sort(([, a], [, b]) => a[1] - b[1]);
    for (const [cell, [x, y, z]] of points.slice(0, 28)) {
      let floor = floorByCell.get(cell);
      if (floor === undefined) {
        const bottom: FollowCamera['position'] = [x, origin.y - 0.62, z];
        const hit = trace({ target: [x, origin.y + 0.47, z], position: bottom });
        floor = hit === bottom ? -Infinity : hit[1];
        if (floorByCell.size < 192) floorByCell.set(cell, floor);
      }
      lift = Math.max(lift, floor - y + 0.005);
    }
    root.position.y = Math.min(0.45, lift);
  };
}
