import { Data3DTexture, LinearFilter, RedFormat, RepeatWrapping } from 'three';

/** Cellular noise period, in feature cells per axis, and texels per axis. */
export const WORLEY_CELLS = 4;
const SIZE = 32;
let baked: Uint8Array | undefined;

/** The CS2 smoke shader erodes its density with two octaves of F1 cellular
 * noise (squared distance to the nearest feature point). Bake one periodic
 * octave once; the shader samples it at both of its scales. */
function bakeWorley() {
  let seed = 20631;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) / 16777216;
  };
  const cells = WORLEY_CELLS;
  const points = Float32Array.from({ length: cells ** 3 * 3 }, random);
  const bytes = new Uint8Array(SIZE ** 3);
  const texel = cells / SIZE;
  let i = 0;
  for (let z = 0; z < SIZE; z++)
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const p = [(x + 0.5) * texel, (y + 0.5) * texel, (z + 0.5) * texel];
        const base = p.map(Math.floor);
        let nearest = 1;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const c = [base[0] + dx, base[1] + dy, base[2] + dz];
              const w = c.map((v) => ((v % cells) + cells) % cells);
              const k = 3 * (w[0] + cells * (w[1] + cells * w[2]));
              const ox = c[0] + points[k] - p[0],
                oy = c[1] + points[k + 1] - p[1],
                oz = c[2] + points[k + 2] - p[2];
              nearest = Math.min(nearest, ox * ox + oy * oy + oz * oz);
            }
        bytes[i++] = Math.round(255 * Math.min(1, nearest));
      }
  return bytes;
}

export function smokeNoise() {
  const texture = new Data3DTexture((baked ??= bakeWorley()), SIZE, SIZE, SIZE);
  texture.format = RedFormat;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Trilinear, repeating CPU sample of the baked octave at texture coordinates. */
export function worleyAt(u: number, v: number, w: number) {
  const data = (baked ??= bakeWorley());
  const coordinate = (value: number) => {
    const p = (value - Math.floor(value)) * SIZE - 0.5;
    const i = Math.floor(p);
    return [((i % SIZE) + SIZE) % SIZE, (i + 1) % SIZE, p - i] as const;
  };
  const [x0, x1, fx] = coordinate(u),
    [y0, y1, fy] = coordinate(v),
    [z0, z1, fz] = coordinate(w);
  const at = (x: number, y: number, z: number) => data[x + SIZE * (y + SIZE * z)];
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  const plane = (z: number) =>
    lerp(lerp(at(x0, y0, z), at(x1, y0, z), fx), lerp(at(x0, y1, z), at(x1, y1, z), fx), fy);
  return lerp(plane(z0), plane(z1), fz) / 255;
}
