import { Box3, Matrix4, Mesh, Ray, Vector3, type Group, type Object3D } from 'three';
import { mapBreakableVisibility } from './map-breakables';
import type { FollowCamera } from './follow-camera';

const CLEARANCE = 0.24;
const MAX_SURFACES = 8192;
const MAX_TEST_TRIANGLES = 100000;
const TRIANGLES_PER_BLOCK = 64;
const MAX_BLOCKS = 32_768;
type Surface = {
  gate?: Object3D;
  movingVisible?: boolean;
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
  const breakables = mapBreakableVisibility(root);
  const movingSurfaces: { surface: Surface; mesh: Mesh; door: Object3D; localBounds: Box3 }[] = [];
  const add = (object: Object3D, gate?: Object3D, door?: Object3D) => {
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
    const localBounds = door && bounds.clone();
    bounds.applyMatrix4(mesh.matrixWorld);
    if (bounds.isEmpty()) return;
    const toWorld = mesh.matrixWorld.clone();
    const surface: Surface = {
      geometry,
      bounds,
      toWorld,
      toLocal: toWorld.clone().invert(),
      triangles,
      gate,
    };
    surfaces.push(surface);
    if (door && localBounds) movingSurfaces.push({ surface, mesh, door, localBounds });
  };
  if (breakables) {
    // An opening seek may already hide a tagged parent. Index its authored
    // triangles once so all forks can trace them again after a rewind.
    function visit(node: Object3D, gate?: Object3D, door?: Object3D) {
      if (breakables!.moving.has(node)) door = node;
      // Alternate authored door stages can become visible on a later seek.
      if (
        !(breakables!.authored.get(node) ?? node.visible) &&
        !(door && node.userData.cswatchDoorStage)
      )
        return;
      if (breakables!.authored.has(node)) gate = node;
      add(node, gate, door);
      for (const child of node.children) visit(child, gate, door);
    }
    visit(root);
  } else root.traverseVisible(add);
  // Prepared primitives retain spatial locality in their index order. Build bounds
  // only for large geometry that a ray reaches, and share them across instances.
  const blocksByGeometry = new WeakMap<Mesh['geometry'], Box3[]>();
  let blockCount = 0;
  function triangleBlocks({ geometry, triangles }: Surface) {
    const cached = blocksByGeometry.get(geometry);
    if (cached) return cached;
    const count = Math.ceil(triangles / TRIANGLES_PER_BLOCK);
    if (count < 2 || blockCount + count > MAX_BLOCKS) return;
    const blocks: Box3[] = [];
    const { index, attributes } = geometry;
    for (let start = 0; start < triangles; start += TRIANGLES_PER_BLOCK) {
      const box = new Box3();
      const end = Math.min(start + TRIANGLES_PER_BLOCK, triangles) * 3;
      for (let i = start * 3; i < end; i++) {
        vertex.fromBufferAttribute(attributes.position, index ? index.getX(i) : i);
        box.expandByPoint(vertex);
      }
      // Include edge contacts despite rounding between model and ray transforms.
      blocks.push(box.expandByScalar(1e-7));
    }
    blockCount += count;
    blocksByGeometry.set(geometry, blocks);
    return blocks;
  }

  let geometryRevision: number | undefined;
  function updateMovingSurfaces() {
    if (!breakables || geometryRevision === breakables.revision) return;
    geometryRevision = breakables.revision;
    // Doors are a small subset of the static world. All forks share the update.
    for (const { surface, mesh, door, localBounds } of movingSurfaces) {
      let node: Object3D | null = mesh;
      while (node && node.visible && node !== door) node = node.parent;
      surface.movingVisible = node === door && door.visible;
      if (!surface.movingVisible) continue;
      surface.toWorld.copy(mesh.matrixWorld);
      surface.toLocal.copy(mesh.matrixWorld).invert();
      surface.bounds.copy(localBounds).applyMatrix4(mesh.matrixWorld);
    }
  }
  const createTrace = (clearance = CLEARANCE) => {
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
    let lastRevision: number | undefined;

    return ({
      target,
      position,
    }: Pick<FollowCamera, 'target' | 'position'>): FollowCamera['position'] => {
      ray.origin.fromArray(target);
      destination.fromArray(position);
      if (
        lastRevision === breakables?.revision &&
        lastOrigin.equals(ray.origin) &&
        lastDestination.equals(destination)
      )
        return lastPosition ?? position;
      lastRevision = breakables?.revision;
      updateMovingSurfaces();
      lastOrigin.copy(ray.origin);
      lastDestination.copy(destination);
      const length = ray.direction.subVectors(destination, ray.origin).length();
      ray.direction.divideScalar(length || 1);

      const candidates: { surface: Surface; distance: number }[] = [];
      for (const surface of surfaces) {
        const distance = surface.bounds.containsPoint(ray.origin)
          ? 0
          : ray.intersectBox(surface.bounds, hit)?.distanceTo(ray.origin);
        if (
          distance !== undefined &&
          distance < length + clearance &&
          surface.gate?.visible !== false &&
          surface.movingVisible !== false
        )
          candidates.push({ surface, distance });
      }
      candidates.sort((x, y) => x.distance - y.distance);
      let checked = 0,
        nearest = length + clearance;
      for (const { surface, distance } of candidates) {
        if (distance > nearest) break;
        if (checked + surface.triangles > MAX_TEST_TRIANGLES) continue;
        checked += surface.triangles;
        localRay.copy(ray).applyMatrix4(surface.toLocal);
        const { index, attributes } = surface.geometry;
        const blocks = triangleBlocks(surface);
        for (let first = 0; first < surface.triangles; first += TRIANGLES_PER_BLOCK) {
          if (blocks && !localRay.intersectsBox(blocks[first / TRIANGLES_PER_BLOCK])) continue;
          const end = Math.min(first + TRIANGLES_PER_BLOCK, surface.triangles) * 3;
          for (let i = first * 3; i < end; i += 3) {
            a.fromBufferAttribute(attributes.position, index ? index.getX(i) : i);
            b.fromBufferAttribute(attributes.position, index ? index.getX(i + 1) : i + 1);
            c.fromBufferAttribute(attributes.position, index ? index.getX(i + 2) : i + 2);
            if (!localRay.intersectTriangle(a, b, c, false, hit)) continue;
            const distance = hit.applyMatrix4(surface.toWorld).distanceTo(ray.origin);
            if (distance > 1e-4) nearest = Math.min(nearest, distance);
          }
        }
      }
      lastPosition =
        nearest < length + clearance
          ? ray.at(Math.max(Math.min(0.03, nearest / 2), nearest - clearance), hit).toArray()
          : undefined;
      return lastPosition ?? position;
    };
  };
  return Object.assign(createTrace(), { fork: createTrace });
}
