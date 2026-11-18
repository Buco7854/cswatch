import { PropertyType } from '@gltf-transform/core';
import { join, prune } from '@gltf-transform/functions';

const hasMetadata = (property) =>
  property.listExtensions().length > 0 || Object.keys(property.getExtras()).length > 0;

/** Join only opaque static siblings. Keep source nodes, transforms and material identities intact. */
export async function batchMapMeshes(document, { cellSize = 64 } = {}) {
  if (!Number.isFinite(cellSize) || cellSize < 8 || cellSize > 256)
    throw new Error('Invalid static mesh cell size');
  const root = document.getRoot(),
    animated = new Set(
      root.listAnimations().flatMap((animation) =>
        animation
          .listChannels()
          .map((channel) => channel.getTargetNode())
          .filter(Boolean),
      ),
    ),
    layouts = new Map(),
    initialPrimitives = root
      .listNodes()
      .reduce((n, node) => n + (node.getMesh()?.listPrimitives().length || 0), 0);
  const inAnimatedBranch = (node) => {
    for (let current = node; current; current = current.getParentNode())
      if (animated.has(current)) return true;
    return false;
  };
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(),
      primitive = mesh?.listPrimitives()[0];
    if (
      !mesh ||
      mesh.listPrimitives().length !== 1 ||
      !primitive ||
      node.getSkin() ||
      node.getCamera() ||
      hasMetadata(node) ||
      hasMetadata(mesh) ||
      hasMetadata(primitive) ||
      inAnimatedBranch(node) ||
      primitive.listTargets().length ||
      primitive.getMode() !== 4 ||
      primitive.getMaterial()?.getAlphaMode() === 'BLEND'
    )
      continue;
    if (primitive.listSemantics().some((semantic) => /^(JOINTS|WEIGHTS)_/.test(semantic))) continue;
    const position = primitive.getAttribute('POSITION');
    if (
      !position ||
      ['POSITION', 'NORMAL', 'TANGENT'].some((semantic) => {
        const accessor = primitive.getAttribute(semantic);
        return accessor && (accessor.getComponentType() !== 5126 || accessor.getNormalized());
      })
    )
      continue;
    const matrix = node.getWorldMatrix(),
      min = position.getMin([]),
      max = position.getMax([]),
      center = min.map((value, i) => (value + max[i]) / 2),
      worldCenter = [0, 1, 2].map(
        (axis) =>
          matrix[axis] * center[0] +
          matrix[4 + axis] * center[1] +
          matrix[8 + axis] * center[2] +
          matrix[12 + axis],
      );
    if (!worldCenter.every(Number.isFinite)) continue;
    // Spatial cells retain useful frustum culling instead of one map-wide mesh per material.
    // The upstream join key omits normalized; include it here to prevent integer-layout aliases.
    const key = JSON.stringify([
      worldCenter.map((value) => Math.floor(value / cellSize)),
      // Preserve authored tangent handedness and nonuniform/negative bases. Relative node
      // transforms within a group are translation-only, rather than re-baking arbitrary bases.
      node.getMatrix().filter((_, index) => [0, 1, 2, 4, 5, 6, 8, 9, 10].includes(index)),
      primitive
        .listSemantics()
        .sort()
        .map((semantic) => {
          const a = primitive.getAttribute(semantic);
          return [semantic, a.getType(), a.getComponentType(), a.getNormalized()];
        }),
    ]);
    let nodes = layouts.get(key);
    if (!nodes) layouts.set(key, (nodes = new Set()));
    nodes.add(node);
  }
  for (const nodes of layouts.values())
    if (nodes.size > 1)
      await document.transform(
        join({ keepNamed: false, cleanup: false, filter: (node) => nodes.has(node) }),
      );
  // join(cleanup:false) intentionally retains named nodes and sky hierarchy. Detach only emptied
  // meshes, then release orphan geometry; a broad prune would delete authored empty nodes.
  for (const node of root.listNodes())
    if (node.getMesh()?.listPrimitives().length === 0) node.setMesh(null);
  await document.transform(
    prune({
      propertyTypes: [PropertyType.MESH, PropertyType.PRIMITIVE, PropertyType.ACCESSOR],
      keepAttributes: true,
      keepIndices: true,
    }),
  );
  const finalPrimitives = root
    .listNodes()
    .reduce((n, node) => n + (node.getMesh()?.listPrimitives().length || 0), 0);
  return { schemaVersion: 1, cellSize, initialPrimitives, finalPrimitives };
}
