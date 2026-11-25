import type { Mip } from './format';
export function capabilities(gl: WebGL2RenderingContext) {
  if (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) < 27)
    throw Error('World lab requires 27 fragment texture units');
  const required = [
    'EXT_texture_compression_bptc',
    'EXT_texture_compression_rgtc',
    'WEBGL_compressed_texture_s3tc',
    'WEBGL_compressed_texture_s3tc_srgb',
    'EXT_color_buffer_half_float',
  ];
  const missing = required.filter((k) => !gl.getExtension(k));
  if (missing.length) throw Error('Missing WebGL2 extensions: ' + missing.join(', '));
}
export function textureArray(
  gl: WebGL2RenderingContext,
  fmt: string,
  srgb: boolean,
  levels: Mip[],
  depth: number,
  flags: number,
  data: Uint8Array<ArrayBuffer>,
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
  const format = formats[fmt];
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
  for (const l of levels) {
    const bytes = data.subarray(l.offset, l.offset + l.size);
    if (fmt === 'RGBA16161616F')
      gl.texSubImage3D(
        target,
        l.level,
        0,
        0,
        0,
        l.w,
        l.h,
        l.d ?? depth,
        gl.RGBA,
        gl.HALF_FLOAT,
        new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2),
      );
    else if (fmt === 'RGBA8888')
      gl.texSubImage3D(
        target,
        l.level,
        0,
        0,
        0,
        l.w,
        l.h,
        l.d ?? depth,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes,
      );
    else
      gl.compressedTexSubImage3D(target, l.level, 0, 0, 0, l.w, l.h, l.d ?? depth, format, bytes);
    const error = gl.getError();
    if (error)
      throw Error(
        `Texture upload failed: ${fmt} ${top.w}×${top.h}×${depth} mip ${l.level}, GL 0x${error.toString(16)}`,
      );
  }
  return tex;
}
