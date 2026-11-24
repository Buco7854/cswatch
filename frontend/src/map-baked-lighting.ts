import {
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  ShaderChunk,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import type { GLTF, GLTFLoader } from 'three-stdlib';
import { applyPreparedWater } from './source-water-material';
import { applyPreparedGlass } from './source-glass-material';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };
import {
  applyLayerShader,
  readLayerTextureIds,
  type LayerTextureIds,
  type MaterialLayers,
} from './map-material-layers';

// The baked mask covers the sun. Local burst and muzzle lights still reach shade.
const lightLoop = ShaderChunk.lights_fragment_begin
  // The source sun mask and backface gate can remove all direct sun, even in
  // a program that receives both map and live player shadows. Keep the light
  // reads inside the gate so fully shaded fragments only compute indirect light.
  .replace(
    /(getDirectionalLightInfo\( directionalLight, directLight \);)([\s\S]*?RE_Direct\([^;]+;)/,
    `if (bakedSun > 0.0 && dot(nonPerturbedNormal, directionalLight.direction) >= 1e-6) {
       $1
       directLight.color *= bakedSun;
       $2
     }`,
  )
  // A burst light stays in the program between flashes. At zero intensity or
  // beyond its finite radius its direct contribution is exactly zero.
  .replace(
    /(getPointLightInfo\( pointLight, geometryPosition, directLight \);)([\s\S]*?RE_Direct\([^;]+;)/,
    `if (any(notEqual(pointLight.color, vec3(0.0)))) {
       $1
       if (directLight.visible) { $2 }
     }`,
  );
const nativeIndirect = `
  irradiance = vec3(0.0);
  iblIrradiance = PI * bakedIrradiance;
  #include <lights_fragment_end>
`;

function configureVertexLighting(material: MeshStandardMaterial) {
  const stream = format.vertexAttribute.toLowerCase();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      `attribute vec4 ${stream};\nvarying vec3 sourceVertexLight;\n` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 encodedLight = ${stream}.rgb * (6.0 * ${stream}.a);
        sourceVertexLight = encodedLight * encodedLight;`,
      );
    shader.fragmentShader =
      'varying vec3 sourceVertexLight;\n' +
      shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `vec3 bakedIrradiance = sourceVertexLight;\n${nativeIndirect}`,
      );
  };
  material.customProgramCacheKey = () => 'cswatch-source-vertex-lighting';
}

function configureMaterial(
  material: MeshStandardMaterial,
  atlas: Texture,
  irradianceRange: number,
  direction?: Texture,
  layers?: MaterialLayers,
) {
  // The compiled lightmapped-generic shader uses independent direct and
  // environment specular features. Its AO never attenuates direct diffuse.
  const source = material.userData.vmat;
  const lightmappedGeneric = source?.ShaderName === 'csgo_lightmappedgeneric.vfx';
  const response = new Vector3(
    lightmappedGeneric ? 0 : 1,
    !lightmappedGeneric || source.IntParams?.F_SPECULAR_DIRECT === 1 ? 1 : 0,
    !lightmappedGeneric || source.IntParams?.F_SPECULAR_INDIRECT === 1 ? 1 : 0,
  );
  material.lightMap = atlas;
  if (direction) Object.assign(material, { cswatchLightingDirection: direction });
  if (layers)
    Object.assign(material, {
      cswatchLayerColor: layers.color,
      cswatchLayerBlend: layers.blend,
      cswatchLayerDetail: layers.detail?.texture,
      cswatchSecondDetail: layers.secondDetail?.texture,
    });
  material.onBeforeCompile = (shader) => {
    if (layers) applyLayerShader(shader, layers);
    shader.uniforms.cswatchBakedResponse = { value: response };
    shader.fragmentShader = 'uniform vec3 cswatchBakedResponse;\n' + shader.fragmentShader;
    const shading = direction
      ? `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 directionSample = texture2D(cswatchLightingDirection, vLightMapUv).rgb;
          vec2 directionXY = directionSample.xy * 2.0 - 1.0;
          // Quantized XY can escape the unit disk. Keep the direction at
          // least five degrees above the surface (VRF common/lighting.slang).
          const float maxXY = 0.9961947;
          directionXY *= maxXY / max(maxXY, length(directionXY));
          float incomingZ = sqrt(max(0.0, 1.0 - dot(directionXY, directionXY)));
          vec3 incoming = vec3(directionXY, incomingZ);
          float angledDiffuse = max(0.0, dot(normalize(mapN), incoming)) / max(0.05, incomingZ);
          bakedIrradiance *= mix(angledDiffuse, 1.0, directionSample.z);
        #endif
      `
      : '';
    if (direction) {
      shader.uniforms.cswatchLightingDirection = { value: direction };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lightmap_pars_fragment>',
        '#include <lightmap_pars_fragment>\nuniform sampler2D cswatchLightingDirection;',
      );
    }
    const sample = `
          vec4 bakedLighting = texture2D(lightMap, vLightMapUv);
          vec3 bakedIrradiance = (exp2(bakedLighting.rgb * log2(${irradianceRange}.0 * ${format.irradianceBias}.0 + 1.0)) - 1.0) / ${format.irradianceBias}.0;
          ${shading}
          float bakedSun = 1.0 - clamp((bakedLighting.a * 255.0 - 1.0) / 254.0, 0.0, 1.0);`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_maps>',
      '#undef USE_LIGHTMAP\n#include <lights_fragment_maps>\n#define USE_LIGHTMAP',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', `${sample}\n${lightLoop}`)
      .replace('#include <lights_fragment_end>', nativeIndirect)
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
            #ifdef USE_AOMAP
              reflectedLight.directDiffuse *= mix(1.0, ambientOcclusion, cswatchBakedResponse.x);
              reflectedLight.directSpecular *= ambientOcclusion;
            #endif
            reflectedLight.directSpecular *= cswatchBakedResponse.y;
            reflectedLight.indirectSpecular *= cswatchBakedResponse.z;
          `,
      );
  };
  const programKey = [
    format.extension,
    format.schemaVersion,
    irradianceRange,
    Boolean(direction),
    Boolean(layers),
    Boolean(layers?.detail),
    Boolean(layers?.secondDetail),
  ].join(':');
  material.customProgramCacheKey = () => programKey;
}

function boundedTexture(texture: unknown) {
  if (!(texture instanceof Texture)) return;
  const { width, height } = texture.image ?? {};
  if (
    ![width, height].every(
      (size) => Number.isSafeInteger(size) && size >= 1 && size <= format.maximumEdge,
    )
  )
    return;
  return texture.clone();
}

function atlasTexture(texture: unknown) {
  const atlas = boundedTexture(texture);
  if (!atlas || atlas.image.width !== atlas.image.height) return;
  atlas.channel = format.texCoord;
  atlas.colorSpace = NoColorSpace;
  atlas.generateMipmaps = false;
  return atlas;
}

/** Install the optional atlas at GLTF parse time, inside the existing image and model leases. */
export function registerMapBakedLighting(loader: GLTFLoader) {
  loader.register((parser) => ({
    name: format.extension,
    async afterRoot(gltf: GLTF) {
      const materials = new Map<MeshStandardMaterial, number>();
      const vertexMaterials = new Map<MeshStandardMaterial, boolean>();
      const ineligible = new Set<MeshStandardMaterial>();
      const textureIds = new Set<number>();
      const irradianceRanges = new Set<number>();
      const directionIds = new Set<number>();
      const directionalMaterials = new Set<MeshStandardMaterial>();
      const layerMaterials = new Map<MeshStandardMaterial, LayerTextureIds>();
      const ineligibleLayers = new Set<MeshStandardMaterial>();
      const textureId = (value: unknown, channel: number) => {
        if (typeof value !== 'object' || !value) return;
        const info = value as { index?: number; texCoord?: number };
        const index = info.index;
        if (
          (info.texCoord ?? 0) === channel &&
          index !== undefined &&
          Number.isSafeInteger(index) &&
          index >= 0 &&
          index < (parser.json.textures?.length ?? 0)
        )
          return index;
      };
      for (const scene of gltf.scenes)
        scene.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          const uv = object.geometry.getAttribute('uv1');
          const position = object.geometry.getAttribute('position');
          const blend = object.geometry.getAttribute(format.layerAttribute.toLowerCase());
          const vertex = object.geometry.getAttribute(format.vertexAttribute.toLowerCase());
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            if (!(material instanceof MeshStandardMaterial)) continue;
            if (material.userData.cswatch?.water) applyPreparedWater(material);
            applyPreparedGlass(material);
            if (material.userData?.cswatch?.vertexLighting === true) {
              vertexMaterials.set(
                material,
                Boolean(
                  vertexMaterials.get(material) !== false &&
                  vertex?.itemSize === 4 &&
                  vertex.count === position?.count,
                ),
              );
              continue;
            }
            const index = parser.associations.get(material)?.materials;
            if (index === undefined) continue;
            const metadata = parser.json.materials?.[index]?.extensions?.[format.extension];
            if (!metadata) continue;
            const texture = textureId(metadata.irradianceTexture, format.texCoord);
            const range = metadata.irradianceRange ?? format.irradianceRange;
            if (
              metadata.schemaVersion !== format.schemaVersion ||
              !Number.isInteger(range) ||
              range < format.irradianceRange ||
              range > format.maximumIrradianceRange ||
              (range & (range - 1)) !== 0 ||
              texture === undefined ||
              !uv ||
              uv.itemSize !== 2 ||
              uv.count !== position?.count
            ) {
              ineligible.add(material);
              continue;
            }
            materials.set(material, texture);
            textureIds.add(texture);
            irradianceRanges.add(range);
            const direction = textureId(metadata.directionTexture, format.texCoord);
            if (direction !== undefined && direction !== texture) {
              directionIds.add(direction);
              directionalMaterials.add(material);
            }
            if (metadata.layers) {
              const layer = readLayerTextureIds(metadata.layers, textureId);
              if (layer && material.map && blend?.itemSize === 4 && blend.count === position.count)
                layerMaterials.set(material, layer);
              else ineligibleLayers.add(material);
            }
          }
        });
      for (const [material, valid] of vertexMaterials) if (valid) configureVertexLighting(material);
      // A prepared map has exactly one atlas. Unsupported metadata keeps the PBR path.
      if (textureIds.size !== 1 || irradianceRanges.size !== 1 || !materials.size) return;
      try {
        const index = textureIds.values().next().value!;
        const irradianceRange = irradianceRanges.values().next().value!;
        const atlas = atlasTexture(await parser.getDependency('texture', index));
        if (!atlas) return;
        let direction: Texture | undefined;
        if (directionIds.size === 1)
          direction = atlasTexture(
            await parser
              .getDependency('texture', directionIds.values().next().value!)
              .catch(() => undefined),
          );
        const layerTextures = new Map<string, Promise<Texture | undefined>>();
        const layerTexture = (index: number, srgb = false) => {
          const key = index + ':' + srgb;
          const existing = layerTextures.get(key);
          if (existing) return existing;
          if (layerTextures.size >= 32) return;
          const pending = parser
            .getDependency('texture', index)
            .then((source) => {
              const texture = boundedTexture(source);
              if (texture) texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
              return texture;
            })
            .catch(() => undefined);
          layerTextures.set(key, pending);
          return pending;
        };
        await Promise.all(
          [...materials].map(async ([material]) => {
            if (ineligible.has(material)) return;
            let layers: MaterialLayers | undefined;
            const layer = layerMaterials.get(material);
            if (layer && !ineligibleLayers.has(material)) {
              const [color, blend, detail, secondDetail] = await Promise.all([
                layerTexture(layer.color, true),
                layerTexture(layer.blend),
                layer.detail && layerTexture(layer.detail.texture),
                layer.secondDetail && layerTexture(layer.secondDetail.texture),
              ]);
              if (color && blend && (!layer.secondDetail || (detail && secondDetail)))
                layers = {
                  color,
                  blend,
                  detail: detail && layer.detail ? { ...layer.detail, texture: detail } : undefined,
                  secondDetail:
                    secondDetail && layer.secondDetail
                      ? { ...layer.secondDetail, texture: secondDetail }
                      : undefined,
                };
            }
            configureMaterial(
              material,
              atlas,
              irradianceRange,
              directionalMaterials.has(material) ? direction : undefined,
              layers,
            );
          }),
        );
      } catch {
        // Optional lighting can fail independently of the required base-color textures.
      }
    },
  }));
}
