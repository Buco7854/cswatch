import { type MeshStandardMaterial, type Texture, Vector2 } from 'three';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };

type Detail<T> = { texture: T; scale: [number, number]; strength: number };
type Layers<T> = { color: T; blend: T; detail?: Detail<T>; secondDetail?: Detail<T> };
export type LayerTextureIds = Layers<number>;
export type MaterialLayers = Layers<Texture>;

type TextureId = (value: unknown, channel: number) => number | undefined;

export function readLayerTextureIds(
  value: unknown,
  textureId: TextureId,
): LayerTextureIds | undefined {
  if (typeof value !== 'object' || !value) return;
  const metadata = value as Record<string, unknown>;
  const color = textureId(metadata.layerColorTexture, 0);
  const blend = textureId(metadata.layerBlendTexture, 0);
  if (color === undefined || blend === undefined || color === blend) return;
  const readDetail = (
    id: unknown,
    scale: unknown,
    strength: unknown,
  ): Detail<number> | undefined => {
    const texture = textureId(id, 0);
    if (
      texture === undefined ||
      texture === color ||
      texture === blend ||
      !Array.isArray(scale) ||
      scale.length !== 2 ||
      !scale.every((n) => typeof n === 'number' && n > 0 && n <= 32) ||
      typeof strength !== 'number' ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1
    )
      return;
    return { texture, scale: [scale[0], scale[1]], strength };
  };
  const detail = readDetail(
    metadata.layerDetailTexture,
    metadata.detailScale,
    metadata.detailStrength,
  );
  const secondDetail = readDetail(
    metadata.secondDetailTexture,
    metadata.secondDetailScale,
    metadata.secondDetailStrength,
  );
  if (metadata.secondDetailTexture !== undefined && (!detail || !secondDetail)) return;
  return { color, blend, detail, secondDetail };
}

type Shader = Parameters<MeshStandardMaterial['onBeforeCompile']>[0];
export function applyLayerShader(shader: Shader, layers: MaterialLayers) {
  shader.uniforms.cswatchLayerColor = { value: layers.color };
  shader.uniforms.cswatchLayerBlend = { value: layers.blend };
  if (layers.detail) {
    shader.uniforms.cswatchLayerDetail = { value: layers.detail.texture };
    shader.uniforms.cswatchDetailScale = { value: new Vector2(...layers.detail.scale) };
    shader.uniforms.cswatchDetailStrength = { value: layers.detail.strength };
  }
  if (layers.secondDetail) {
    shader.uniforms.cswatchSecondDetail = { value: layers.secondDetail.texture };
    shader.uniforms.cswatchSecondDetailScale = { value: new Vector2(...layers.secondDetail.scale) };
    shader.uniforms.cswatchSecondDetailStrength = { value: layers.secondDetail.strength };
  }
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute vec4 ' +
        format.layerAttribute.toLowerCase() +
        ';\nvarying float cswatchSourceBlend;',
    )
    .replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\ncswatchSourceBlend = ' + format.layerAttribute.toLowerCase() + '.r;',
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
        uniform sampler2D cswatchLayerColor;
        uniform sampler2D cswatchLayerBlend;
        varying float cswatchSourceBlend;
        ${layers.detail ? 'uniform sampler2D cswatchLayerDetail; uniform vec2 cswatchDetailScale; uniform float cswatchDetailStrength;' : ''}
        ${layers.secondDetail ? 'uniform sampler2D cswatchSecondDetail; uniform vec2 cswatchSecondDetailScale; uniform float cswatchSecondDetailStrength;' : ''}
      `,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
        vec2 maskAndSoftness = texture2D(cswatchLayerBlend, vMapUv).gr;
        float low = max(0.0, maskAndSoftness.x - maskAndSoftness.y);
        float high = min(1.0, maskAndSoftness.x + maskAndSoftness.y);
        float paintedLayer = smoothstep(low, max(high, low + 0.00001), cswatchSourceBlend);
        diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(cswatchLayerColor, vMapUv).rgb * diffuse, paintedLayer);
        ${
          layers.detail
            ? `
          vec3 detailColor = texture2D(cswatchLayerDetail, vMapUv * cswatchDetailScale).rgb;
          float detailStrength = cswatchDetailStrength;
          ${
            layers.secondDetail
              ? `
            detailColor = mix(detailColor, texture2D(cswatchSecondDetail, vMapUv * cswatchSecondDetailScale).rgb, paintedLayer);
            detailStrength = mix(detailStrength, cswatchSecondDetailStrength, paintedLayer);`
              : ''
          }
          diffuseColor.rgb *= mix(vec3(1.0), 2.0 * detailColor, detailStrength);`
            : ''
        }
      `,
    );
}
