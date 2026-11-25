// Material and lighting bindings adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.
import type { Manifest, Material } from './format';
const rad = Math.PI / 180;
function familyNumber(material: Material) {
  const shader = material.shader;
  if (shader.includes('effects')) return 4;
  if (shader.includes('foliage')) return 5;
  if (shader.includes('black_unlit')) return 3;
  if (shader.includes('glass')) return 2;
  if (shader.includes('unlit') || (shader.includes('static_overlay') && !material.ints.F_LIT))
    return 1;
  if (shader === 'csgo_environment.vfx') return 6;
  return 0;
}
// Each material occupies 36 RGBA32F texels in the order read by world.frag.glsl.
export function materialRows(manifest: Manifest) {
  return new Float32Array(
    manifest.materials.flatMap((material) => {
      const bindings = material.bindings,
        features = material.ints,
        scalars = material.scalars,
        vectors = material.vectors;
      const linearTint = (key: string) =>
        (vectors[key] ?? [1, 1, 1])
          .slice(0, 3)
          .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      const family = familyNumber(material);
      return [
        ...manifest.roles.slice(0, 8).map((key) => bindings[key]?.[1] ?? -1),
        features.F_ALPHA_TEST ?? 0,
        features.F_TRANSLUCENT ||
        features.F_OVERLAY ||
        family === 2 ||
        material.shader.includes('overlay') ||
        family === 1 ||
        family === 4
          ? 1
          : 0,
        family,
        scalars.g_flOpacityScale ?? 1,
        ...linearTint('g_vColorTint'),
        1,
        scalars.g_flAlphaTestReference ?? 0.5,
        scalars.g_flModelTintAmount ?? 1,
        scalars.g_flBlendSoftness ?? 0.5,
        features.F_VERTEX_COLOR ?? 0,
        ...(vectors.g_vTexCoordScale ?? [1, 1]).slice(0, 2),
        ...(vectors.g_vTexCoordOffset ?? [0, 0]).slice(0, 2),
        ...(vectors.g_vLayer1DetailScale ?? [1, 1]).slice(0, 2),
        vectors.g_vLayer1DetailTintAndBlend?.[3] ?? 0,
        0,
        ...linearTint('g_vLayer1Tint'),
        1,
        scalars.g_flMetalness ?? 0,
        0,
        (features.g_nUVSet1 ?? 0) > 1 ? 1 : 0,
        0,
        ...linearTint('g_vLayer2Tint'),
        1,
        ...manifest.roles.slice(8, 11).map((key) => bindings[key]?.[1] ?? -1),
        features.F_FANCY_BLENDING ?? 0,
        ...(vectors.g_vMask1Scale ?? [1, 1]).slice(0, 2),
        ...(vectors.g_vMask2Scale ?? [1, 1]).slice(0, 2),
        ...(vectors.g_vMask3Scale ?? [1, 1]).slice(0, 2),
        scalars.g_flColorBoost ?? 1,
        scalars.g_flFadeDistance ?? 1,
        scalars.g_flFadeMin ?? 0,
        scalars.g_flFadeMax ?? 1,
        scalars.g_flFadeFalloff ?? 1,
        scalars.g_flFresnelExponent ?? 0.001,
        scalars.g_flFresnelMin ?? 0,
        scalars.g_flFresnelMax ?? 1,
        scalars.g_flFresnelFalloff ?? 1,
        features.F_ADDITIVE_BLEND ?? 0,
        ...(vectors.g_flTranslucencyRemap ?? [0, 1]).slice(0, 2),
        features.F_USE_ALBEDO_FOR_TRANSMISSIVE ?? 0,
        features.F_TRANSMISSIVE_BACKFACE_NDOTL ?? 0,
        material.shader.includes('generic') && !material.shader.startsWith('csgo_unlit')
          ? (features.F_SPECULAR_INDIRECT ?? 0)
          : 1,
        features.F_SPECULAR_DIRECT ?? (material.shader.includes('generic') ? 0 : 1),
        features.F_TINT_MASK ?? 0,
        scalars.g_flBumpStrength ?? 1,
        ...['Layer1', 'Layer1Normal', 'Layer2', 'Layer2Normal', 'BlendModulate', 'Normal'].flatMap(
          (prefix) => {
            const scale = vectors['g_v' + prefix + 'TexCoordScale'] ?? [1, 1],
              center = vectors['g_v' + prefix + 'TexCoordCenter'] ?? [0.5, 0.5],
              offset = vectors['g_v' + prefix + 'TexCoordOffset'] ?? [0, 0];
            const a = (scalars['g_fl' + prefix + 'TexCoordRotation'] ?? 0) * rad,
              c = Math.cos(a),
              sin = Math.sin(a);
            return [
              c * scale[0],
              -sin * scale[1],
              center[0] * (1 - c * scale[0]) + sin * scale[1] * center[1] + offset[0],
              0,
              sin * scale[0],
              c * scale[1],
              sin * scale[0] * center[0] + center[1] * (1 - c * scale[1]) + offset[1],
              0,
            ];
          },
        ),
        material.shader === 'csgo_vertexlitgeneric.vfx' ? 1 : 0,
        features.F_TEXTURETRANSFORMS ?? 0,
        features.F_FORCE_UV2 ?? 0,
        features.F_RENDER_BACKFACES && !features.F_DONT_FLIP_BACKFACE_NORMALS ? 1 : 0,
        ...manifest.roles.slice(11, 15).map((key) => bindings[key]?.[1] ?? -1),
        bindings.rough?.[1] ?? -1,
        features.F_SELF_ILLUM ?? 0,
        features.F_DETAIL_TEXTURE ?? 0,
        features.g_bMetalness1 ?? 1,
        ...linearTint('g_vSelfIllumTint').map(
          (x) =>
            x * (scalars.g_flSelfIllumScale ?? 1) * 2 ** (scalars.g_flSelfIllumBrightness ?? 0),
        ),
        scalars.g_flSelfIllumAlbedoFactor ?? 1,
        ...(vectors.g_vDetailTexCoordScale ?? [1, 1]).slice(0, 2),
        scalars.g_flDetailBlendFactor ?? 1,
        scalars.g_flDetailBlendToFull ?? 0,
        ...(vectors.g_vDetailTexCoordOffset ?? [0, 0]).slice(0, 2),
        Math.cos((scalars.g_flDetailTexCoordRotation ?? 0) * rad),
        Math.sin((scalars.g_flDetailTexCoordRotation ?? 0) * rad),
        scalars.g_flAmbientOcclusionScale ?? 0,
        0,
        0,
        0,
      ];
    }),
  );
}
