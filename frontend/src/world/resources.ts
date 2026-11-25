/** Own raw GL allocations independently of three.js's managed scene resources. */
export function worldResources(gl: WebGL2RenderingContext) {
  const cleanup: (() => void)[] = [];
  return {
    retain(release: () => void) {
      cleanup.push(release);
    },
    texture() {
      const texture = gl.createTexture();
      cleanup.push(() => gl.deleteTexture(texture));
      return texture;
    },
    buffer() {
      const buffer = gl.createBuffer();
      cleanup.push(() => gl.deleteBuffer(buffer));
      return buffer;
    },
    dispose() {
      for (const release of cleanup.splice(0).reverse()) release();
    },
  };
}
