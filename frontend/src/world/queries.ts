import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix4,
  Ray,
  Triangle,
  Vector3,
} from 'three';
import { MeshBVH, CENTER } from 'three-mesh-bvh';
import type { Manifest } from './format';
import type { FollowCamera } from '../follow-camera';
import { sourceToViewer } from './space';

type Segment = Pick<FollowCamera, 'position' | 'target'>;
type Point = FollowCamera['position'];
interface Leaf {
  entity: number;
  bounds: Box3;
  authored: Box3;
  transform: Matrix4;
  inverse: Matrix4;
  visible: boolean;
  tree: MeshBVH;
  materials: Uint16Array;
}
interface Node {
  bounds: Box3;
  leaf?: Leaf;
  left?: Node;
  right?: Node;
  parent?: Node;
}
export function worldQueries(manifest: Manifest, vertices: Uint8Array, indices: Uint32Array) {
  const floats = new Float32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4);
  let vertex = 0;
  const leaves: Leaf[] = [],
    placements = new Map<number, Node[]>();
  for (const chunk of manifest.chunks) {
    const base = vertex;
    for (const range of chunk.ranges) vertex += range.vertices;
    // Follow, ground and impact queries use solid opaque triangles.
    if (chunk.sky || chunk.family !== 'opaque' || !chunk.ranges.length) continue;
    const first = chunk.ranges[0].first,
      last = chunk.ranges.at(-1)!;
    const position = new Float32Array((vertex - base) * 3),
      point = new Vector3();
    for (let i = base; i < vertex; i++)
      point
        .fromArray(floats, i * 15)
        .applyMatrix4(sourceToViewer)
        .toArray(position, (i - base) * 3);
    const local = indices.slice(first, last.first + last.count);
    for (let i = 0; i < local.length; i++) local[i] -= base;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setIndex(new BufferAttribute(local, 1));
    const materials = new Uint16Array(local.length / 3);
    for (const range of chunk.ranges)
      materials.fill(
        range.material,
        (range.first - first) / 3,
        (range.first - first + range.count) / 3,
      );
    const options = { strategy: CENTER, indirect: true } as const;
    const tree = new MeshBVH(geometry, options);
    const authored = tree.getBoundingBox(new Box3()),
      entity = chunk.ranges[0].entity;
    leaves.push({
      entity,
      authored,
      bounds: authored.clone(),
      tree,
      materials,
      visible: entity < 0 || manifest.entities[entity].initialVisibility,
      transform: new Matrix4(),
      inverse: new Matrix4(),
    });
  }
  function build(items: Leaf[], parent?: Node): Node {
    const node: Node = { bounds: new Box3(), parent };
    for (const leaf of items) node.bounds.union(leaf.bounds);
    if (items.length === 1) {
      node.leaf = items[0];
      const id = node.leaf.entity;
      if (id >= 0) {
        const list = placements.get(id) ?? [];
        placements.set(id, list);
        list.push(node);
      }
    } else if (items.length) {
      const size = node.bounds.getSize(new Vector3()),
        axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
      items.sort(
        (a, b) =>
          a.bounds.min[axis] + a.bounds.max[axis] - (b.bounds.min[axis] + b.bounds.max[axis]),
      );
      const mid = items.length >> 1;
      node.left = build(items.slice(0, mid), node);
      node.right = build(items.slice(mid), node);
    }
    return node;
  }
  const root = build(leaves);
  let revision = 0;
  function updateEntity(id: number, transform: Matrix4, visible: boolean) {
    for (const node of placements.get(id) ?? []) {
      const leaf = node.leaf!;
      if (leaf.visible === visible && leaf.transform.equals(transform)) continue;
      leaf.visible = visible;
      leaf.transform.copy(transform);
      leaf.inverse.copy(transform).invert();
      node.bounds.copy(leaf.authored).applyMatrix4(transform);
      for (let parent = node.parent; parent; parent = parent.parent)
        parent.bounds.copy(parent.left!.bounds).union(parent.right!.bounds);
      revision++;
    }
  }
  function hit(segment: Segment, margin = 0) {
    const ray = new Ray(new Vector3(...segment.target), new Vector3(...segment.position));
    const length = ray.direction.sub(ray.origin).length();
    if (!length) return null;
    ray.direction.divideScalar(length);
    let nearest = length + margin;
    let result: { point: Vector3; distance: number; entity: number; material: number } | null =
      null;
    const testPoint = new Vector3(),
      local = new Ray();
    function visit(node: Node) {
      if (
        !node.bounds.containsPoint(ray.origin) &&
        (!ray.intersectBox(node.bounds, testPoint) || testPoint.distanceTo(ray.origin) > nearest)
      )
        return;
      if (node.leaf) {
        const leaf = node.leaf;
        if (!leaf.visible) return;
        const contact = leaf.tree.raycastFirst(
          local.copy(ray).applyMatrix4(leaf.inverse),
          DoubleSide,
          0,
          nearest,
        );
        if (!contact) return;
        const point = contact.point.applyMatrix4(leaf.transform),
          distance = point.distanceTo(ray.origin);
        if (distance >= nearest) return;
        nearest = distance;
        result = {
          point,
          distance,
          entity: leaf.entity,
          material: leaf.materials[contact.faceIndex!],
        };
      } else if (node.left) {
        visit(node.left);
        visit(node.right!);
      }
    }
    visit(root);
    return result as { point: Vector3; distance: number; entity: number; material: number } | null;
  }
  function fork(clearance = 0.24) {
    let cachedRevision = -1;
    const from = new Vector3(),
      to = new Vector3();
    let contact: Point | undefined;
    return (segment: Segment): Point => {
      if (
        cachedRevision === revision &&
        from.equals(new Vector3(...segment.target)) &&
        to.equals(new Vector3(...segment.position))
      )
        return contact ?? segment.position;
      from.fromArray(segment.target);
      to.fromArray(segment.position);
      cachedRevision = revision;
      const found = hit(segment, clearance);
      contact = found
        ? found.point
            .sub(from)
            .normalize()
            .multiplyScalar(
              Math.max(Math.min(0.03, found.distance / 2), found.distance - clearance),
            )
            .add(from)
            .toArray()
        : undefined;
      return contact ?? segment.position;
    };
  }
  function nearby(origin: Vector3, radius: number, accept: (triangle: Triangle) => void) {
    const triangle = new Triangle();
    for (const leaf of leaves) {
      if (
        !leaf.visible ||
        leaf.authored.clone().applyMatrix4(leaf.transform).distanceToPoint(origin) > radius
      )
        continue;
      const center = origin.clone().applyMatrix4(leaf.inverse);
      leaf.tree.shapecast({
        intersectsBounds: (bounds) => bounds.distanceToPoint(center) <= radius,
        intersectsTriangle: (face) => {
          triangle.copy(face);
          for (const p of [triangle.a, triangle.b, triangle.c]) p.applyMatrix4(leaf.transform);
          accept(triangle);
          return false;
        },
      });
    }
  }
  return {
    hit,
    trace: Object.assign(fork(), { fork }),
    updateEntity,
    nearby,
    get revision() {
      return revision;
    },
  };
}
export type WorldQueries = ReturnType<typeof worldQueries>;
