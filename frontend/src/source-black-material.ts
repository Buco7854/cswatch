import {
  CubeTexture,
  FrontSide,
  Matrix3,
  Mesh,
  NoBlending,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Material,
  type Object3D,
} from 'three';
import type { MapCubeFog } from '../../shared/map-assets';

export type SourceFogResources = { fog: MapCubeFog | null; cube: CubeTexture | null };
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
const fragmentShader = `
uniform samplerCube sourceFogCube;
uniform float sourceFogReady;
uniform vec3 sourceFogDistance;
uniform vec4 sourceFogHeight;
uniform vec4 sourceFogColor;
uniform mat3 sourceFogRotation;
varying vec3 sourceWorldPosition;
void main() {
  vec3 color = vec3(0.0);
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
      color = textureCubeLodEXT(sourceFogCube,direction,lod).rgb * sourceFogColor.z * opacity;
    }
  }
  gl_FragColor = vec4(color,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

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
          uniforms: {
            sourceFogCube: { value: null },
            sourceFogReady: { value: 0 },
            sourceFogDistance: { value: new Vector3(0, 1, 1) },
            sourceFogHeight: { value: new Vector4(0, 1, 1, 0) },
            sourceFogColor: { value: new Vector4(0, 0, 0, 0) },
            sourceFogRotation: { value: new Matrix3() },
          },
        });
        material.userData = { ...original.userData };
        const fogEnabled = original.userData.vmat.IntParams?.g_bFogEnabled === 1;
        let previousFog: MapCubeFog | null | undefined,
          previousCube: CubeTexture | null | undefined;
        material.onBeforeRender = () => {
          const state = resources(),
            fog = fogEnabled ? state.fog : null,
            cube = state.cube;
          if (fog === previousFog && cube === previousCube) return;
          previousFog = fog;
          previousCube = cube;
          material.uniforms.sourceFogReady.value = fog && cube ? 1 : 0;
          material.uniforms.sourceFogCube.value = cube;
          if (fog && cube) {
            material.uniforms.sourceFogDistance.value.set(fog.start, fog.end, fog.exponent);
            material.uniforms.sourceFogHeight.value.set(
              fog.height?.start ?? 0,
              fog.height?.end ?? 1,
              fog.height?.exponent ?? 1,
              fog.height ? 1 : 0,
            );
            const face = cube.images[0] as { width?: number } | undefined,
              size = face?.width || 1;
            material.uniforms.sourceFogColor.value.set(
              fog.maxOpacity,
              fog.lodBias,
              fog.brightness,
              Math.max(0, Math.log2(size) - 3),
            );
            material.uniforms.sourceFogRotation.value.fromArray(fog.rotation);
          }
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
