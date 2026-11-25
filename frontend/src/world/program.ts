export function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw Error(gl.getShaderInfoLog(sh) ?? 'Shader compilation failed');
    gl.attachShader(p, sh);
    gl.deleteShader(sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw Error(gl.getProgramInfoLog(p) ?? 'Shader link failed');
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  return {
    use: () => gl.useProgram(p),
    u: (k: string) => {
      if (!uniforms.has(k)) uniforms.set(k, gl.getUniformLocation(p, k));
      return uniforms.get(k)!;
    },
  };
}
