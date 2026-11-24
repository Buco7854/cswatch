import sharp from 'sharp';
import { linearToSrgb, srgbToLinear } from './environment-space.mjs';

const maxInputPixels = 4096 ** 2;
const maxTierPixels = 24 * 1024 ** 2;
const linear = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
const encoded = Uint8Array.from({ length: 8193 }, (_, i) =>
  Math.round(linearToSrgb(i / 8192) * 255),
);

export function mapTintMaskKey(vmat, factor) {
  if (
    !vmat ||
    !Array.isArray(factor) ||
    factor.length !== 4 ||
    !factor.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
    factor.slice(0, 3).every((v) => v === 1)
  )
    return;
  const flags = vmat.IntParams ?? {};
  const floats = vmat.FloatParams ?? {};
  const uniform = vmat.VectorParams?.g_vColorTint;
  // S2V combines material and instance tints into one baseColorFactor. Only
  // invert that mapping when the factor represents the full instance tint.
  if (
    (uniform && ![0, 1, 2].every((i) => uniform[i] === 1)) ||
    (floats.g_flModelTintAmount ?? 1) !== 1
  )
    return;
  let texture;
  if (
    vmat.ShaderName === 'csgo_environment.vfx' &&
    (flags.g_bModelTint1 ?? 1) === 1 &&
    (flags.g_nColorCorrectionMode1 ?? 0) === 0 &&
    (floats.g_fTintMaskBrightness1 ?? 1) === 1 &&
    (floats.g_fTintMaskContrast1 ?? 1) === 1 &&
    !Object.keys(floats).some(
      (name) => name.startsWith('g_fTextureColor') && !name.includes('Normal'),
    )
  ) {
    texture = vmat.TextureParams?.g_tHeight1;
  } else if (vmat.ShaderName === 'csgo_foliage.vfx' && flags.F_TINT_MASK === 1) {
    texture = vmat.TextureParams?.g_tTintMask;
  }
  if (
    typeof texture === 'string' &&
    /^(?:models|materials)\/[a-z0-9_./-]{1,240}\.vtex$/.test(texture) &&
    texture.split('/').every((part) => part && part !== '.' && part !== '..')
  )
    return texture + '_c';
}

// Height-layer shaders preserve the base luminance when recoloring. Foliage
// multiplies it by the instance color. Work in linear light and leave alpha intact.
function tintPixels(pixels, mask, tint, heightLayer) {
  const weights = [0.2125, 0.7154, 0.0721];
  const hue = tint.map((c) => Math.max(0.001, c));
  const hueLuma = hue.reduce((sum, c, i) => sum + weights[i] * c, 0);
  const scale = Math.min(1 / hueLuma, (3 * Math.max(...tint)) / Math.hypot(...hue));
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const k = i * 4;
    const amount = mask[i] / 255;
    const luma = heightLayer
      ? linear[pixels[k]] * weights[0] +
        linear[pixels[k + 1]] * weights[1] +
        linear[pixels[k + 2]] * weights[2]
      : 0;
    for (let c = 0; c < 3; c++) {
      const base = linear[pixels[k + c]];
      const target = heightLayer ? hue[c] * luma * scale : base * tint[c];
      const value = Math.min(1, base + (target - base) * amount);
      pixels[k + c] = encoded[Math.round(value * 8192)];
    }
  }
}

/** Bake the native per-texel mask into a bounded number of ordinary albedos.
 * Shared material variants can share a result. Other slots keep their source texture. */
export async function bakeMapTintMasks(document, images, tier) {
  if (!images?.size) return;
  let total = 0;
  const cache = new Map();
  const limit = tier === 'mobile' ? 1024 : 2048;
  const dimensions = new Map();
  // Inspect headers before decoding. Oversized inputs keep the ordinary glTF material.
  async function imageSize(bytes) {
    if (!dimensions.has(bytes)) {
      const { width, height } = await sharp(bytes, { limitInputPixels: false }).metadata();
      dimensions.set(
        bytes,
        width && height && width * height <= maxInputPixels ? { width, height } : null,
      );
    }
    return dimensions.get(bytes);
  }
  for (const material of document.getRoot().listMaterials()) {
    const vmat = material.getExtras().vmat;
    const factor = material.getBaseColorFactor();
    const key = mapTintMaskKey(vmat, factor);
    const mask = images.get(key);
    const source = material.getBaseColorTexture();
    if (!key || !mask || !source?.getImage()) continue;
    const heightLayer = vmat.ShaderName === 'csgo_environment.vfx';
    const color = factor.slice(0, 3);
    const id = JSON.stringify([key, color, heightLayer]);
    let variants = cache.get(source);
    if (!variants) cache.set(source, (variants = new Map()));
    let texture = variants.get(id);
    if (!texture) {
      const size = await imageSize(source.getImage());
      if (!size || !(await imageSize(mask.bytes))) continue;
      const { width, height } = size;
      const resize = Math.min(1, limit / Math.max(width, height));
      const w = Math.max(1, Math.round(width * resize));
      const h = Math.max(1, Math.round(height * resize));
      if (w * h > maxTierPixels - total) continue;
      const pixels = await sharp(source.getImage(), { limitInputPixels: maxInputPixels })
        .resize(w, h, { fit: 'fill' })
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer();
      const { data, info } = await sharp(mask.bytes, { limitInputPixels: maxInputPixels })
        .extractChannel(heightLayer ? 'green' : 'red')
        .raw()
        .toBuffer({ resolveWithObject: true });
      // Alpha on a packed data texture may be zero even where its mask is one.
      // Resize the independent channel to avoid premultiplying it by unrelated data.
      const channel =
        info.width === w && info.height === h
          ? data
          : await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
              .resize(w, h, { fit: 'fill' })
              .greyscale()
              .raw()
              .toBuffer();
      tintPixels(pixels, channel, color, heightLayer);
      const baked = await sharp(pixels, { raw: { width: w, height: h, channels: 4 } })
        .png()
        .toBuffer();
      texture = document
        .createTexture(source.getName() + '-masked-tint')
        .setImage(baked)
        .setMimeType('image/png');
      variants.set(id, texture);
      total += w * h;
    }
    material.setBaseColorTexture(texture).setBaseColorFactor([1, 1, 1, factor[3]]);
    material.setExtras({ ...material.getExtras(), cswatchTintMask: key });
  }
}
