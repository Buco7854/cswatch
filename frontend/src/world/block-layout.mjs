// Transpose the bytes of adjacent BC blocks so repeated endpoints and index lanes
// can share a deflate dictionary. The GPU receives the original blocks verbatim.
export function transposeBlocks(input, stride, unpack) {
  const result = new Uint8Array(input.length);
  for (let start = 0; start < input.length; start += 4096 * stride) {
    const blocks = Math.min(4096, (input.length - start) / stride);
    for (let lane = 0; lane < stride; lane++) {
      for (let block = 0; block < blocks; block++) {
        const linear = start + block * stride + lane;
        const planar = start + lane * blocks + block;
        if (unpack) result[linear] = input[planar];
        else result[planar] = input[linear];
      }
    }
  }
  return result;
}
