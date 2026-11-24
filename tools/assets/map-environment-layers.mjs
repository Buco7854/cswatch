import sharp from 'sharp';
import { colorAdjustment, colorAxes, saturationWeights } from './material-color-adjust.mjs';
import { linearToSrgb, srgbToLinear } from './environment-space.mjs';
import {
  MapEnvironmentAlbedoExtension,
  environmentLayerExtension,
} from './map-environment-layer-extension.mjs';
import { nativeLightingKey } from './native-map-lighting-layout.mjs';

const shader = 'csgo_environment_blend.vfx';
const validPath = /^materials\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.vtex$/;

function source(vmat, name) {
  const path = vmat.TextureParams?.[name];
  return typeof path === 'string' && validPath.test(path) ? path + '_c' : undefined;
}
const finite = (v) => Number.isFinite(v) && Math.abs(v) <= 1024;
const pair = (a) => Array.isArray(a) && a.length >= 2 && a.slice(0, 2).every(finite);
function transform(v, name, i, fallbackChannel) {
  const ints = v.IntParams ?? {},
    vectors = v.VectorParams ?? {},
    floats = v.FloatParams ?? {};
  const overlay = name === 'Overlay',
    key = (field) => (overlay ? 'g_vOverlayTexCoord' + field : 'g_vTexCoord' + field + i);
  const channel = ints[overlay ? 'g_nColorOverlayUVSet' : 'g_nUVSet' + i] ?? fallbackChannel;
  const scale = vectors[key('Scale')] ?? [1, 1],
    offset = vectors[key('Offset')] ?? [0, 0],
    center = vectors[key('Center')] ?? [0.5, 0.5];
  const rotation =
    floats[overlay ? 'g_flOverlayTexCoordRotation' : 'g_flTexCoordRotation' + i] ?? 0;
  if (
    ![1, 2].includes(channel) ||
    !pair(scale) ||
    !pair(offset) ||
    !pair(center) ||
    !finite(rotation)
  )
    return;
  const angle = (rotation * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  return {
    channel,
    uv: [
      cos * scale[0],
      -sin * scale[1],
      sin * scale[0],
      cos * scale[1],
      center[0] - cos * center[0] + sin * center[1] + offset[0],
      center[1] - sin * center[0] - cos * center[1] + offset[1],
    ],
  };
}
function upper(v, i) {
  const uv = transform(v, 'layer', i, 1),
    color = source(v, 'g_tColor' + i),
    height = source(v, 'g_tHeight' + i);
  if (!uv || !color || !height) return;
  const f = v.FloatParams ?? {},
    vectors = v.VectorParams ?? {},
    flags = v.IntParams ?? {};
  const facing = flags['F_BLEND_BY_FACING_DIRECTION_' + i]
    ? (vectors['g_vFacingDirection' + i]?.slice(0, 3) ?? [0, 0, 1])
    : [0, 0, 0];
  const values = [
    f['g_flHeightMapScale' + i] ?? 1,
    f['g_flHeightMapZeroPoint' + i] ?? 0.5,
    f['g_flBlendSoftness' + i] ?? 0.01,
    f['g_flUnderlyingHeightMapInfluence' + i] ?? 1,
    f['g_flMaskWithHeight' + i] ?? 0,
    f['g_flColorOverlay' + i] ?? 0,
    f['g_flColorReplace' + i] ?? 1,
    f['g_flFacingDirectionMaskSpread' + i] ?? 0.5,
    f['g_vFacingDirectionMaskSoftness' + i] ?? 0.1,
  ];
  if (!values.every(finite) || facing.length !== 3 || !facing.every(finite)) return;
  return { ...uv, color, height, values, facing: [facing[0], facing[2], -facing[1]] };
}

/** Only opaque mesh-UV albedo. Other material channels remain in the exported PBR model. */
export function environmentLayerInputs(v) {
  if (v?.ShaderName !== shader) return;
  const base = transform(v, 'layer', 1, 1),
    f = v.FloatParams ?? {},
    flags = v.IntParams ?? {};
  if (
    !base ||
    base.channel !== 1 ||
    base.uv.some((a, i) => Math.abs(a - [1, 0, 0, 1, 0, 0][i]) > 1e-6) ||
    flags.g_nTextureAddressModeU ||
    flags.g_nTextureAddressModeV
  )
    return;
  const baseHeight = source(v, 'g_tHeight1'),
    baseValues = [f.g_flHeightMapScale1 ?? 1, f.g_flHeightMapZeroPoint1 ?? 0.5];
  const layers = [upper(v, 2), ...(flags.F_ENABLE_LAYER_3 ? [upper(v, 3)] : [])];
  let overlay;
  if (flags.F_SHARED_COLOR_OVERLAY && flags.F_USE_NEW_BLENDING === 1) {
    const uv = transform(v, 'Overlay', 0, 2),
      color = source(v, 'g_tSharedColorOverlay'),
      levels = [f.g_flOverlayBrightnessContrast ?? 1, f.g_flOverlayDarknessContrast ?? 1],
      mask = v.VectorParams?.g_vColorOverlayTintMaskStrengths ?? [0, 0, 0],
      strength = v.VectorParams?.g_vColorOverlayLayerStrengths ?? [1, 1, 1];
    // Without authored tint-mask channels, only reproduce a layer-independent overlay.
    if (
      uv &&
      color &&
      levels.every((x) => finite(x) && x > 0) &&
      [f.g_fTintMaskContrast1 ?? 1, f.g_fTintMaskBrightness1 ?? 1].every(finite) &&
      Array.isArray(mask) &&
      Array.isArray(strength) &&
      mask.length >= 3 &&
      strength.length >= 3 &&
      strength.slice(0, 3).every(finite) &&
      mask.slice(0, 3).every((x) => finite(x) && Math.abs(x) <= 1) &&
      mask.slice(1, layers.length + 1).every((x, j) => x === 0 || strength[j + 1] === 0)
    )
      overlay = {
        ...uv,
        color,
        levels,
        strength: strength.slice(0, 3),
        baseMask: mask[0],
        maskLevels: [f.g_fTintMaskContrast1 ?? 1, f.g_fTintMaskBrightness1 ?? 1],
      };
  }
  const painted = baseHeight && baseValues.every(finite) && layers.every(Boolean);
  if (!painted && !overlay) return;
  return {
    baseHeight,
    baseValues,
    layers: painted ? layers : [],
    overlay,
    modern: flags.F_USE_NEW_BLENDING === 1,
  };
}

/** Weight frequently placed materials first. A bounded number of optional sources is unpacked. */
export function environmentLayerSources(document) {
  const use = new Map();
  for (const mesh of document.meshes ?? [])
    for (const prim of mesh.primitives ?? []) {
      const v = document.materials?.[prim.material]?.extras?.vmat;
      if (v?.ShaderName !== shader) continue;
      const count = document.accessors?.[prim.indices]?.count ?? 3;
      use.set(v, (use.get(v) ?? 0) + Math.max(1, Math.min(50000, count)));
    }
  const scores = new Map();
  for (const [v, weight] of use) {
    const inputs = environmentLayerInputs(v);
    if (!inputs) continue;
    for (const path of new Set([
      inputs.overlay?.color,
      inputs.baseHeight,
      ...(inputs.layers.length ? [...inputs.layers.flatMap((l) => [l.height, l.color])] : []),
    ]))
      if (path) scores.set(path, (scores.get(path) ?? 0) + weight);
  }
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
}

const linear = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
function correctTexels(texels, adjust, mask) {
  const [direct, desaturate] = adjust.scale;
  for (let i = 0; i < texels.length; i += 3) {
    const weight = mask
      ? Math.max(
          0,
          Math.min(1, ((mask[i / 3] / 255 - 0.5) * adjust.mask[0] + 0.5) * adjust.mask[1]),
        )
      : 1;
    const grey =
      linear[texels[i]] * saturationWeights[0] +
      linear[texels[i + 1]] * saturationWeights[1] +
      linear[texels[i + 2]] * saturationWeights[2];
    for (let c = 0; c < 3; c++) {
      const v = linear[texels[i + c]],
        result = direct * v + desaturate * grey + adjust.offset[c];
      texels[i + c] = Math.round(linearToSrgb(v + weight * (result - v)) * 255);
    }
  }
}
const mapEdge = 512;
const maximumPreparedTextures = 64;
const textureKey = (color, height, adjust) =>
  (color ?? '') + '|' + (height ?? '') + (adjust ? JSON.stringify(adjust) : '');
export async function prepareEnvironmentAlbedo(document, images, secondaryUv) {
  if (!images?.size) return;
  const cache = new Map(),
    variants = new Map();
  const texture = async (color, height, adjust) => {
    const key = textureKey(color, height, adjust);
    if (cache.has(key)) return cache.get(key);
    const a = images.get(color ?? height);
    if (!a?.bytes || (height && !images.get(height)?.bytes)) return;
    let textureBytes = a.bytes;
    // Alpha is independent data. Remove it before filtering to preserve heights stored under A=0.
    const decoder = (bytes) => sharp(bytes, { limitInputPixels: 32 * 1024 ** 2 });
    if (height) {
      const { width, height: sourceHeight } = await decoder(a.bytes).metadata();
      const ratio = Math.min(1, mapEdge / Math.max(width, sourceHeight));
      const size = {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(sourceHeight * ratio)),
      };
      const rgb = await decoder(a.bytes).removeAlpha().toColourspace('srgb').raw().toBuffer();
      const resized = sharp(rgb, { raw: { width, height: sourceHeight, channels: 3 } }).resize({
        ...size,
        fit: 'fill',
      });
      if (!color) textureBytes = await resized.png().toBuffer();
      else {
        const heightSource = await decoder(images.get(height).bytes)
          .extractChannel(0)
          .raw()
          .toBuffer({ resolveWithObject: true });
        const mask = await sharp(heightSource.data, {
          raw: { width: heightSource.info.width, height: heightSource.info.height, channels: 1 },
        })
          .resize({ ...size, fit: 'fill' })
          .greyscale()
          .raw()
          .toBuffer();
        // Reserve zero alpha to keep color alive when encoding. The fragment shader removes the bias.
        for (let i = 0; i < mask.length; i++) mask[i] = 1 + Math.round((254 * mask[i]) / 255);
        const texels = await resized.raw().toBuffer();
        if (adjust) {
          let tintMask;
          if (adjust.mode === 0) {
            const decoded = await decoder(images.get(height).bytes)
              .extractChannel(1)
              .raw()
              .toBuffer({ resolveWithObject: true });
            tintMask = await sharp(decoded.data, {
              raw: { width: decoded.info.width, height: decoded.info.height, channels: 1 },
            })
              .resize({ ...size, fit: 'fill' })
              .greyscale()
              .raw()
              .toBuffer();
          }
          correctTexels(texels, adjust, tintMask);
        }
        textureBytes = await sharp(texels, { raw: { ...size, channels: 3 } })
          .joinChannel(mask, { raw: { ...size, channels: 1 } })
          .png()
          .toBuffer();
      }
    }
    const tex = document
      .createTexture((color ?? height).split('/').pop() + (color && height ? '_height' : ''))
      .setImage(textureBytes)
      .setMimeType('image/png');
    cache.set(key, tex);
    return tex;
  };
  let paintedPrimitives = 0,
    overlayPrimitives = 0;
  for (const mesh of document.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const original = primitive.getMaterial(),
        v = original?.getExtras().vmat;
      if (
        v?.ShaderName !== shader ||
        original.getAlphaMode() !== 'OPAQUE' ||
        !original.getBaseColorTexture()
      )
        continue;
      const inputs = environmentLayerInputs(v);
      if (
        !inputs ||
        original.getBaseColorTextureInfo().getTexCoord() !== 0 ||
        original.getBaseColorTextureInfo().getExtension('KHR_texture_transform')
      )
        continue;
      const count = primitive.getAttribute('POSITION')?.getCount(),
        uv = primitive.getAttribute('TEXCOORD_0');
      if (uv?.getType() !== 'VEC2' || uv.getCount() !== count) continue;
      const paint = primitive.getAttribute('_TEXCOORD_4');
      const proof = secondaryUv?.get(
        nativeLightingKey(mesh.getName(), v.Name, primitive.getIndices()?.getCount(), count),
      );
      const second =
        Number.isInteger(proof) && proof >= 0 ? primitive.getAttribute('TEXCOORD_' + proof) : null;
      const validChannel = (channel) =>
        channel === 1 || (second?.getType() === 'VEC2' && second.getCount() === count);
      const painted =
        inputs.layers.length > 0 &&
        paint?.getType() === 'VEC4' &&
        paint.getCount() === count &&
        Boolean(images.get(inputs.baseHeight)?.bytes) &&
        inputs.layers.every(
          (l) =>
            validChannel(l.channel) &&
            Boolean(images.get(l.color)?.bytes) &&
            Boolean(images.get(l.height)?.bytes),
        );
      const overlay =
        inputs.overlay &&
        validChannel(inputs.overlay.channel) &&
        Boolean(images.get(inputs.overlay.color)?.bytes) &&
        (!inputs.overlay.baseMask || Boolean(images.get(inputs.baseHeight)?.bytes))
          ? inputs.overlay
          : undefined;
      if (!painted && !overlay) continue;
      // Without proven upper UVs apply the base overlay only on unpainted fragments.
      const baseOnlyOverlay = Boolean(
        overlay && !painted && paint?.getType() === 'VEC4' && paint.getCount() === count,
      );
      if (overlay && !painted && !baseOnlyOverlay) continue;
      const useSecondary =
        (painted && inputs.layers.some((l) => l.channel === 2)) || overlay?.channel === 2;
      const variantKey = [
        painted,
        Boolean(overlay),
        baseOnlyOverlay,
        Boolean(useSecondary && second),
      ].join('/');
      let byKey = variants.get(original);
      if (!byKey) variants.set(original, (byKey = new Map()));
      if (!byKey.has(variantKey)) {
        // Several materials may combine the same input images differently. Bound the derived
        // textures as well as the source list; admit an entire material or retain its core PBR.
        const required = new Set();
        if (painted || overlay?.baseMask) required.add(textureKey(null, inputs.baseHeight));
        if (painted)
          for (const [i, layer] of inputs.layers.entries())
            required.add(
              textureKey(
                layer.color,
                layer.height,
                colorAxes(colorAdjustment(v, i + 2), images.get(layer.color)?.reflectivity),
              ),
            );
        if (overlay) required.add(textureKey(overlay.color, null));
        if (
          cache.size + [...required].filter((key) => !cache.has(key)).length >
          maximumPreparedTextures
        )
          continue;
        const baseColor = source(v, 'g_tColor1');
        const baseCorrection = colorAxes(
          colorAdjustment(v, 1),
          images.get(baseColor)?.reflectivity,
        );
        const params = {
          ...(baseCorrection && (painted || overlay?.baseMask) ? { baseCorrection } : {}),
          baseOnlyOverlay,
          modern: inputs.modern,
          secondaryAttribute: Boolean(useSecondary && second),
          base: inputs.baseValues,
          layers: [],
        };
        const binding = document.createExtension(MapEnvironmentAlbedoExtension).createBinding();
        const bind = (slot, tex) => {
          binding.setTexture(slot, tex);
          binding.getTextureInfo(slot).setMinFilter(9987).setMagFilter(9729);
        };
        if (painted || overlay?.baseMask)
          bind('baseHeight', await texture(null, inputs.baseHeight));
        if (painted) {
          for (const [i, layer] of inputs.layers.entries()) {
            const { color, height, ...parameters } = layer;
            params.layers.push(parameters);
            const adjust = colorAxes(colorAdjustment(v, i + 2), images.get(color)?.reflectivity);
            bind('paintLayer' + (i + 2), await texture(color, height, adjust));
          }
        }
        if (overlay) {
          const { color, ...parameters } = overlay;
          params.overlay = parameters;
          bind('colorOverlay', await texture(color, null));
        }
        binding.setParameters(params);
        const material = original.clone().setExtension(environmentLayerExtension, binding);
        byKey.set(variantKey, material);
      }
      if (useSecondary && second) primitive.setAttribute('_CSWATCH_UV_SECOND', second);
      primitive.setMaterial(byKey.get(variantKey));
      if (painted) paintedPrimitives++;
      if (overlay) overlayPrimitives++;
    }
  if (paintedPrimitives || overlayPrimitives)
    return { paintedPrimitives, overlayPrimitives, textures: cache.size };
}
