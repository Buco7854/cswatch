import { Data3DTexture, LinearFilter, RepeatWrapping, RGBAFormat } from 'three';

const SIZE = 32;
let baked: Uint8Array | undefined;

/** Cache three periodic displacement axes in RGB and finer edge detail in A. */
function bakeNoise() {
  let seed = 20631;
  const octave = (cells: number) => {
    const values = Float32Array.from({ length: cells ** 3 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) / 16777216;
    });
    const at = (x: number, y: number, z: number) =>
      values[(x % cells) + cells * ((y % cells) + cells * (z % cells))];
    const ease = (t: number) => t * t * (3 - 2 * t);
    const mix = (a: number, b: number, t: number) => a + (b - a) * t;
    return (x: number, y: number, z: number) => {
      const px = ((x + 0.5) * cells) / SIZE;
      const py = ((y + 0.5) * cells) / SIZE;
      const pz = ((z + 0.5) * cells) / SIZE;
      const ix = Math.floor(px),
        iy = Math.floor(py),
        iz = Math.floor(pz);
      const u = ease(px - ix),
        v = ease(py - iy),
        w = ease(pz - iz);
      const row = (y: number, z: number) => mix(at(ix, y, z), at(ix + 1, y, z), u);
      return mix(
        mix(row(iy, iz), row(iy + 1, iz), v),
        mix(row(iy, iz + 1), row(iy + 1, iz + 1), v),
        w,
      );
    };
  };
  const coarse = [octave(4), octave(4), octave(4)],
    medium = octave(8),
    fine = octave(16);
  const bytes = new Uint8Array(SIZE ** 3 * 4);
  let i = 0;
  for (let z = 0; z < SIZE; z++)
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        for (const axis of coarse) bytes[i++] = Math.round(255 * axis(x, y, z));
        bytes[i++] = Math.round(255 * (0.65 * medium(x, y, z) + 0.35 * fine(x, y, z)));
      }
  return bytes;
}

export function smokeNoise() {
  const texture = new Data3DTexture((baked ??= bakeNoise()), SIZE, SIZE, SIZE);
  texture.format = RGBAFormat;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
