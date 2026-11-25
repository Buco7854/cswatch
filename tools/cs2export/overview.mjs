// Top-down radar artwork for maps whose game files lack an official overview. The image uses
// Valve's overview contract: a 1024-pixel reference, pos_x/pos_y at the top-left corner in world
// units and scale in world units per pixel.
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const anchors = new Set([
  'info_player_terrorist',
  'info_player_counterterrorist',
  'info_deathmatch_spawn',
  'info_armsrace_counterterrorist',
  'info_armsrace_terrorist',
  'info_hostage_spawn',
  'func_bomb_target',
  'func_buyzone',
  'func_hostage_rescue',
]);
const vec = (v) => (typeof v === 'string' ? v.trim().split(/\s+/).map(Number) : v);

/** Parses the three calibration fields of a Valve overview text. */
export function overviewCalibration(text) {
  const field = (name) => Number(new RegExp(`"?${name}"?\\s+"?(-?[\\d.]+)`, 'i').exec(text)?.[1]);
  const [x, y, scale] = ['pos_x', 'pos_y', 'scale'].map(field);
  return [x, y, scale].every(Number.isFinite) && scale > 0 ? { x, y, scale } : undefined;
}

/** Calibration from the map's own spawn, objective and buy-zone entities. */
export function playableCalibration(entities) {
  const points = entities
    .filter((e) => anchors.has(e.classname) && e.origin)
    .map((e) => vec(e.origin))
    .filter((p) => p.length >= 3 && p.every(Number.isFinite));
  if (points.length < 2) return undefined;
  const lo = [0, 1].map((axis) => Math.min(...points.map((p) => p[axis]))),
    hi = [0, 1].map((axis) => Math.max(...points.map((p) => p[axis])));
  const half = (Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 2) * 1.25 + 512;
  const cx = (lo[0] + hi[0]) / 2,
    cy = (lo[1] + hi[1]) / 2;
  return {
    x: Math.round(cx - half),
    y: Math.round(cy + half),
    scale: +((2 * half) / SIZE).toFixed(4),
    ceiling: Math.max(...points.map((p) => p[2])) + 320,
  };
}

/** Rasterizes upward-facing surfaces below the ceiling, shaded by height and slope. */
export function renderOverview(map, ranges, calibration) {
  const raster = overviewRaster(map, calibration);
  for (const range of ranges) raster.add(range);
  return raster.finish();
}

/** The same rasterizer, fed one range at a time. */
export function overviewRaster(map, calibration) {
  const { x: left, y: top, scale } = calibration;
  const ceiling = calibration.ceiling ?? Infinity;
  const height = new Float32Array(SIZE * SIZE).fill(-Infinity);
  const shade = new Float32Array(SIZE * SIZE);
  const light = [0.35, 0.45, 0.82];
  const lightLength = Math.hypot(...light);
  function add(range) {
    if (range.sky || !['opaque', 'cutout', 'water'].includes(range.family)) return;
    const v = range.v,
      indices = range.indices,
      stride = 60;
    // Placed model ranges keep local positions and a column-major placement matrix.
    const m = range.placement;
    const local = (i, c) => v.readFloatLE(i * stride + c * 4);
    const at = m
      ? (i, c) => m[c] * local(i, 0) + m[4 + c] * local(i, 1) + m[8 + c] * local(i, 2) + m[12 + c]
      : local;
    // Indices are little-endian uint32 values.
    for (let t = 0; t + 2 < indices.length / 4; t += 3) {
      const [a, b, c] = [t, t + 1, t + 2].map((k) => indices.readUInt32LE(k * 4));
      const ax = at(a, 0),
        ay = at(a, 1),
        az = at(a, 2);
      const bx = at(b, 0),
        by = at(b, 1),
        bz = at(b, 2);
      const cx = at(c, 0),
        cy = at(c, 1),
        cz = at(c, 2);
      if (Math.max(az, bz, cz) > ceiling) continue;
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az,
        wx = cx - ax,
        wy = cy - ay,
        wz = cz - az;
      const nx = uy * wz - uz * wy,
        ny = uz * wx - ux * wz,
        nz = ux * wy - uy * wx;
      const length = Math.hypot(nx, ny, nz);
      if (!(length > 0) || Math.abs(nz) / length < 0.35) continue;
      const lambert =
        Math.abs(nx * light[0] + ny * light[1] + nz * light[2]) / (length * lightLength);
      const px = [ax, bx, cx].map((x) => (x - left) / scale),
        py = [ay, by, cy].map((y) => (top - y) / scale),
        pz = [az, bz, cz];
      const x0 = Math.max(0, Math.floor(Math.min(...px))),
        x1 = Math.min(SIZE - 1, Math.ceil(Math.max(...px))),
        y0 = Math.max(0, Math.floor(Math.min(...py))),
        y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...py)));
      if (x0 > x1 || y0 > y1) continue;
      const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
      if (Math.abs(area) < 1e-9) {
        // Sub-pixel triangle: record its centre.
        const ix = Math.round((px[0] + px[1] + px[2]) / 3),
          iy = Math.round((py[0] + py[1] + py[2]) / 3);
        const z = (az + bz + cz) / 3;
        if (ix >= 0 && iy >= 0 && ix < SIZE && iy < SIZE && z > height[iy * SIZE + ix]) {
          height[iy * SIZE + ix] = z;
          shade[iy * SIZE + ix] = lambert;
        }
        continue;
      }
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const sx = x + 0.5,
            sy = y + 0.5;
          const w0 = ((px[1] - sx) * (py[2] - sy) - (px[2] - sx) * (py[1] - sy)) / area,
            w1 = ((px[2] - sx) * (py[0] - sy) - (px[0] - sx) * (py[2] - sy)) / area,
            w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * pz[0] + w1 * pz[1] + w2 * pz[2],
            index = y * SIZE + x;
          if (z > height[index]) {
            height[index] = z;
            shade[index] = lambert;
          }
        }
    }
  }
  function finish() {
    let lo = Infinity,
      hi = -Infinity;
    for (const z of height) if (z > -Infinity) ((lo = Math.min(lo, z)), (hi = Math.max(hi, z)));
    if (!(hi >= lo)) return undefined;
    const rgba = Buffer.alloc(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const index = y * SIZE + x,
          z = height[index];
        if (z === -Infinity) continue;
        const t = hi > lo ? (z - lo) / (hi - lo) : 0.5;
        // Steps in height outline walls and ledges.
        let edge = 1;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ]) {
          const n = height[(y + dy) * SIZE + x + dx];
          if (x + dx < 0 || y + dy < 0 || x + dx >= SIZE || y + dy >= SIZE) continue;
          if (n === -Infinity || Math.abs(n - z) > 48) edge = 0.6;
        }
        const tone = (0.55 + 0.45 * shade[index]) * edge;
        const base = [58 + 150 * t, 72 + 140 * t, 76 + 128 * t];
        base.forEach((value, channel) => (rgba[index * 4 + channel] = Math.min(255, value * tone)));
        rgba[index * 4 + 3] = 255;
      }
    const text = `"${map}"\n{\n\t"pos_x"\t\t"${calibration.x}"\n\t"pos_y"\t\t"${calibration.y}"\n\t"scale"\t\t"${calibration.scale}"\n}\n`;
    return { png: encodePng(rgba, SIZE, SIZE), text };
  }
  return { add, finish };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
