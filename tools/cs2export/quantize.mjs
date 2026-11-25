// Each range has its own quantization bounds. Meshoptimizer streams can be shared by
// repeated placements even when the placement's material, tint or lighting differs.
import { trianglePredictors, predictWords } from '../../frontend/src/world/mesh-prediction.mjs';
import { createHash } from 'node:crypto';
import { MeshoptEncoder } from '../../frontend/node_modules/meshoptimizer/meshopt_encoder.js';

import { MeshoptDecoder } from '../../frontend/node_modules/meshoptimizer/meshopt_decoder.mjs';
await MeshoptDecoder.ready;
function octahedron(output, offset, x, y, z) {
  const divisor = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  const u = x / divisor,
    v = y / divisor;
  output.writeInt8(Math.round(127 * (z < 0 ? Math.sign(u || 1) * (1 - Math.abs(v)) : u)), offset);
  output.writeInt8(
    Math.round(127 * (z < 0 ? Math.sign(v || 1) * (1 - Math.abs(u)) : v)),
    offset + 1,
  );
}

export function vertexArchive() {
  const offsets = new Map(),
    buffers = [];
  let length = 0;
  function append(bytes, count, stride, predictors, wide) {
    const direct = MeshoptEncoder.encodeVertexBufferLevel(bytes, count, stride, 2);
    let payload = direct,
      mode = 0;
    if (predictors) {
      const copy = new Uint8Array(bytes);
      const words = wide ? new Uint16Array(copy.buffer) : copy;
      predictWords(words, stride / words.BYTES_PER_ELEMENT, predictors, true);
      const predicted = MeshoptEncoder.encodeVertexBufferLevel(copy, count, stride, 2);
      if (predicted.length < direct.length) {
        payload = predicted;
        mode = wide ? 2 : 1;
      }
    }
    const check = new Uint8Array(count * stride);
    MeshoptDecoder.decodeVertexBuffer(check, count, stride, payload);
    if (mode) {
      const w = wide ? new Uint16Array(check.buffer) : check;
      predictWords(w, stride / w.BYTES_PER_ELEMENT, predictors, false);
    }
    if (!Buffer.from(check).equals(bytes))
      throw Error('Meshoptimizer stream failed lossless round trip');
    const hash = createHash('sha256').update(payload).digest('hex');
    if (!offsets.has(hash)) {
      offsets.set(hash, [length, payload.length]);
      buffers.push(payload);
      length += payload.length;
    }
    return [...offsets.get(hash), mode];
  }
  return {
    encode(range, material) {
      const vertices = range.v,
        count = vertices.length / 60;
      const position = Buffer.alloc(count * 8),
        frame = Buffer.alloc(count * 4),
        uv = Buffer.alloc(count * 4);
      const uvBounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++)
        for (let axis = 0; axis < 2; axis++) {
          const value = vertices.readFloatLE(i * 60 + 20 + axis * 4);
          uvBounds[axis] = Math.min(uvBounds[axis], value);
          uvBounds[axis + 2] = Math.max(uvBounds[axis + 2], value);
        }
      // A binary grid preserves common coplanar surfaces across neighboring ranges.
      function grid(bounds, axes, minStep) {
        const low = [],
          step = [];
        for (let axis = 0; axis < axes; axis++) {
          let spacing = Math.max(
            minStep,
            2 ** Math.ceil(Math.log2((bounds[axes + axis] - bounds[axis]) / 65534)),
          );
          low.push(Math.floor(bounds[axis] / spacing) * spacing);
          step.push(spacing);
        }
        return [...low, ...step];
      }
      const positionGrid = grid(range.localBounds, 3, 1 / 32);
      const uvGrid = grid(uvBounds, 2, 1 / 4096);
      const predictors = trianglePredictors(
        new Uint32Array(range.indices.buffer, range.indices.byteOffset, range.indices.length / 4),
        count,
      );

      const optional = [
        [28, Boolean(vertices[52])],
        [32, material.ints.F_VERTEX_COLOR || material.shader === 'csgo_effects.vfx'],
        [36, !!material.bindings.color2],
        [40, material.ints.F_FORCE_UV2 || material.ints.g_nUVSet1 > 1],
      ].map(([offset, used]) =>
        used ? { offset, bytes: Buffer.alloc(count * (offset === 40 ? 8 : 4)) } : null,
      );
      for (let i = 0; i < count; i++) {
        const base = i * 60;
        for (let axis = 0; axis < 3; axis++)
          position.writeUInt16LE(
            Math.round(
              (vertices.readFloatLE(base + axis * 4) - positionGrid[axis]) / positionGrid[axis + 3],
            ),
            i * 8 + axis * 2,
          );
        position[i * 8 + 6] = vertices[base + 19];
        for (let axis = 0; axis < 2; axis++)
          uv.writeUInt16LE(
            Math.round(
              (vertices.readFloatLE(base + 20 + axis * 4) - uvGrid[axis]) / uvGrid[axis + 2],
            ),
            i * 4 + axis * 2,
          );
        for (const [source, destination] of [
          [12, 0],
          [16, 2],
        ])
          octahedron(
            frame,
            i * 4 + destination,
            vertices.readInt8(base + source),
            vertices.readInt8(base + source + 1),
            vertices.readInt8(base + source + 2),
          );
        for (const lane of optional)
          if (lane) {
            const size = lane.bytes.length / count;
            vertices.copy(lane.bytes, i * size, base + lane.offset, base + lane.offset + size);
          }
      }
      return {
        placement: range.placement,
        vertices: count,
        uvBounds: uvGrid,
        positionGrid,
        streams: [
          append(position, count, 8, predictors, true),
          append(frame, count, 4, predictors, false),
          append(uv, count, 4, predictors, true),
          ...optional.map((lane) =>
            lane
              ? append(
                  lane.bytes,
                  count,
                  lane.bytes.length / count,
                  lane.offset === 28 ? predictors : null,
                  true,
                )
              : null,
          ),
        ],
        attributes: [
          vertices.readUInt16LE(50),
          vertices[52],
          vertices.readUInt16LE(54),
          vertices.readUInt32LE(56),
        ],
      };
    },
    finish: () => Buffer.concat(buffers),
  };
}
