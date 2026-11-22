import {
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  ShaderChunk,
  SRGBColorSpace,
  Texture,
} from 'three';
import type { GLTF, GLTFLoader } from 'three-stdlib';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };
import {
  applyLayerShader,
  readLayerTextureIds,
  type LayerTextureIds,
  type MaterialLayers,
} from './map-material-layers';
import { mapGradeTargets } from './map-grade';

const lightLoop = ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  `getDirectionalLightInfo( directionalLight, directLight );
    directLight.color *=
      bakedSun * step(1e-6, dot(nonPerturbedNormal, directLight.direction));`,
);

function configureMaterial(
  material: MeshStandardMaterial,
  atlas: Texture,
  direction?: Texture,
  layers?: MaterialLayers,
) {
  material.lightMap = atlas;
  if (direction) Object.assign(material, { cswatchLightingDirection: direction });
  if (layers)
    Object.assign(material, {
      cswatchLayerColor: layers.color,
      cswatchLayerBlend: layers.blend,
      cswatchLayerDetail: layers.detail,
    });
  let graded = false;
  material.onBeforeRender = (renderer) => {
    const target = renderer.getRenderTarget();
    const next = target !== null && mapGradeTargets.has(target);
    if (next !== graded) {
      graded = next;
      material.needsUpdate = true;
    }
  };
  material.onBeforeCompile = (shader) => {
    if (layers) applyLayerShader(shader, layers);
    const grazingFix = graded
      ? `          // Quantized XY can escape the unit disk despite nonzero diffuse.
          // Floor the direction at five degrees, as in VRF common/lighting.slang.
          const float maxXY = 0.9961947;
          directionXY *= maxXY / max(maxXY, length(directionXY));
`
      : '';
    const shading = direction
      ? `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 directionSample = texture2D(cswatchLightingDirection, vLightMapUv).rgb;
          vec2 directionXY = directionSample.xy * 2.0 - 1.0;
${grazingFix}          float incomingZ = sqrt(max(0.0, 1.0 - dot(directionXY, directionXY)));
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
          vec3 bakedIrradiance = (exp2(bakedLighting.rgb * log2(${format.irradianceRange}.0 * ${format.irradianceBias}.0 + 1.0)) - 1.0) / ${format.irradianceBias}.0;
          ${shading}
          float bakedSun = 1.0 - clamp((bakedLighting.a * 255.0 - 1.0) / 254.0, 0.0, 1.0);`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_maps>',
      '#undef USE_LIGHTMAP\n#include <lights_fragment_maps>\n#define USE_LIGHTMAP',
    );
    if (graded) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_begin>', `${sample}\n${lightLoop}`)
        .replace(
          '#include <lights_fragment_end>',
          `
            // Replace ambient and sky irradiance with the captured light.
            // Three's energy-conserving indirect BRDF divides by pi.
            irradiance = vec3(0.0);
            iblIrradiance = PI * bakedIrradiance;
            #include <lights_fragment_end>
          `,
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
            #ifdef USE_AOMAP
              reflectedLight.directDiffuse *= ambientOcclusion;
              reflectedLight.directSpecular *= ambientOcclusion;
            #endif
          `,
        );
      return;
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>${sample}
          reflectedLight.indirectDiffuse = material.diffuseColor * bakedIrradiance;
          reflectedLight.directDiffuse *= bakedSun;
          reflectedLight.directSpecular *= bakedSun;
        `,
    );
  };
  const programKey = [
    format.extension,
    format.schemaVersion,
    Boolean(direction),
    Boolean(layers),
    Boolean(layers?.detail),
  ].join(':');
  material.customProgramCacheKey = () => (graded ? programKey + ':grade' : programKey);
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
      if (!parser.json.extensionsUsed?.includes(format.extension)) return;
      const materials = new Map<MeshStandardMaterial, number>();
      const ineligible = new Set<MeshStandardMaterial>();
      const textureIds = new Set<number>();
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
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            if (!(material instanceof MeshStandardMaterial)) continue;
            const index = parser.associations.get(material)?.materials;
            if (index === undefined) continue;
            const metadata = parser.json.materials?.[index]?.extensions?.[format.extension];
            if (!metadata) continue;
            const texture = textureId(metadata.irradianceTexture, format.texCoord);
            if (
              metadata.schemaVersion !== format.schemaVersion ||
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
      // A prepared map has exactly one atlas. Unsupported metadata keeps the PBR path.
      if (textureIds.size !== 1 || !materials.size) return;
      try {
        const index = textureIds.values().next().value!;
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
              const [color, blend, detail] = await Promise.all([
                layerTexture(layer.color, true),
                layerTexture(layer.blend),
                layer.detail === undefined ? undefined : layerTexture(layer.detail),
              ]);
              if (color && blend)
                layers = { color, blend, detail, scale: layer.scale, strength: layer.strength };
            }
            configureMaterial(
              material,
              atlas,
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
