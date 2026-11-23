import {
  CubeTexture,
  FrontSide,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoBlending,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Material,
  type Object3D,
} from 'three';
import type { MapCubeFog, MapGradientFog } from '../../shared/map-assets';

export type SourceFogResources = {
  fog: MapCubeFog | null;
  cube: CubeTexture | null;
  gradient?: MapGradientFog | null;
  landscapeGradient?: MapGradientFog | null;
};
function isSourceBlackUnlit(material: Material): boolean {
  const source = material.userData?.vmat;
  return (
    source?.Name === 'materials/dev/black_simple.vmat' &&
    source.ShaderName === 'csgo_black_unlit.vfx'
  );
}

const vertexShader = `
varying vec3 sourceWorldPosition;
void main() {
  vec4 world = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    world = instanceMatrix * world;
  #endif
  world = modelMatrix * world;
  sourceWorldPosition = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const fogChunk = `
uniform samplerCube sourceFogCube;
uniform float sourceFogReady;
uniform vec3 sourceFogDistance;
uniform vec4 sourceFogHeight;
uniform vec4 sourceFogColor;
uniform mat3 sourceFogRotation;
uniform vec3 sourceGradientDistance;
uniform vec4 sourceGradientHeight;
uniform vec4 sourceGradientColor;
varying vec3 sourceWorldPosition;
vec4 sourceCubeFog() {
  if (sourceFogReady > 0.5) {
    vec3 relative = sourceWorldPosition - cameraPosition;
    float distanceToCamera = length(relative);
    float distanceTerm = clamp(pow(max((distanceToCamera-sourceFogDistance.x)/(sourceFogDistance.y-sourceFogDistance.x),0.0),sourceFogDistance.z),0.0,1.0);
    float heightTerm = 1.0;
    if (sourceFogHeight.w > 0.5)
      heightTerm = clamp(pow(max((sourceFogHeight.y-sourceWorldPosition.y)/(sourceFogHeight.y-sourceFogHeight.x),0.0),sourceFogHeight.z),0.0,1.0);
    float blend = distanceTerm * heightTerm;
    float opacity = blend * sourceFogColor.x;
    if (opacity > 0.0) {
      vec3 direction = sourceFogRotation * (relative / max(distanceToCamera,0.000001));
      direction.x = -direction.x;
      float lod = sourceFogColor.w * clamp(1.0-blend*sourceFogColor.y,0.0,1.0);
      return vec4(textureCubeLodEXT(sourceFogCube,direction,lod).rgb * sourceFogColor.z, opacity);
    }
  }
  return vec4(0.0);
}
vec3 applySourceFog(vec3 color) {
  if (sourceGradientColor.a > 0.0) {
    float distanceToCamera = length(sourceWorldPosition - cameraPosition);
    float distanceTerm = pow(clamp((distanceToCamera - sourceGradientDistance.x) / (sourceGradientDistance.y - sourceGradientDistance.x), 0.0, 1.0), sourceGradientDistance.z);
    float heightTerm = 1.0;
    if (sourceGradientHeight.w > 0.5)
      heightTerm = pow(clamp((sourceGradientHeight.y - sourceWorldPosition.y) / (sourceGradientHeight.y - sourceGradientHeight.x), 0.0, 1.0), sourceGradientHeight.z);
    color = mix(color, sourceGradientColor.rgb, distanceTerm * heightTerm * sourceGradientColor.a);
  }
  vec4 cubeFog = sourceCubeFog();
  return mix(color, cubeFog.rgb, cubeFog.a);
}`;
const fragmentShader = `${fogChunk}
void main() {
  gl_FragColor = vec4(applySourceFog(vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function fogUniforms() {
  return {
    sourceFogCube: { value: null as CubeTexture | null },
    sourceFogReady: { value: 0 },
    sourceFogDistance: { value: new Vector3(0, 1, 1) },
    sourceFogHeight: { value: new Vector4(0, 1, 1, 0) },
    sourceFogColor: { value: new Vector4(0, 0, 0, 0) },
    sourceFogRotation: { value: new Matrix3() },
    sourceGradientDistance: { value: new Vector3(0, 1, 1) },
    sourceGradientHeight: { value: new Vector4(0, 1, 1, 0) },
    sourceGradientColor: { value: new Vector4(0, 0, 0, 0) },
  };
}

function updateFogUniforms(resources: () => SourceFogResources) {
  const uniforms = fogUniforms();
  let previousFog: MapCubeFog | null | undefined, previousCube: CubeTexture | null | undefined;
  let previousGradient: MapGradientFog | null | undefined;
  return {
    uniforms,
    update() {
      const { fog, cube, gradient } = resources();
      if (gradient !== previousGradient) {
        previousGradient = gradient;
        uniforms.sourceGradientColor.value.set(
          ...(gradient?.color ?? [0, 0, 0]),
          gradient?.maxOpacity ?? 0,
        );
        if (gradient) {
          uniforms.sourceGradientDistance.value.set(
            gradient.start,
            gradient.end,
            gradient.exponent,
          );
          uniforms.sourceGradientHeight.value.set(
            gradient.height?.start ?? 0,
            gradient.height?.end ?? 1,
            gradient.height?.exponent ?? 1,
            gradient.height ? 1 : 0,
          );
        }
      }
      if (fog === previousFog && cube === previousCube) return;
      previousFog = fog;
      previousCube = cube;
      uniforms.sourceFogReady.value = fog && cube ? 1 : 0;
      uniforms.sourceFogCube.value = cube;
      if (fog && cube) {
        uniforms.sourceFogDistance.value.set(fog.start, fog.end, fog.exponent);
        uniforms.sourceFogHeight.value.set(
          fog.height?.start ?? 0,
          fog.height?.end ?? 1,
          fog.height?.exponent ?? 1,
          fog.height ? 1 : 0,
        );
        const face = cube.images[0] as { width?: number } | undefined;
        uniforms.sourceFogColor.value.set(
          fog.maxOpacity,
          fog.lodBias,
          fog.brightness,
          Math.max(0, Math.log2(face?.width || 1) - 3),
        );
        uniforms.sourceFogRotation.value.fromArray(fog.rotation);
      }
    },
  };
}

/** Instance-owned material wrappers preserve baked lighting and the glTF shader variants. */
export function installSourceWorldFog(root: Object3D, resources: () => SourceFogResources) {
  const generated = new Map<Material, Material>();
  const state = updateFogUniforms(resources);
  const replace = (original: Material) => {
    const native = original.userData?.vmat;
    if (
      !(original instanceof MeshStandardMaterial || original instanceof MeshBasicMaterial) ||
      !native ||
      native.IntParams?.g_bFogEnabled === 0 ||
      original.userData?.cswatch?.atmosphere ||
      isSourceBlackUnlit(original)
    )
      return original;
    const existing = generated.get(original);
    if (existing) return existing;
    const material = original.clone();
    material.customProgramCacheKey = () => original.customProgramCacheKey() + ':source-cube-fog';
    material.onBeforeRender = state.update;
    material.onBeforeCompile = (shader, renderer) => {
      original.onBeforeCompile(shader, renderer);
      Object.assign(shader.uniforms, state.uniforms);
      shader.vertexShader =
        'varying vec3 sourceWorldPosition;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
        vec4 sourceFogPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          sourceFogPosition = batchingMatrix * sourceFogPosition;
        #endif
        #ifdef USE_INSTANCING
          sourceFogPosition = instanceMatrix * sourceFogPosition;
        #endif
        sourceWorldPosition = (modelMatrix * sourceFogPosition).xyz;`,
        );
      shader.fragmentShader =
        `${fogChunk}\n` +
        shader.fragmentShader.replace(
          '#include <tonemapping_fragment>',
          `gl_FragColor.rgb = applySourceFog(gl_FragColor.rgb);
        #include <tonemapping_fragment>`,
        );
    };
    generated.set(original, material);
    return material;
  };
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(replace)
      : replace(object.material);
  });
  return () => {
    for (const material of generated.values()) material.dispose();
  };
}

/** Exact Source identity only. Generated materials never mutate the cached glTF material. */
export function installSourceBlackMaterials(
  roots: Object3D[],
  resources: () => SourceFogResources,
) {
  const generated = new Map<Material, ShaderMaterial>();
  for (const root of roots)
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const replace = (original: Material): Material => {
        if (!isSourceBlackUnlit(original)) return original;
        const existing = generated.get(original);
        if (existing) return existing;
        const material = new ShaderMaterial({
          name: 'Source black unlit compatibility',
          vertexShader,
          fragmentShader,
          transparent: false,
          opacity: 1,
          depthTest: true,
          depthWrite: true,
          side: FrontSide,
          blending: NoBlending,
          lights: false,
          fog: false,
          uniforms: {},
        });
        material.userData = { ...original.userData };
        const fogEnabled = original.userData.vmat.IntParams?.g_bFogEnabled === 1;
        const state = updateFogUniforms(() =>
          fogEnabled ? resources() : { fog: null, cube: null },
        );
        material.uniforms = state.uniforms;
        material.onBeforeRender = () => {
          state.update();
          material.uniformsNeedUpdate = true;
        };
        generated.set(original, material);
        return material;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(replace)
        : replace(object.material);
    });
  return {
    materials: [...generated.values()],
    dispose: () => {
      for (const material of generated.values()) material.dispose();
    },
  };
}
