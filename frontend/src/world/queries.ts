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
import type { Manifest, Range } from './format';
import { meshBases } from './geometry';
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
export function worldQueries(
  manifest: Manifest,
  vertices: Uint8Array,
  indices: Uint32Array,
  instanceTable?: Uint8Array | null,
) {
  const floats = new Float32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4);
  const bases = meshBases(manifest);
  const leaves: Leaf[] = [],
    placements = new Map<number, Node[]>();
  const options = { strategy: CENTER, indirect: true } as const;
  // Source-space positions of the given ranges in viewer space, with indices local to them.
  function tree(ranges: Range[]) {
    let total = 0,
      triangles = 0;
    for (const range of ranges) {
      total += range.vertices;
      triangles += range.count;
    }
    const position = new Float32Array(total * 3),
      local = new Uint32Array(triangles),
      materials = new Uint16Array(triangles / 3),
      point = new Vector3();
    let vertex = 0,
      index = 0;
    for (const range of ranges) {
      const base = bases.get(range.first)!;
      for (let i = 0; i < range.vertices; i++)
        point
          .fromArray(floats, (base + i) * 15)
          .applyMatrix4(sourceToViewer)
          .toArray(position, (vertex + i) * 3);
      for (let i = 0; i < range.count; i++)
        local[index + i] = indices[range.first + i] - base + vertex;
      materials.fill(range.material, index / 3, (index + range.count) / 3);
      vertex += range.vertices;
      index += range.count;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setIndex(new BufferAttribute(local, 1));
    const bvh = new MeshBVH(geometry, options);
    return { tree: bvh, materials, authored: bvh.getBoundingBox(new Box3()) };
  }
  function leaf(shape: ReturnType<typeof tree>, entity: number, transform = new Matrix4()) {
    leaves.push({
      ...shape,
      entity,
      bounds: shape.authored.clone().applyMatrix4(transform),
      visible: entity < 0 || manifest.entities[entity].initialVisibility,
      transform,
      inverse: transform.clone().invert(),
    });
  }
  // Follow, ground and impact queries use solid opaque triangles. An instanced mesh has one tree
  // shared by a leaf per instance, placed in viewer space.
  const shared = new Map<number, ReturnType<typeof tree>>();
  const instances = instanceTable
    ? new Float32Array(instanceTable.buffer, instanceTable.byteOffset, instanceTable.byteLength / 4)
    : null;
  const viewerToSource = sourceToViewer.clone().invert(),
    placement = new Matrix4();
  for (const chunk of manifest.chunks) {
    if (chunk.sky || chunk.family !== 'opaque' || !chunk.ranges.length) continue;
    const plain = chunk.ranges.filter((range) => !range.instances);
    if (plain.length) leaf(tree(plain), chunk.ranges[0].entity);
    for (const range of chunk.ranges) {
      if (!range.instances || !instances) continue;
      let shape = shared.get(range.first);
      if (!shape) shared.set(range.first, (shape = tree([range])));
      for (let i = range.instances[0]; i < range.instances[0] + range.instances[1]; i++) {
        // Rows of the 3x4 source-space transform.
        const r = instances.subarray(i * 16, i * 16 + 12);
        placement.set(
          r[0],
          r[1],
          r[2],
          r[3],
          r[4],
          r[5],
          r[6],
          r[7],
          r[8],
          r[9],
          r[10],
          r[11],
          0,
          0,
          0,
          1,
        );
        leaf(shape, -1, sourceToViewer.clone().multiply(placement).multiply(viewerToSource));
      }
    }
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
    const triangle = new Triangle(),
      center = new Vector3();
    function visit(node: Node) {
      if (node.bounds.distanceToPoint(origin) > radius) return;
      const leaf = node.leaf;
      if (!leaf) {
        if (node.left) visit(node.left);
        if (node.right) visit(node.right);
        return;
      }
      if (!leaf.visible) return;
      center.copy(origin).applyMatrix4(leaf.inverse);
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
    visit(root);
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
/** Static-scene ray queries shared by the follow camera, feet, labels, tracers and sounds. */
export type SceneTrace = WorldQueries['trace'];
