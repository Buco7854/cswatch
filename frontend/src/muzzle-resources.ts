import {
  DoubleSide,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
} from 'three';

/** Every instance owns these small procedural resources. They are deliberately
 * separate from cached GLB geometry/materials and need explicit disposal because
 * the cloned model ancestry disables Fiber's recursive disposal. */
export function createMuzzleResources() {
  const flame = new PlaneGeometry(0.18, 0.18),
    core = new SphereGeometry(1, 6, 4),
    outer = new ShaderMaterial({
      uniforms: { strength: { value: 0 }, variant: { value: 0 } },
      vertexShader: `
        varying vec2 flameUv;
        void main() {
          flameUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      // Original procedural flame, with soft irregular lobes rather than a
      // hard star polygon. This remains an analytical effect, not game art.
      fragmentShader: `
        varying vec2 flameUv;
        uniform float strength;
        uniform float variant;
        void main() {
          vec2 point = (flameUv - 0.5) * 2.0;
          float radius = length(point);
          float angle = atan(point.y, point.x);
          float boundary = 0.63 + sin(angle * 5.0 + variant) * 0.11
            + cos(angle * 9.0 - variant) * 0.06;
          float body = 1.0 - smoothstep(boundary * 0.18, boundary, radius);
          float core = exp(-radius * radius * 25.0);
          float alpha = min(1.0, body * 0.72 + core * 0.8) * strength;
          vec3 color = mix(vec3(1.0, 0.29, 0.018), vec3(1.0, 0.95, 0.70),
            smoothstep(0.2, 0.9, core + body * 0.5));
          gl_FragColor = vec4(color, alpha);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
    inner = new MeshBasicMaterial({
      color: '#fff1bd',
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    flame.dispose();
    core.dispose();
    outer.dispose();
    inner.dispose();
  };
  return {
    flame,
    core,
    outer,
    inner,
    dispose,
    /** React StrictMode may re-run an effect on the same mounted instance.
     * Three recreates disposed GPU state on the next draw, so its later final
     * cleanup must be admitted again rather than suppressed by an old flag. */
    acquire() {
      disposed = false;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        dispose();
      };
    },
  };
}
