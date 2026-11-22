import { Box3, Mesh, Triangle, Vector3, Vector4, type Group } from 'three';

// A small set of local planes softens volume contact. The ordinary world depth
// test still handles foreground geometry beyond these local approximations.
export const impactPlaneCount = 5;
const radius = 2.65;
const contactTriangleLimit = 4096;
const triangleBudget = 80_000;

export function impactSurfaces(root: Group | null, position: [number, number, number]) {
  if (!root) return { planes: [], vertices: new Float32Array() };
  const origin = new Vector3(...position);
  const reference = origin.clone().add(new Vector3(0, 0.18, 0));
  const candidates: { mesh: Mesh; distance: number; count: number }[] = [];
  const bounds = new Box3();
  root.traverseVisible((object) => {
    if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
    const { geometry, material } = object;
    const attribute = geometry.attributes.position;
    if (
      !attribute ||
      !material.visible ||
      material.transparent ||
      material.alphaHash ||
      material.alphaTest > 0
    )
      return;
    const count = Math.floor((geometry.index?.count ?? attribute.count) / 3);
    if (!count || count > triangleBudget) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const distance = bounds
      .copy(geometry.boundingBox!)
      .applyMatrix4(object.matrixWorld)
      .distanceToPoint(origin);
    if (distance < radius) candidates.push({ mesh: object, distance, count });
  });
  candidates.sort((a, b) => a.distance - b.distance);

  const closest: ({ distance: number; plane: Vector4 } | undefined)[] = Array(impactPlaneCount);
  const triangle = new Triangle();
  const nearest = new Vector3();
  const normal = new Vector3();
  const offset = new Vector3();
  const triangles: number[] = [];
  let checked = 0;
  for (const { mesh, count } of candidates) {
    if (checked + count > triangleBudget) continue;
    checked += count;
    const { index, attributes } = mesh.geometry;
    const vertex = (target: Vector3, i: number) =>
      target
        .fromBufferAttribute(attributes.position, index ? index.getX(i) : i)
        .applyMatrix4(mesh.matrixWorld);
    for (let i = 0; i < count * 3; i += 3) {
      vertex(triangle.a, i);
      vertex(triangle.b, i + 1);
      vertex(triangle.c, i + 2);
      triangle.closestPointToPoint(reference, nearest);
      const distance = nearest.distanceTo(reference);
      if (distance >= radius || !Number.isFinite(distance)) continue;
      // Keep the original opaque triangle for the local depth draw. A plane
      // alone cannot represent the individual risers and different arch faces.
      if (triangles.length < contactTriangleLimit * 9) {
        triangles.push(
          triangle.a.x,
          triangle.a.y,
          triangle.a.z,
          triangle.b.x,
          triangle.b.y,
          triangle.b.z,
          triangle.c.x,
          triangle.c.y,
          triangle.c.z,
        );
      }
      triangle.getNormal(normal);
      if (normal.lengthSq() < 0.5) continue;
      offset.subVectors(reference, nearest);
      if (normal.dot(offset) < 0) normal.negate();
      let slot: number;
      if (normal.y >= 0.72 && distance < 0.85 && Math.hypot(offset.x, offset.z) < 0.3) {
        slot = 0;
      } else {
        const top = Math.max(triangle.a.y, triangle.b.y, triangle.c.y);
        const bottom = Math.min(triangle.a.y, triangle.b.y, triangle.c.y);
        // A riser can occlude a lobe in depth, but it is not a full-height wall.
        if (
          Math.abs(normal.y) > 0.45 ||
          distance > 1.3 ||
          top < origin.y + 0.58 ||
          top - bottom < 0.55
        )
          continue;
        slot =
          Math.abs(normal.x) >= Math.abs(normal.z) ? (normal.x > 0 ? 1 : 2) : normal.z > 0 ? 3 : 4;
      }
      if (distance >= (closest[slot]?.distance ?? Infinity)) continue;
      closest[slot] = {
        distance,
        plane: new Vector4(normal.x, normal.y, normal.z, -normal.dot(nearest)),
      };
    }
  }
  return {
    planes: closest.flatMap((entry) => (entry ? [entry.plane] : [])),
    vertices: Float32Array.from(triangles),
  };
}
