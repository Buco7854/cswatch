import {
  Box3,
  Frustum,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';

const minimumBlockTriangles = 64;
const maxIndexedTriangles = 12_000_000;
const maxVisitedVertices = 600_000;
const blocksPerRegion = 8;
const maxGapsPerDraw = 4;
const maxBlocks = 32_768;
const idleSliceIndices = 8192;

type Bounds = { blocks: Box3[]; regions: Box3[] };

/** Measure the exact local boxes before a batch is first drawn. Idle periods
 * prepare boxes outside the current view ahead of later turns and seeks. */
function prepareBounds(candidates: Map<BufferGeometry, number>, indicesPerBlock: number) {
  const bounds = new WeakMap<BufferGeometry, Bounds>();
  const point = new Vector3();
  let visited = new Uint32Array(0);
  let stamp = 0;
  // Keep admission independent of the first camera position: visibility only
  // affects *when* bounds are measured, never their triangle or memory budgets.
  let reservedBlocks = 0;
  let reservedTriangles = 0;
  for (const [geometry, count] of candidates) {
    const length = Math.ceil(count / indicesPerBlock);
    if (
      reservedBlocks + length > maxBlocks ||
      reservedTriangles + count / 3 > maxIndexedTriangles
    ) {
      candidates.delete(geometry);
      continue;
    }
    reservedBlocks += length;
    reservedTriangles += count / 3;
  }

  function* measure(geometry: BufferGeometry, count: number): Generator<void, Bounds | undefined> {
    const position = geometry.attributes.position;
    const index = geometry.index;
    const stampVertices = index && position.count <= maxVisitedVertices;
    if (stampVertices && visited.length < position.count) visited = new Uint32Array(position.count);
    const interleaved = position instanceof InterleavedBufferAttribute;
    // Prepared desktop and mobile maps use unnormalized FLOAT positions. Read
    // interleaved xyz together; leave other encodings to Three's accessors.
    const coordinates =
      !position.normalized && position.array instanceof Float32Array ? position.array : undefined;
    const stride = interleaved ? position.data.stride : position.itemSize;
    const offset = interleaved ? position.offset : 0;
    const indices =
      index &&
      !(index instanceof InterleavedBufferAttribute) &&
      !index.normalized &&
      index.itemSize === 1 &&
      (index.array instanceof Uint16Array ||
        index.array instanceof Uint32Array ||
        index.array instanceof Uint8Array)
        ? index.array
        : undefined;
    function expand(box: Box3, start: number, end: number, blockStamp: number) {
      if (coordinates && indices && stampVertices) {
        const min = box.min,
          max = box.max;
        let x0 = min.x,
          y0 = min.y,
          z0 = min.z,
          x1 = max.x,
          y1 = max.y,
          z1 = max.z;
        for (let i = start; i < end; i++) {
          const vertex = indices[i];
          if (visited[vertex] === blockStamp) continue;
          visited[vertex] = blockStamp;
          const at = vertex * stride + offset;
          const x = coordinates[at],
            y = coordinates[at + 1],
            z = coordinates[at + 2];
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          z0 = Math.min(z0, z);
          z1 = Math.max(z1, z);
        }
        min.set(x0, y0, z0);
        max.set(x1, y1, z1);
        return;
      }
      for (let i = start; i < end; i++) {
        const vertex = index ? index.getX(i) : i;
        if (stampVertices) {
          if (visited[vertex] === blockStamp) continue;
          visited[vertex] = blockStamp;
        }
        box.expandByPoint(point.fromBufferAttribute(position, vertex));
      }
    }

    const boxes: Box3[] = [];
    let nextYield = idleSliceIndices;
    for (let first = 0; first < count; first += indicesPerBlock) {
      const box = new Box3();
      const end = Math.min(first + indicesPerBlock, count);
      const blockStamp = ++stamp;
      for (let cursor = first; cursor < end;) {
        const sliceEnd = Math.min(nextYield, end);
        expand(box, cursor, sliceEnd, blockStamp);
        cursor = sliceEnd;
        if (sliceEnd === nextYield) {
          nextYield += idleSliceIndices;
          yield;
        }
      }
      const magnitude = Math.max(box.min.length(), box.max.length());
      if (!Number.isFinite(magnitude)) return;
      // GPU vertex transforms use float precision. Retain boundary triangles.
      boxes.push(box.expandByScalar(0.001 + magnitude * 1e-5));
    }
    const regions: Box3[] = [];
    if (boxes.length >= blocksPerRegion * 2) {
      for (let b = 0; b < boxes.length; b += blocksPerRegion) {
        const region = boxes[b].clone();
        for (let j = b + 1; j < Math.min(b + blocksPerRegion, boxes.length); j++)
          region.union(boxes[j]);
        regions.push(region);
        if (regions.length % 256 === 0) yield;
      }
    }
    return { blocks: boxes, regions };
  }

  let active: { geometry: BufferGeometry; work: ReturnType<typeof measure> } | undefined;
  function finish(geometry: BufferGeometry, result?: Bounds) {
    if (result) bounds.set(geometry, result);
    candidates.delete(geometry);
    if (active?.geometry === geometry) active = undefined;
    if (!candidates.size) visited = new Uint32Array(0);
  }
  function getBounds(geometry: BufferGeometry) {
    const existing = bounds.get(geometry);
    if (existing || !candidates.size) return existing;
    const count = candidates.get(geometry);
    if (count === undefined) return;
    // A newly visible batch gets precise clipping on its very first draw,
    // including a partly measured batch from the preceding idle period.
    const work = active?.geometry === geometry ? active.work : measure(geometry, count);
    let part = work.next();
    while (!part.done) part = work.next();
    finish(geometry, part.value);
    return part.value;
  }

  // A camera turn or seek can reveal another district. Prepare the remaining
  // batches while the browser is idle, yielding even inside very large meshes.
  const remaining = candidates.entries();
  let idle: number | undefined;
  function prepareIdle(deadline: IdleDeadline) {
    idle = undefined;
    const stop = performance.now() + 3;
    while (deadline.timeRemaining() >= 1 && performance.now() < stop) {
      if (!active) {
        const entry = remaining.next();
        if (entry.done) return;
        const [geometry, count] = entry.value;
        active = { geometry, work: measure(geometry, count) };
      }
      const part = active.work.next();
      if (part.done) finish(active.geometry, part.value);
    }
    if (candidates.size) idle = requestIdleCallback(prepareIdle);
  }
  if (typeof requestIdleCallback === 'function' && candidates.size)
    idle = requestIdleCallback(prepareIdle);

  return {
    getBounds,
    dispose() {
      if (idle !== undefined) cancelIdleCallback(idle);
      active = undefined;
      candidates.clear();
    },
  };
}

/** Prepared map batches often span several streets. Submit their visible ranges
 * in source order, splitting only around large, wholly off-camera regions. */
export function installMapDrawRanges(
  renderer: WebGLRenderer,
  world: Scene,
  root: Object3D,
  sky?: Scene | null,
) {
  const meshes = new WeakSet<Object3D>();
  const candidates = new Map<BufferGeometry, number>();
  let totalTriangles = 0;
  function inspect(object: Object3D) {
    if (object.constructor !== Mesh) return;
    const mesh = object as Mesh;
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (!position || position.itemSize !== 3 || Object.keys(geometry.morphAttributes).length)
      return;
    const count = geometry.index?.count ?? position.count;
    if (count < 3 || count % 3) return;
    if (!candidates.has(geometry)) {
      if (candidates.size >= maxBlocks) return;
      candidates.set(geometry, count);
      totalTriangles += count / 3;
    }
    meshes.add(mesh);
  }
  root.traverse(inspect);
  sky?.traverse(inspect);

  // Leave room for one partial block per geometry. Large multi-million triangle
  // maps then receive bounds throughout the level at the same memory limit.
  const budget = maxBlocks - candidates.size;
  const width = budget > 0 ? Math.ceil(Math.min(totalTriangles, maxIndexedTriangles) / budget) : 0;
  const indicesPerBlock = 3 * Math.max(minimumBlockTriangles, width);
  const measurement = prepareBounds(candidates, indicesPerBlock);

  const draw = renderer.renderBufferDirect;
  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const localProjection = new Matrix4();
  const placement = new Matrix4();
  let frame = -1;
  let cameraId = -1;
  const render: typeof draw = function (camera, scene, geometry, material, object, group) {
    // Shadow draws use a different scene/renderer path. Custom shaders, wireframe
    // and displaced surfaces can move vertices outside their position bounds.
    if (
      (scene !== world && (!sky || scene !== sky)) ||
      group ||
      !meshes.has(object) ||
      geometry.drawRange.start !== 0 ||
      geometry.drawRange.count !== Infinity ||
      !(
        material instanceof MeshStandardMaterial ||
        material instanceof MeshBasicMaterial ||
        material instanceof MeshDepthMaterial
      ) ||
      material.wireframe ||
      ('displacementMap' in material && material.displacementMap)
    )
      return draw.call(renderer, camera, scene, geometry, material, object, group);
    const data = measurement.getBounds(geometry);
    if (!data) return draw.call(renderer, camera, scene, geometry, material, object, group);
    const { blocks: boxes, regions } = data;
    const newView = frame !== renderer.info.render.frame || cameraId !== camera.id;
    if (newView) {
      frame = renderer.info.render.frame;
      cameraId = camera.id;
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    }
    // S2V bakes many static nodes into the same coordinate frame. Their local
    // clipping planes remain identical until either the camera or placement changes.
    if (newView || !placement.equals(object.matrixWorld)) {
      placement.copy(object.matrixWorld);
      frustum.setFromProjectionMatrix(
        localProjection.multiplyMatrices(viewProjection, placement),
        camera.coordinateSystem,
        camera.reversedDepth,
      );
    }
    let first = 0;
    let end = boxes.length;
    while (first < end && !frustum.intersectsBox(boxes[first])) first++;
    if (first === end) return;
    while (end > first + 1 && !frustum.intersectsBox(boxes[end - 1])) end--;
    if (!regions.length && !first && end === boxes.length)
      return draw.call(renderer, camera, scene, geometry, material, object, group);
    // A region covers at least 512 source triangles. Each skipped interior run costs one
    // extra draw; cap this even for adversarially interleaved source geometry.
    const lastRegion = Math.floor((end - 1) / blocksPerRegion);
    let gaps = 0;
    try {
      for (
        let r = Math.ceil((first + 1) / blocksPerRegion);
        r < lastRegion && r < regions.length && gaps < maxGapsPerDraw;
        r++
      ) {
        if (frustum.intersectsBox(regions[r])) continue;
        let stop = r * blocksPerRegion;
        while (stop > first + 1 && !frustum.intersectsBox(boxes[stop - 1])) stop--;
        geometry.setDrawRange(first * indicesPerBlock, (stop - first) * indicesPerBlock);
        draw.call(renderer, camera, scene, geometry, material, object, group);
        while (r + 1 < lastRegion && !frustum.intersectsBox(regions[r + 1])) r++;
        first = (r + 1) * blocksPerRegion;
        while (first < end - 1 && !frustum.intersectsBox(boxes[first])) first++;
        r = Math.floor(first / blocksPerRegion);
        gaps++;
      }
      if (first || end < boxes.length)
        geometry.setDrawRange(first * indicesPerBlock, (end - first) * indicesPerBlock);
      draw.call(renderer, camera, scene, geometry, material, object, group);
    } finally {
      if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity)
        geometry.setDrawRange(0, Infinity);
    }
  };
  renderer.renderBufferDirect = render;
  return () => {
    measurement.dispose();
    if (renderer.renderBufferDirect === render) renderer.renderBufferDirect = draw;
  };
}
