import type { Mip } from './format';
export type TextureTier = 'desktop' | 'phone';
// Fixed lighting samplers per world draw. Chrome reports 16 fragment units on ANGLE/D3D11 and
// Metal, so a tier needs room for six material roles; heavier materials drop their least
// important roles when the device has fewer units than they use.
export const fixedUnits: Record<TextureTier, number> = { desktop: 10, phone: 7 };
export const minimumRoles = 6;
export const tierUnits: Record<TextureTier, number> = {
  desktop: fixedUnits.desktop + minimumRoles,
  phone: fixedUnits.phone + minimumRoles,
};
const tierExtensions: Record<TextureTier, string[]> = {
  desktop: [
    'EXT_texture_compression_bptc',
    'EXT_texture_compression_rgtc',
    'WEBGL_compressed_texture_s3tc',
    'WEBGL_compressed_texture_s3tc_srgb',
  ],
  phone: ['WEBGL_compressed_texture_astc'],
};
function supports(gl: WebGL2RenderingContext, tier: TextureTier) {
  return (
    (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number) >= tierUnits[tier] &&
    Boolean(gl.getExtension('EXT_color_buffer_half_float')) &&
    tierExtensions[tier].every((name) => gl.getExtension(name))
  );
}
/** BC blocks select the desktop set, ASTC LDR the phone set. Without either, show the 2D map. */
export function textureTier(gl: WebGL2RenderingContext): TextureTier | null {
  return supports(gl, 'desktop') ? 'desktop' : supports(gl, 'phone') ? 'phone' : null;
}
let probed: TextureTier | null | undefined;
let probedOnce = false;
/** Device tier from a throwaway WebGL2 context. Undefined means WebGL2 itself is unavailable. */
export function deviceTextureTier() {
  if (probedOnce) return probed;
  probedOnce = true;
  const gl = document.createElement('canvas').getContext('webgl2');
  probed = gl ? textureTier(gl) : undefined;
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return probed;
}
export function capabilities(gl: WebGL2RenderingContext, forced?: TextureTier) {
  const tier = forced ?? textureTier(gl);
  if (!tier || !supports(gl, tier))
    throw Error('This device lacks the compressed texture support needed for the 3D map');
  return tier;
}
const astc: Record<string, number> = { '4x4': 0x93b0, '5x5': 0x93b2, '6x6': 0x93b4, '8x8': 0x93b7 };
export function blockShape(format: string) {
  const match = /^ASTC(\d)x(\d)$/.exec(format);
  if (match) return { w: Number(match[1]), h: Number(match[2]), bytes: 16 };
  if (format === 'RGBA16161616F') return { w: 1, h: 1, bytes: 8 };
  if (format === 'RGBA8888') return { w: 1, h: 1, bytes: 4 };
  return { w: 4, h: 4, bytes: format === 'DXT1' || format === 'ATI1N' ? 8 : 16 };
}
export function allocateTexture(
  gl: WebGL2RenderingContext,
  fmt: string,
  srgb: boolean,
  levels: Mip[],
  depth: number,
  flags: number,
) {
  const formats: Record<string, number> = {
    DXT1: srgb ? 0x8c4d : 0x83f1,
    DXT5: srgb ? 0x8c4f : 0x83f3,
    ATI1N: 0x8dbb,
    ATI2N: 0x8dbd,
    BC7: srgb ? 0x8e8d : 0x8e8c,
    BC6H: 0x8e8f,
    RGBA16161616F: gl.RGBA16F,
    RGBA8888: srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8,
  };
  const astcBlock = /^ASTC(\dx\d)$/.exec(fmt)?.[1];
  // sRGB ASTC enums sit 0x20 above their linear counterparts.
  const format = astcBlock ? astc[astcBlock] + (srgb ? 0x20 : 0) : formats[fmt];
  if (!format) throw Error('Unsupported texture format ' + fmt);
  const top = levels.at(-1)!,
    target = flags & 32 && fmt === 'RGBA8888' ? gl.TEXTURE_3D : gl.TEXTURE_2D_ARRAY;
  const tex = gl.createTexture();
  gl.bindTexture(target, tex);
  gl.texStorage3D(target, levels.length, format, top.w, top.h, depth);
  gl.texParameteri(
    target,
    gl.TEXTURE_MIN_FILTER,
    levels.length > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
  );
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, flags & 1 ? gl.CLAMP_TO_EDGE : gl.REPEAT);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, flags & 2 ? gl.CLAMP_TO_EDGE : gl.REPEAT);
  gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, levels.length - 1);
  gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, levels.length - 1);
  const block = blockShape(fmt);
  const compressed = block.w > 1;
  function* slices(mip: Mip, data: Uint8Array<ArrayBuffer>, budget: number) {
    const rows = Math.ceil(mip.h / block.h);
    const rowBytes = Math.ceil(mip.w / block.w) * block.bytes;
    const layerBytes = rowBytes * rows;
    const layers = mip.d ?? depth;
    const layersPerSlice = Math.max(1, Math.floor(budget / layerBytes));
    const rowsPerSlice = Math.max(1, Math.floor(budget / rowBytes));
    for (let layer = 0; layer < layers; layer += layersPerSlice) {
      const layerCount = Math.min(layersPerSlice, layers - layer);
      for (let row = 0; row < rows; row += rowsPerSlice) {
        const count = Math.min(rows - row, rowsPerSlice),
          size = count * rowBytes * layerCount;
        const offset = mip.offset + layer * layerBytes + row * rowBytes;
        const y = row * block.h,
          height = Math.min(mip.h - y, count * block.h);
        const z = layer,
          last = layer + layerCount === layers && row + count === rows;
        yield {
          bytes: size,
          write() {
            const bytes = data.subarray(offset, offset + size);
            gl.bindTexture(target, tex);
            if (compressed)
              gl.compressedTexSubImage3D(
                target,
                mip.level,
                0,
                y,
                z,
                mip.w,
                height,
                layerCount,
                format,
                bytes,
              );
            else if (fmt === 'RGBA16161616F')
              gl.texSubImage3D(
                target,
                mip.level,
                0,
                y,
                z,
                mip.w,
                height,
                layerCount,
                gl.RGBA,
                gl.HALF_FLOAT,
                new Uint16Array(bytes.buffer, bytes.byteOffset, size / 2),
              );
            else
              gl.texSubImage3D(
                target,
                mip.level,
                0,
                y,
                z,
                mip.w,
                height,
                layerCount,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                bytes,
              );
            if (!last) return;
            gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, mip.level);
            // getError waits for the GPU process; check once per completed level.
            const error = gl.getError();
            if (error)
              throw Error(
                `Texture upload failed: ${fmt} ${mip.w}×${mip.h} mip ${mip.level}, GL 0x${error.toString(16)}`,
              );
          },
        };
      }
    }
  }
  return { texture: tex, slices };
}
