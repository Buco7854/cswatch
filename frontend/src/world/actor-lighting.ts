import {
  DataArrayTexture,
  MeshStandardMaterial,
  ShaderChunk,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  type Material,
  type WebGLRenderer,
} from 'three';
import probeShader from './glsl/actor-probes.glsl?raw';
import type { NativeRenderer } from './renderer';

type ShaderPatch = Pick<Material, 'onBeforeCompile' | 'customProgramCacheKey'>;
const lightingBase = new WeakMap<
  ShaderPatch['onBeforeCompile'],
  { before: ShaderPatch['onBeforeCompile']; key: ShaderPatch['customProgramCacheKey'] }
>();

/** Per-material direct sun traced along a character (see actor-sunlight). A material without a
 * trace keeps the probe volume's sun occlusion. */
type ActorSunUniforms = {
  actorSunSamples: { value: Vector4 };
  /** Lowest sample height and the span to the highest, in Source inches. */
  actorSunSpan: { value: Vector2 };
  actorSunTraced: { value: number };
};
const sunUniforms = new WeakMap<Material, ActorSunUniforms>();
export function actorSunUniforms(material: Material) {
  let uniforms = sunUniforms.get(material);
  if (!uniforms) {
    sunUniforms.set(
      material,
      (uniforms = {
        actorSunSamples: { value: new Vector4(1, 1, 1, 1) },
        actorSunSpan: { value: new Vector2(0, 1) },
        actorSunTraced: { value: 0 },
      }),
    );
    // Readable by diagnostics; a clone never copies it and gets its own.
    Object.defineProperty(material, 'cswatchActorSun', { value: uniforms });
  }
  return uniforms;
}
const sunShader = `
uniform vec4 actorSunSamples;
uniform vec2 actorSunSpan;
uniform float actorSunTraced;
float actorSunVisibility(float probeShadow) {
  if (actorSunTraced < 0.5) return 1.0 - probeShadow;
  float t = clamp((actorSourcePosition.z - actorSunSpan.x) / actorSunSpan.y, 0.0, 1.0) * 3.0;
  vec4 s = actorSunSamples;
  return t < 1.0 ? mix(s.x, s.y, t) : t < 2.0 ? mix(s.y, s.z, t - 1.0) : mix(s.z, s.w, t - 2.0);
}
`;

export function actorLighting(renderer: WebGLRenderer, native: NativeRenderer) {
  const env = native.environments.find((environment) => !environment.sky)!;
  const wrappers: Texture[] = [];
  function borrowed(handle: WebGLTexture, array: boolean) {
    const texture = array ? new DataArrayTexture() : new Texture();
    (renderer.properties.get(texture) as { __webglTexture: WebGLTexture }).__webglTexture = handle;
    wrappers.push(texture);
    return { value: texture };
  }
  const uniforms = {
    actorIrradiance: borrowed(env.lpv, true),
    actorSunShadow: borrowed(env.shadow, true),
    actorProbes: borrowed(env.probes, false),
    actorCells: borrowed(env.grid, false),
    actorGridMin: { value: new Vector3(...env.spatial.min) },
    actorGridInv: { value: new Vector3(...env.spatial.invStep) },
    actorVolumeLayers: { value: new Vector4(...env.volumeLayers) },
    actorHdr: { value: env.hdr[2] },
  };
  const patched = new Map<Material, () => void>();
  function bind(material: Material) {
    if (!(material instanceof MeshStandardMaterial) || patched.has(material)) return;
    let before = material.onBeforeCompile,
      key = material.customProgramCacheKey;
    // A clone (an x-ray mask) can carry its source's lighting patch; patch the base once.
    const base = lightingBase.get(before);
    if (base) ({ before, key } = base);
    // A disposed material leaves the registry; replays remount many instance materials.
    const forget = () => {
      patched.delete(material);
      material.removeEventListener('dispose', forget);
    };
    material.addEventListener('dispose', forget);
    patched.set(material, () => {
      forget();
      material.onBeforeCompile = before;
      material.customProgramCacheKey = key;
      material.needsUpdate = true;
    });
    material.onBeforeCompile = function (shader, gl) {
      before.call(this, shader, gl);
      Object.assign(shader.uniforms, uniforms, actorSunUniforms(this));
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 actorSourcePosition;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 actorPoint=vec4(transformed,1.);
          #ifdef USE_INSTANCING
            actorPoint=instanceMatrix*actorPoint;
          #endif
          actorPoint=modelMatrix*actorPoint;
          actorSourcePosition=vec3(actorPoint.x,-actorPoint.z,actorPoint.y)/0.0254;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + probeShader + sunShader)
        .replace(
          '#include <lights_fragment_begin>',
          `vec3 actorNormal = inverseTransformDirection(normal,viewMatrix);
          vec4 bakedActorLight=actorLightingAt(vec3(actorNormal.x,-actorNormal.z,actorNormal.y));
          ` +
            ShaderChunk.lights_fragment_begin.replace(
              'getDirectionalLightInfo( directionalLight, directLight );',
              'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= actorSunVisibility(bakedActorLight.a);',
            ),
        )
        .replace(
          '#include <lights_fragment_maps>',
          // VRF lights csgo_character's specular and cloth sheen from the map's cubemaps as well as
          // its diffuse from the probes. The probe light stands in for that environment: as image
          // light it feeds three's energy-conserving diffuse, specular and sheen terms. At character
          // roughness the prefiltered cubemap is close to the irradiance over pi.
          '#include <lights_fragment_maps>\n iblIrradiance += PI*bakedActorLight.rgb; radiance += bakedActorLight.rgb;',
        );
    };
    material.customProgramCacheKey = () => key.call(material) + ':native-probes-v4';
    lightingBase.set(material.onBeforeCompile, { before, key });
    material.needsUpdate = true;
  }
  return {
    bind,
    /** The probe-volume uniforms, shared with effects that sample the same lighting. */
    uniforms,
    /** The authored sun of the playable environment, in Source axes towards the sun. */
    sun: { direction: env.lightDir, color: env.color },
    dispose() {
      for (const restore of patched.values()) restore();
      for (const wrapper of wrappers) renderer.properties.remove(wrapper);
    },
  };
}
