import { basename, join } from 'node:path';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };
import { regularFile } from './toolchain-security.mjs';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';

// This subset has ordinary repeating UV0 and uses the R/G modulation-mask combo.
// Other transforms, blend families and detail stages retain their glTF fallback.
const sourceRoles = {
  layerColorTexture: 'g_tLayer2Color',
  layerBlendTexture: 'g_tBlendModulation',
  layerDetailTexture: 'g_tLayer1Detail',
};
const resourceKey = /^materials\/[a-z0-9_./-]{1,240}\.vtex_c$/;

export async function discoverMapLayerSources(input) {
  const { document } = await readAtmosphereGlb(input);
  const sources = new Set();
  for (const material of document.materials) {
    const vmat = material.extras?.vmat;
    if (
      vmat?.ShaderName !== 'csgo_lightmappedgeneric.vfx' ||
      vmat.IntParams?.F_LAYERS !== 1 ||
      vmat.IntParams?.F_FANCY_BLENDING !== 1
    )
      continue;
    for (const role of Object.values(sourceRoles)) {
      const key = vmat.TextureParams?.[role] + '_c';
      if (resourceKey.test(key) && !key.split('/').includes('..')) sources.add(key);
    }
  }
  return [...sources].sort().slice(0, 24);
}
function supportedLayer(primitive, vmat) {
  const blend = primitive.getAttribute(format.layerAttribute);
  const flags = vmat.IntParams ?? {};
  const vectors = vmat.VectorParams ?? {};
  const neutralTint = (tint) => !tint || [0, 1, 2].every((index) => tint[index] === 1);
  if (
    flags.F_LAYERS !== 1 ||
    flags.F_FANCY_BLENDING !== 1 ||
    (flags.F_DETAILTEXTURE ?? 0) > 1 ||
    flags.F_LAYER_BORDER ||
    flags.F_TEXTURETRANSFORMS ||
    flags.g_nTextureAddressModeU ||
    flags.g_nTextureAddressModeV ||
    !neutralTint(vectors.g_vLayer1Tint) ||
    !neutralTint(vectors.g_vLayer2Tint) ||
    !neutralTint(vectors.g_vLayer1DetailTintAndBlend) ||
    blend?.getType() !== 'VEC4' ||
    blend.getComponentType() !== 5126 ||
    blend.getCount() !== primitive.getAttribute('POSITION').getCount()
  )
    return;
  const scale = vectors.g_vLayer1DetailScale?.slice(0, 2);
  const strength = vectors.g_vLayer1DetailTintAndBlend?.[3];
  if (
    flags.F_DETAILTEXTURE &&
    (scale?.length !== 2 ||
      !scale.every((value) => value > 0 && value <= 32) ||
      !(strength >= 0 && strength <= 1))
  )
    return;
  return { detail: Boolean(flags.F_DETAILTEXTURE), scale, strength };
}

export async function readMapLayerImages(folder) {
  const images = new Map();
  const list = await regularFile(join(folder, 'inputs.json'), 8192);
  let keys;
  try {
    keys = JSON.parse(await list.handle.readFile('utf8'));
  } finally {
    await list.handle.close();
  }
  if (
    !Array.isArray(keys) ||
    keys.length > 24 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !resourceKey.test(key) || key.split('/').includes('..'))
  )
    throw Error('Invalid prepared layer source list.');
  let total = 0;
  for (const [index, key] of keys.entries()) {
    const path = join(folder, `${index}.png`);
    const { handle, stat } = await regularFile(path, 12 * 1024 ** 2);
    try {
      total += stat.size;
      if (total > 64 * 1024 ** 2) throw Error('Native layer images exceed their aggregate bound.');
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size) throw Error('Native layer image changed.');
      images.set(key, { bytes });
    } finally {
      await handle.close();
    }
  }
  return images;
}

export function mapLayerBinding(primitive, vmat, images) {
  const parameters = supportedLayer(primitive, vmat);
  if (!parameters) return;
  const layers = Object.entries(sourceRoles)
    .filter(([slot]) => slot !== 'layerDetailTexture' || parameters.detail)
    .map(([slot, role]) => {
      const key = vmat.TextureParams?.[role] + '_c';
      return { slot, role, key, image: images.get(key) };
    });
  if (layers.every(({ image }) => image)) return { layers, parameters };
}

export function mapLayerBinder(document) {
  const textures = new Map();
  return (lighting, { layers, parameters }) => {
    for (const { slot, key, image } of layers) {
      let texture = textures.get(key);
      if (!texture) {
        texture = document
          .createTexture(basename(key, '.vtex_c'))
          .setMimeType('image/png')
          .setImage(image.bytes);
        textures.set(key, texture);
      }
      lighting.setLayerTexture(slot, texture);
      lighting.getLayerTextureInfo(slot).setMinFilter(9987).setMagFilter(9729);
    }
    if (parameters.detail) lighting.setLayerDetail(parameters.scale, parameters.strength);
  };
}
