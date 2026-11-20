import { type MeshStandardMaterial, type Texture, Vector2 } from 'three';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };

export type LayerTextureIds = {
  color: number;
  blend: number;
  detail?: number;
  scale?: [number, number];
  strength?: number;
};

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
  const detail = textureId(metadata.layerDetailTexture, 0);
  const scale = metadata.detailScale;
  const strength = metadata.detailStrength;
  if (
    detail !== undefined &&
    detail !== color &&
    detail !== blend &&
    Array.isArray(scale) &&
    scale.length === 2 &&
    scale.every((value) => typeof value === 'number' && value > 0 && value <= 32) &&
    typeof strength === 'number' &&
    strength >= 0 &&
    strength <= 1
  )
    return { color, blend, detail, scale: [scale[0], scale[1]], strength };
  return { color, blend };
}

type Shader = Parameters<MeshStandardMaterial['onBeforeCompile']>[0];
export type MaterialLayers = {
  color: Texture;
  blend: Texture;
  detail?: Texture;
  scale?: [number, number];
  strength?: number;
};

export function applyLayerShader(shader: Shader, layers: MaterialLayers) {
  shader.uniforms.cswatchLayerColor = { value: layers.color };
  shader.uniforms.cswatchLayerBlend = { value: layers.blend };
  if (layers.detail) {
    shader.uniforms.cswatchLayerDetail = { value: layers.detail };
    shader.uniforms.cswatchDetailScale = { value: new Vector2(...layers.scale!) };
    shader.uniforms.cswatchDetailStrength = { value: layers.strength };
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
        ${layers.detail ? 'diffuseColor.rgb *= mix(vec3(1.0), 2.0 * texture2D(cswatchLayerDetail, vMapUv * cswatchDetailScale).rgb, cswatchDetailStrength);' : ''}
      `,
    );
}
