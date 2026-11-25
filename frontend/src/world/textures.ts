import type { Mip } from './format';
export function capabilities(gl: WebGL2RenderingContext) {
  if (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) < 28)
    throw Error('World lab requires 28 fragment texture units');
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
  gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, levels.length - 1);
  const blockPixels = fmt === 'RGBA16161616F' || fmt === 'RGBA8888' ? 1 : 4;
  const blockBytes =
    ({ DXT1: 8, ATI1N: 8, RGBA16161616F: 8, RGBA8888: 4 } as Record<string, number>)[fmt] ?? 16;
  function* slices(mip: Mip, data: Uint8Array<ArrayBuffer>, budget: number) {
    const rows = Math.ceil(mip.h / blockPixels);
    const rowBytes = Math.ceil(mip.w / blockPixels) * blockBytes;
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
        const y = row * blockPixels,
          height = Math.min(mip.h - y, count * blockPixels);
        const z = layer,
          last = layer + layerCount === layers && row + count === rows;
        yield {
          bytes: size,
          write() {
            const bytes = data.subarray(offset, offset + size);
            gl.bindTexture(target, tex);
            if (blockPixels === 4)
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
            if (last) gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, mip.level);
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
