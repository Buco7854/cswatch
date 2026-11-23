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

const indicesPerBlock = 64 * 3;
const maxBlocks = 32_768;

/** Prepared map batches often span multiple streets. Keep the contiguous range from
 * the first to last potentially visible block, in the original triangle order. */
export function installMapDrawRanges(renderer: WebGLRenderer, world: Scene, root: Object3D) {
  const meshes = new WeakSet<Object3D>();
  const bounds = new WeakMap<BufferGeometry, Box3[]>();
  const point = new Vector3();
  let blocks = 0;
  root.traverse((object) => {
    if (object.constructor !== Mesh) return;
    const mesh = object as Mesh;
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (!position || position.itemSize !== 3 || Object.keys(geometry.morphAttributes).length)
      return;
    const index = geometry.index;
    const count = index?.count ?? position.count;
    if (count < indicesPerBlock * 2 || count % 3) return;
    if (!bounds.has(geometry)) {
      const length = Math.ceil(count / indicesPerBlock);
      if (blocks + length > maxBlocks) return;
      const boxes: Box3[] = [];
      for (let first = 0; first < count; first += indicesPerBlock) {
        const box = new Box3();
        const end = Math.min(first + indicesPerBlock, count);
        for (let i = first; i < end; i++)
          box.expandByPoint(point.fromBufferAttribute(position, index ? index.getX(i) : i));
        const magnitude = Math.max(box.min.length(), box.max.length());
        if (!Number.isFinite(magnitude)) return;
        // GPU vertex transforms use float precision. Retain boundary triangles.
        boxes.push(box.expandByScalar(0.001 + magnitude * 1e-5));
      }
      bounds.set(geometry, boxes);
      blocks += boxes.length;
    }
    meshes.add(mesh);
  });

  const draw = renderer.renderBufferDirect;
  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const localProjection = new Matrix4();
  let frame = -1;
  let cameraId = -1;
  const render: typeof draw = function (camera, scene, geometry, material, object, group) {
    // Shadow draws use a different scene/renderer path. Custom shaders, wireframe
    // and displaced surfaces can move vertices outside their position bounds.
    if (
      scene !== world ||
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
    const boxes = bounds.get(geometry);
    if (!boxes) return draw.call(renderer, camera, scene, geometry, material, object, group);
    if (frame !== renderer.info.render.frame || cameraId !== camera.id) {
      frame = renderer.info.render.frame;
      cameraId = camera.id;
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    }
    frustum.setFromProjectionMatrix(
      localProjection.multiplyMatrices(viewProjection, object.matrixWorld),
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    let first = 0;
    let end = boxes.length;
    while (first < end && !frustum.intersectsBox(boxes[first])) first++;
    if (first === end) return;
    while (end > first + 1 && !frustum.intersectsBox(boxes[end - 1])) end--;
    if (!first && end === boxes.length)
      return draw.call(renderer, camera, scene, geometry, material, object, group);
    // Restore even when a context error interrupts drawing. Shared geometry can
    // appear in another instance, depth pass or camera on this same frame.
    geometry.setDrawRange(first * indicesPerBlock, (end - first) * indicesPerBlock);
    try {
      draw.call(renderer, camera, scene, geometry, material, object, group);
    } finally {
      geometry.setDrawRange(0, Infinity);
    }
  };
  renderer.renderBufferDirect = render;
  return () => {
    if (renderer.renderBufferDirect === render) renderer.renderBufferDirect = draw;
  };
}
