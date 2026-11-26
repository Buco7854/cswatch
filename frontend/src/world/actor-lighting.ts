import {
  DataArrayTexture,
  MeshStandardMaterial,
  ShaderChunk,
  Texture,
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
      Object.assign(shader.uniforms, uniforms);
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
        .replace('#include <common>', '#include <common>\n' + probeShader)
        .replace(
          '#include <lights_fragment_begin>',
          `vec3 actorNormal = inverseTransformDirection(normal,viewMatrix);
          vec4 bakedActorLight=actorLightingAt(vec3(actorNormal.x,-actorNormal.z,actorNormal.y));
          ` +
            ShaderChunk.lights_fragment_begin.replace(
              'getDirectionalLightInfo( directionalLight, directLight );',
              'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= 1.0 - bakedActorLight.a;',
            ),
        )
        .replace(
          '#include <lights_fragment_maps>',
          '#include <lights_fragment_maps>\n irradiance += PI*bakedActorLight.rgb;',
        );
    };
    material.customProgramCacheKey = () => key.call(material) + ':native-probes-v2';
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
