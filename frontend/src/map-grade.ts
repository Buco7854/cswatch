import {
  BufferAttribute,
  BufferGeometry,
  Data3DTexture,
  GLSL3,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector4,
  type PointLight,
  type WebGLRenderTarget,
} from 'three';
import { mapGradeBytes, mapGradeCurve } from '../../shared/map-grade.mjs';
import type { MapGrade } from '../../shared/map-grade.mjs';

// A renderer-local target identifies the graded path even when two canvases
// share the same cached map material.
export const mapGradeTargets = new WeakSet<WebGLRenderTarget>();
export const mapGradeLighting = new WeakMap<WebGLRenderTarget, NonNullable<MapGrade['lighting']>>();
export const mapGradeExposure = new WeakMap<WebGLRenderTarget, number>();
export const mapGradeBurstLights = new WeakMap<
  Scene,
  { light: PointLight; intensity: () => number }
>();
export const mapGradeExposureGain = ({ min, bias }: MapGrade['exposure']) => 2.8 * min * 2 ** bias;

export async function loadGradeLut(url: string, grade: MapGrade, signal: AbortSignal) {
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok || !response.body) throw Error('Map grading LUT is unavailable.');
  const data = new Uint8Array(mapGradeBytes(grade.lut.size));
  const stream = response.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      if (length + value.length > data.length) throw Error('Map grading LUT exceeds its size.');
      data.set(value, length);
      length += value.length;
    }
  } finally {
    await stream.cancel().catch(() => {});
    stream.releaseLock();
  }
  if (length !== data.length) throw Error('Incomplete map grading LUT.');
  const hash = await crypto.subtle.digest('SHA-256', data);
  const digest = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== grade.lut.sha256) throw Error('Map grading LUT hash mismatch.');
  return data;
}

// Curve and output order adapted from ValveResourceFormat at
// 942df5b37ebbde6153f6c488880b91d4bed003e6 (public/licenses/valve-resource-format.txt).
export function createGradeOutput(grade: MapGrade, data: Uint8Array) {
  const { size } = grade.lut;
  const lut = new Data3DTexture(data, size, size, size);
  lut.minFilter = lut.magFilter = LinearFilter;
  lut.needsUpdate = true;
  const geometry = new BufferGeometry().setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  // Without a replay exposure meter, use the authored lower endpoint to
  // retain highlight headroom and make every seek return the same grade.
  const { curve, exposure } = grade;
  const { a, b, c, white, whiteScale } = mapGradeCurve(curve);
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    uniforms: {
      sceneColor: { value: null },
      lut: { value: lut },
      numerator: { value: new Vector4(a * whiteScale, b * whiteScale, white, size) },
      denominator: {
        value: new Vector4(curve.shoulder, curve.linear, c, mapGradeExposureGain(exposure)),
      },
    },
    vertexShader: `
      out vec2 gradeUv;
      void main() {
        gradeUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      in vec2 gradeUv;
      layout(location = 0) out vec4 graded;
      uniform sampler2D sceneColor;
      uniform highp sampler3D lut;
      uniform vec4 numerator;
      uniform vec4 denominator;

      void main() {
        vec4 scene = texture(sceneColor, gradeUv);
        vec3 x = clamp(scene.rgb * denominator.w, 0.0, numerator.z);
        vec3 curved = x * (numerator.x * x + numerator.y)
          / (x * (denominator.x * x + denominator.y) + denominator.z);
        vec3 srgb = sRGBTransferOETF(vec4(clamp(curved, 0.0, 1.0), 1.0)).rgb;
        vec3 uvw = (srgb * (numerator.w - 1.0) + 0.5) / numerator.w;
        graded = vec4(texture(lut, uvw).rgb, scene.a);
      }
    `,
  });
  const scene = new Scene(),
    camera = new OrthographicCamera();
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    camera,
    scene,
    material,
    dispose() {
      geometry.dispose();
      material.dispose();
      lut.dispose();
    },
  };
}
