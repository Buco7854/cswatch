// Repeated placements of the same local geometry are stored once and drawn instanced, like
// ValveResourceFormat 21.1's SceneAggregate (MIT): each instance carries its transform, tint and
// alpha, cubemap and light probe volume. Lightmap coordinates belong to the shared vertices.
import { createHash } from 'node:crypto';
import { stride } from './geometry.mjs';

/** Bytes per instance record: a 3x4 row-major transform, lighting indices, tint, two zero words. */
export const instanceBytes = 64;

// Per-vertex bytes that vary per placement: cubemap (50), probe volume (54) and tint (56).
const placementBytes = [50, 51, 54, 55, 56, 57, 58, 59];

/** A key shared by ranges whose local geometry, material and draw state are identical. */
export function instanceKey(range) {
  if (range.entityIndex >= 0 || (range.family !== 'opaque' && range.family !== 'cutout'))
    return null;
  const shared = Buffer.from(range.v);
  for (let o = 0; o < shared.length; o += stride) for (const b of placementBytes) shared[o + b] = 0;
  return createHash('sha256')
    .update([range.mat, range.family, range.side, range.sky].join('/'))
    .update(shared)
    .update(range.indices)
    .digest('hex');
}

/** The per-placement inputs of a range: cubemap, baked flag, probe volume and packed tint. */
export function placementAttributes(v) {
  return [v.readUInt16LE(50), v[52], v.readUInt16LE(54), v.readUInt32LE(56)];
}

/** Writes one instance: transform rows from a column-major placement, then lighting and tint. */
export function writeInstance(table, index, placement, attributes) {
  const o = index * instanceBytes;
  const m = placement ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 4; column++)
      table.writeFloatLE(m[column * 4 + row], o + (row * 4 + column) * 4);
  table.writeUInt32LE((attributes[0] | (attributes[2] << 16)) >>> 0, o + 48);
  table.writeUInt32LE(attributes[3], o + 52);
}
