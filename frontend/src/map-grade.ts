import { createContext } from 'react';
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
} from 'three';
import { mapGradeBytes, mapGradeCurve } from '../../shared/map-grade.mjs';
import type { MapGrade } from '../../shared/map-grade.mjs';

export type AuthoredGrade = { grade: MapGrade; bytes: Uint8Array };
export const MapGradeContext = createContext<MapGrade | undefined>(undefined);

export const mapGradeBurstLights = new WeakMap<
  Scene,
  { light: PointLight; intensity: () => number }
>();
export const mapGradeExposureGain = (grade?: MapGrade) =>
  grade ? 2.8 * grade.exposure.min * 2 ** grade.exposure.bias : 1;

// RGB runs along X, Y and Z respectively. An identity cube fits in eight texels.
const identityLut = Uint8Array.from({ length: 32 }, (_, i) =>
  i % 4 === 3 || ((i >> 2) & (1 << (i % 4))) !== 0 ? 255 : 0,
);

// Unit slope at black and a flat shoulder at four times scene white.
const neutralCurve = { a: -1 / 16, b: 1, c: 1, white: 4, whiteScale: 1 };

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
export function createGradeOutput() {
  const geometry = new BufferGeometry().setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    uniforms: {
      sceneColor: { value: null },
      lut: { value: null },
      numerator: { value: new Vector4() },
      denominator: { value: new Vector4() },
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
        // The resolved world already contains the opaque sky or fallback background.
        // Coverage alpha in this target must not blend the page behind it a second time.
        graded = vec4(texture(lut, uvw).rgb, 1.0);
      }
    `,
  });
  let lut: Data3DTexture | undefined;
  let current: AuthoredGrade | undefined;
  const setGrade = (authored?: AuthoredGrade) => {
    if (lut && authored === current) return;
    current = authored;
    const grade = authored?.grade;
    const size = grade?.lut.size ?? 2;
    lut?.dispose();
    lut = new Data3DTexture(authored?.bytes ?? identityLut, size, size, size);
    lut.minFilter = lut.magFilter = LinearFilter;
    lut.needsUpdate = true;
    // The lower endpoint retains highlight headroom and keeps seeks deterministic.
    const curve = grade?.curve;
    const { a, b, c, white, whiteScale } = curve ? mapGradeCurve(curve) : neutralCurve;
    material.uniforms.lut.value = lut;
    material.uniforms.numerator.value.set(a * whiteScale, b * whiteScale, white, size);
    material.uniforms.denominator.value.set(
      curve?.shoulder ?? 0,
      curve?.linear ?? 0.5,
      c,
      mapGradeExposureGain(grade),
    );
  };
  setGrade();
  const scene = new Scene(),
    camera = new OrthographicCamera();
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    camera,
    scene,
    material,
    setGrade,
    dispose() {
      geometry.dispose();
      material.dispose();
      lut?.dispose();
    },
  };
}
