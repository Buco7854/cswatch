// Original positions have already been transformed to world metres and aligned.
import { compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Pin a coordinate when two separately drawn spatial or material batches share it. */
export function compactBoundaryLocks(batches) {
  const combined = new Float32Array(batches.reduce((sum, batch) => sum + batch.length, 0));
  let offset = 0;
  for (const batch of batches) {
    combined.set(batch, offset);
    offset += batch.length;
  }
  const representative = MeshoptSimplifier.generatePositionRemap(combined, 3);
  const owner = new Uint16Array(representative.length);
  const shared = new Uint8Array(representative.length);
  offset = 0;
  for (const [index, batch] of batches.entries()) {
    const end = offset + batch.length / 3;
    for (; offset < end; offset++) {
      const key = representative[offset];
      if (!owner[key]) owner[key] = index + 1;
      else if (owner[key] !== index + 1) shared[key] = 1;
    }
  }
  offset = 0;
  return batches.map((batch) => {
    const locks = new Uint8Array(batch.length / 3);
    for (let index = 0; index < locks.length; index++)
      locks[index] = shared[representative[offset++]];
    return locks;
  });
}

/** Keep shared positions fixed, while isolated edges may simplify within the shape error bound. */
export function simplifyCompactBoundaries(document, ratio) {
  const primitives = document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives());
  const positions = primitives.map((p) => p.getAttribute('POSITION').getArray());
  const locks = compactBoundaryLocks(positions);
  for (const [index, primitive] of primitives.entries()) {
    const indices = primitive.getIndices().getArray();
    const colors = Float32Array.from(primitive.getAttribute('COLOR_0').getArray(), (v) => v / 255);
    const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
    const [reduced] = MeshoptSimplifier.simplifyWithAttributes(
      indices instanceof Uint32Array ? indices : Uint32Array.from(indices),
      positions[index],
      3,
      colors,
      3,
      [0.1, 0.1, 0.1],
      locks[index],
      target,
      0.004,
    );
    // Preserve every populated cell, including isolated triangles in small batches.
    if (!reduced.length) continue;
    const previous = primitive.getIndices();
    primitive.setIndices(previous.clone().setArray(reduced));
    if (previous.listParents().length === 1) previous.dispose();
    compactPrimitive(primitive);
  }
}
