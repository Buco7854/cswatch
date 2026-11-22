import { Box3, Matrix4, Mesh, Ray, Vector3, type Group } from 'three';
import type { FollowCamera } from './follow-camera';

const CLEARANCE = 0.24;
const MAX_SURFACES = 8192;
const MAX_TEST_TRIANGLES = 100000;
type Surface = {
  geometry: Mesh['geometry'];
  bounds: Box3;
  toWorld: Matrix4;
  toLocal: Matrix4;
  triangles: number;
};

/** Trace the shoulder arm against bounded, opaque static map triangles. */
export function followObstruction(root: Group) {
  const surfaces: Surface[] = [];
  const vertex = new Vector3();
  root.updateMatrixWorld(true);
  root.traverseVisible((object) => {
    if (surfaces.length >= MAX_SURFACES || Object.getPrototypeOf(object) !== Mesh.prototype) return;
    const mesh = object as Mesh;
    const { material, geometry } = mesh;
    const { position } = geometry.attributes;
    const triangles = Math.floor((geometry.index?.count ?? position?.count ?? 0) / 3);
    if (
      !position ||
      !triangles ||
      triangles > MAX_TEST_TRIANGLES ||
      Object.keys(geometry.morphAttributes).length ||
      geometry.drawRange.start !== 0 ||
      geometry.drawRange.count !== Infinity ||
      Array.isArray(material) ||
      !material.visible ||
      material.transparent ||
      material.alphaTest > 0 ||
      material.alphaHash ||
      ('wireframe' in material && material.wireframe) ||
      !(Math.abs(mesh.matrixWorld.determinant()) >= 1e-12)
    )
      return;
    const bounds = geometry.boundingBox?.clone() ?? new Box3();
    if (!geometry.boundingBox)
      for (let i = 0; i < position.count; i++)
        bounds.expandByPoint(vertex.fromBufferAttribute(position, i));
    bounds.applyMatrix4(mesh.matrixWorld);
    if (bounds.isEmpty()) return;
    const toWorld = mesh.matrixWorld.clone();
    surfaces.push({ geometry, bounds, toWorld, toLocal: toWorld.clone().invert(), triangles });
  });
  const ray = new Ray(),
    localRay = new Ray(),
    destination = new Vector3(),
    a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    hit = new Vector3(),
    lastOrigin = new Vector3(Infinity, Infinity, Infinity),
    lastDestination = new Vector3();
  let lastPosition: FollowCamera['position'] | undefined;

  return ({
    target,
    position,
  }: Pick<FollowCamera, 'target' | 'position'>): FollowCamera['position'] => {
    ray.origin.fromArray(target);
    destination.fromArray(position);
    if (lastOrigin.equals(ray.origin) && lastDestination.equals(destination))
      return lastPosition ?? position;
    lastOrigin.copy(ray.origin);
    lastDestination.copy(destination);
    const length = ray.direction.subVectors(destination, ray.origin).length();
    ray.direction.divideScalar(length || 1);

    const candidates: { surface: Surface; distance: number }[] = [];
    for (const surface of surfaces) {
      const distance = surface.bounds.containsPoint(ray.origin)
        ? 0
        : ray.intersectBox(surface.bounds, hit)?.distanceTo(ray.origin);
      if (distance !== undefined && distance < length + CLEARANCE)
        candidates.push({ surface, distance });
    }
    candidates.sort((x, y) => x.distance - y.distance);
    let checked = 0,
      nearest = length + CLEARANCE;
    for (const { surface, distance } of candidates) {
      if (distance > nearest) break;
      if (checked + surface.triangles > MAX_TEST_TRIANGLES) continue;
      checked += surface.triangles;
      localRay.copy(ray).applyMatrix4(surface.toLocal);
      const { index, attributes } = surface.geometry;
      for (let i = 0; i < surface.triangles * 3; i += 3) {
        a.fromBufferAttribute(attributes.position, index ? index.getX(i) : i);
        b.fromBufferAttribute(attributes.position, index ? index.getX(i + 1) : i + 1);
        c.fromBufferAttribute(attributes.position, index ? index.getX(i + 2) : i + 2);
        if (!localRay.intersectTriangle(a, b, c, false, hit)) continue;
        const distance = hit.applyMatrix4(surface.toWorld).distanceTo(ray.origin);
        if (distance > 1e-4) nearest = Math.min(nearest, distance);
      }
    }
    lastPosition =
      nearest < length + CLEARANCE
        ? ray.at(Math.max(Math.min(0.03, nearest / 2), nearest - CLEARANCE), hit).toArray()
        : undefined;
    return lastPosition ?? position;
  };
}
