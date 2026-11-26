import { Matrix3, Matrix4 } from 'three';
import { MeshoptDecoder } from 'meshoptimizer';
import { trianglePredictors, predictWords } from './mesh-prediction.mjs';
import type { Manifest, Range } from './format';

export function decodeVertices(manifest: Manifest, compressed: Uint8Array, indices: Uint32Array) {
  // Material and probe metadata are constant per range on disk. Expand once here so
  // WEBGL_multi_draw can submit ranges from different cells with a single VAO.
  const output = new Uint8Array(manifest.geometry.vertices * 60);
  const floats = new Float32Array(output.buffer),
    signed = new Int8Array(output.buffer),
    shorts = new Uint16Array(output.buffer),
    words = new Uint32Array(output.buffer);
  let vertex = 0;
  // An instanced mesh is decoded once, at its first range; its other ranges reuse it.
  const decoded = new Set<number>();
  function decode(
    stream: Range['streams'][number],
    count: number,
    stride: number,
    predictors: Int32Array,
  ) {
    if (!stream) return null;
    const bytes = new Uint8Array(count * stride);
    MeshoptDecoder.decodeVertexBuffer(
      bytes,
      count,
      stride,
      compressed.subarray(stream[0], stream[0] + stream[1]),
    );
    if (stream[2]) {
      const words = stream[2] === 2 ? new Uint16Array(bytes.buffer) : bytes;
      predictWords(words, stride / words.BYTES_PER_ELEMENT, predictors, false);
    }
    return bytes;
  }
  function direction(bytes: Int8Array, index: number, offset: number, rotation: number[] | null) {
    let x = bytes[index] / 127,
      y = bytes[index + 1] / 127;
    let z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const oldX = x;
      x = Math.sign(x || 1) * (1 - Math.abs(y));
      y = Math.sign(y || 1) * (1 - Math.abs(oldX));
    }
    if (rotation) {
      const rx = rotation[0] * x + rotation[3] * y + rotation[6] * z;
      const ry = rotation[1] * x + rotation[4] * y + rotation[7] * z;
      z = rotation[2] * x + rotation[5] * y + rotation[8] * z;
      x = rx;
      y = ry;
    }
    const scale = 127 / Math.hypot(x, y, z);
    signed[offset] = Math.round(x * scale);
    signed[offset + 1] = Math.round(y * scale);
    signed[offset + 2] = Math.round(z * scale);
  }
  for (const chunk of manifest.chunks)
    for (const range of chunk.ranges) {
      if (decoded.has(range.first)) continue;
      decoded.add(range.first);
      const { vertices: count, streams, attributes, positionGrid, uvBounds } = range;
      const placement = range.placement;
      const matrix = placement ? new Matrix4().fromArray(placement) : null;
      const normalRotation = matrix ? new Matrix3().getNormalMatrix(matrix).elements : null;
      const tangentRotation = matrix ? new Matrix3().setFromMatrix4(matrix).elements : null;
      const predictors = trianglePredictors(
        indices.subarray(range.first, range.first + range.count),
        count,
        vertex,
      );
      const buffers = streams.map((s, i) => decode(s, count, [8, 4, 4, 4, 4, 4, 8][i], predictors));
      const positions = new Uint16Array(buffers[0]!.buffer),
        frames = new Int8Array(buffers[1]!.buffer),
        uv = new Uint16Array(buffers[2]!.buffer);
      const lanes = buffers.slice(3).map((bytes) => bytes && new Uint32Array(bytes.buffer));
      for (let local = 0; local < count; local++, vertex++) {
        const offset = vertex * 60;
        for (let axis = 0; axis < 3; axis++)
          floats[offset / 4 + axis] =
            positionGrid[axis] + positions[local * 4 + axis] * positionGrid[axis + 3];
        if (placement) {
          const [x, y, z] = [floats[offset / 4], floats[offset / 4 + 1], floats[offset / 4 + 2]];
          for (let a = 0; a < 3; a++)
            floats[offset / 4 + a] =
              placement[a] * x + placement[4 + a] * y + placement[8 + a] * z + placement[12 + a];
        }
        direction(frames, local * 4, offset + 12, normalRotation);
        direction(frames, local * 4 + 2, offset + 16, tangentRotation);
        output[offset + 19] = buffers[0]![local * 8 + 6];
        for (let axis = 0; axis < 2; axis++)
          floats[offset / 4 + 5 + axis] =
            uvBounds[axis] + uv[local * 2 + axis] * uvBounds[axis + 2];
        words[offset / 4 + 7] = lanes[0]?.[local] ?? 0;
        words[offset / 4 + 8] = lanes[1]?.[local] ?? 0xffffffff;
        words[offset / 4 + 9] = lanes[2]?.[local] ?? 0;
        words[offset / 4 + 10] = lanes[3]?.[local * 2] ?? 0;
        words[offset / 4 + 11] = lanes[3]?.[local * 2 + 1] ?? 0;
        shorts[offset / 2 + 24] = range.material;
        shorts[offset / 2 + 25] = attributes[0];
        output[offset + 52] = attributes[1];
        shorts[offset / 2 + 27] = attributes[2];
        words[offset / 4 + 14] = attributes[3];
      }
    }
  return output;
}

/** Each stored mesh's first decoded vertex, keyed by its first index. */
export function meshBases(manifest: Manifest) {
  const bases = new Map<number, number>();
  let vertex = 0;
  for (const chunk of manifest.chunks)
    for (const range of chunk.ranges)
      if (!bases.has(range.first)) {
        bases.set(range.first, vertex);
        vertex += range.vertices;
      }
  return bases;
}
