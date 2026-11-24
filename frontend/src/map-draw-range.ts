import {
  Box3,
  Frustum,
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

type Bounds = { blocks: Box3[]; regions: Box3[] };

/** Prepared map batches often span several streets. Submit their visible ranges
 * in source order, splitting only around large, wholly off-camera regions. */
export function installMapDrawRanges(
  renderer: WebGLRenderer,
  world: Scene,
  root: Object3D,
  sky?: Scene | null,
) {
  const meshes = new WeakSet<Object3D>();
  const bounds = new WeakMap<BufferGeometry, Bounds>();
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
  const point = new Vector3();
  let visited = new Uint32Array(0);
  let stamp = 0;
  let blocks = 0,
    scanned = 0;
  for (const [geometry, count] of candidates) {
    const length = Math.ceil(count / indicesPerBlock);
    if (blocks + length > maxBlocks || scanned + count / 3 > maxIndexedTriangles) continue;
    scanned += count / 3;
    const position = geometry.attributes.position,
      index = geometry.index;
    // Indexed map geometry reuses vertices repeatedly inside each block. Reading
    // a shared position once per box bounds the load cost of covering large maps.
    const stampVertices = index && position.count <= maxVisitedVertices;
    if (stampVertices && visited.length < position.count) visited = new Uint32Array(position.count);
    const boxes: Box3[] = [];
    for (let first = 0; first < count; first += indicesPerBlock) {
      const box = new Box3();
      const end = Math.min(first + indicesPerBlock, count);
      stamp++;
      for (let i = first; i < end; i++) {
        const vertex = index ? index.getX(i) : i;
        if (stampVertices) {
          if (visited[vertex] === stamp) continue;
          visited[vertex] = stamp;
        }
        box.expandByPoint(point.fromBufferAttribute(position, vertex));
      }
      const magnitude = Math.max(box.min.length(), box.max.length());
      if (!Number.isFinite(magnitude)) break;
      // GPU vertex transforms use float precision. Retain boundary triangles.
      boxes.push(box.expandByScalar(0.001 + magnitude * 1e-5));
    }
    if (boxes.length !== length) continue;
    const regions: Box3[] = [];
    if (length >= blocksPerRegion * 2) {
      for (let b = 0; b < length; b += blocksPerRegion) {
        const region = boxes[b].clone();
        for (let j = b + 1; j < Math.min(b + blocksPerRegion, length); j++) region.union(boxes[j]);
        regions.push(region);
      }
    }
    bounds.set(geometry, { blocks: boxes, regions });
    blocks += length;
  }
  candidates.clear();

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
    const data = bounds.get(geometry);
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
    if (renderer.renderBufferDirect === render) renderer.renderBufferDirect = draw;
  };
}
