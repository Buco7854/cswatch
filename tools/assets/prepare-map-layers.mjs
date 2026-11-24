import { basename, join } from 'node:path';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };
import { regularFile } from './toolchain-security.mjs';
import { environmentLayerSources } from './map-environment-layers.mjs';
import { colorAdjustment } from './material-color-adjust.mjs';
import { mapTintMaskKey } from './prepare-map-tint.mjs';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';

// This subset has ordinary repeating UV0 and uses the R/G modulation-mask combo.
// Other transforms, blend families and detail stages retain their glTF fallback.
const sourceRoles = {
  layerColorTexture: 'g_tLayer2Color',
  layerBlendTexture: 'g_tBlendModulation',
  layerDetailTexture: 'g_tLayer1Detail',
  secondDetailTexture: 'g_tLayer2Detail',
};
const resourceKey = /^(?:materials|models)\/[a-z0-9_./-]{1,240}\.vtex_c$/;

export async function discoverMapLayerImages(input) {
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
      if (role === 'g_tLayer2Detail' && vmat.IntParams.F_DETAILTEXTURE !== 2) continue;
      const key = vmat.TextureParams?.[role] + '_c';
      if (resourceKey.test(key) && !key.split('/').includes('..')) sources.add(key);
    }
  }
  const tintSources = new Set();
  for (const material of document.materials) {
    const key = mapTintMaskKey(
      material.extras?.vmat,
      material.pbrMetallicRoughness?.baseColorFactor,
    );
    if (key) tintSources.add(key);
  }
  const reflectivityOnly = new Set();
  const envImages = environmentLayerSources(document);
  for (const material of document.materials) {
    const v = material.extras?.vmat;
    if (v?.ShaderName !== 'csgo_environment_blend.vfx' || !colorAdjustment(v, 1)) continue;
    const k = v.TextureParams?.g_tColor1 + '_c';
    if (resourceKey.test(k) && !k.split('/').includes('..')) reflectivityOnly.add(k);
  }
  const families = [
    [...sources].sort().slice(0, 24),
    envImages,
    [...tintSources].sort(),
    [...reflectivityOnly].sort(),
  ];
  const keys = new Set();
  for (let i = 0; i < 96 && keys.size < 96; i++)
    for (const group of families) if (group[i] && keys.size < 96) keys.add(group[i]);
  return [...keys].map((key) => ({
    key,
    headerOnly:
      reflectivityOnly.has(key) &&
      !sources.has(key) &&
      !tintSources.has(key) &&
      !envImages.includes(key),
    edge: sources.has(key) || tintSources.has(key) ? 1024 : 512,
  }));
}
export async function discoverMapLayerSources(input) {
  return (await discoverMapLayerImages(input)).map((row) => row.key);
}
function supportedLayer(primitive, vmat) {
  const blend = primitive.getAttribute(format.layerAttribute);
  const flags = vmat.IntParams ?? {};
  const vectors = vmat.VectorParams ?? {};
  const neutralTint = (tint) => !tint || [0, 1, 2].every((index) => tint[index] === 1);
  if (
    vmat.ShaderName !== 'csgo_lightmappedgeneric.vfx' ||
    flags.F_LAYERS !== 1 ||
    flags.F_FANCY_BLENDING !== 1 ||
    ![0, 1, 2].includes(flags.F_DETAILTEXTURE ?? 0) ||
    flags.F_LAYER_BORDER ||
    flags.F_TEXTURETRANSFORMS ||
    flags.g_nTextureAddressModeU ||
    flags.g_nTextureAddressModeV ||
    !neutralTint(vectors.g_vLayer1Tint) ||
    !neutralTint(vectors.g_vLayer2Tint) ||
    !neutralTint(vectors.g_vLayer1DetailTintAndBlend) ||
    (flags.F_DETAILTEXTURE === 2 && !neutralTint(vectors.g_vLayer2DetailTintAndBlend)) ||
    blend?.getType() !== 'VEC4' ||
    blend.getComponentType() !== 5126 ||
    blend.getCount() !== primitive.getAttribute('POSITION').getCount()
  )
    return;
  const details = [];
  for (let i = 1; i <= (flags.F_DETAILTEXTURE ?? 0); i++) {
    const vector = vectors[`g_vLayer${i}DetailScale`];
    const scale = Array.isArray(vector) ? vector.slice(0, 2) : undefined;
    const strength = vectors[`g_vLayer${i}DetailTintAndBlend`]?.[3];
    if (
      scale?.length !== 2 ||
      !scale.every((value) => Number.isFinite(value) && value > 0 && value <= 32) ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1
    )
      return;
    details.push({ scale, strength });
  }
  return { details };
}

export async function readMapLayerImages(folder) {
  const images = new Map();
  const list = await regularFile(join(folder, 'inputs.json'), 48 * 1024);
  let keys;
  try {
    keys = JSON.parse(await list.handle.readFile('utf8'));
  } finally {
    await list.handle.close();
  }
  if (
    !Array.isArray(keys) ||
    keys.length > 96 ||
    keys.some(
      (row) =>
        !row ||
        typeof row.key !== 'string' ||
        !resourceKey.test(row.key) ||
        row.key.split('/').includes('..') ||
        (row.reflectivity !== undefined &&
          (!Array.isArray(row.reflectivity) ||
            row.reflectivity.length !== 3 ||
            !row.reflectivity.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))) ||
        (row.headerOnly !== undefined && (row.headerOnly !== true || !row.reflectivity)),
    ) ||
    new Set(keys.map((r) => r.key)).size !== keys.length
  )
    throw Error('Invalid prepared layer source list.');
  let total = 0;
  for (const [index, { key, reflectivity, headerOnly }] of keys.entries()) {
    if (headerOnly) {
      images.set(key, { reflectivity });
      continue;
    }
    const path = join(folder, `${index}.png`);
    const { handle, stat } = await regularFile(path, 12 * 1024 ** 2);
    try {
      total += stat.size;
      if (total > 64 * 1024 ** 2) throw Error('Native layer images exceed their aggregate bound.');
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size) throw Error('Native layer image changed.');
      images.set(key, { bytes, reflectivity });
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
    .filter(
      ([slot]) =>
        (slot !== 'layerDetailTexture' || parameters.details.length > 0) &&
        (slot !== 'secondDetailTexture' || parameters.details.length === 2),
    )
    .map(([slot, role]) => {
      const key = vmat.TextureParams?.[role] + '_c';
      return { slot, role, key, image: images.get(key) };
    });
  if (layers.every(({ image }) => image?.bytes)) return { layers, parameters };
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
    for (const [i, detail] of parameters.details.entries())
      lighting.setLayerDetail(detail.scale, detail.strength, i === 1);
  };
}
