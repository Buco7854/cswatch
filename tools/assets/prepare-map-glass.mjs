import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { regularFile } from './toolchain-security.mjs';

const path = /^(?:materials|models)\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.(?:vmat|vtex)$/;
const white = [1, 1, 1, 1];
const bytes = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);

// Texture color, mask and normal parameters have already been compiled into
// the three referenced inputs. Refraction and unfamiliar
// shader features require a different blend equation.
export function sourceGlassInputs(material) {
  const vmat = material.extras?.vmat,
    pbr = material.pbrMetallicRoughness;
  if (
    vmat?.ShaderName !== 'csgo_glass.vfx' ||
    material.alphaMode !== 'BLEND' ||
    pbr?.baseColorTexture ||
    (material.extensions && Object.keys(material.extensions).length) ||
    (pbr?.baseColorFactor &&
      (!Array.isArray(pbr.baseColorFactor) ||
        pbr.baseColorFactor.length !== 4 ||
        pbr.baseColorFactor.some((n, i) => n !== white[i]))) ||
    Object.entries(vmat.FloatParams ?? {}).some(
      ([k, v]) => k !== 'g_flModelTintAmount' || v !== 1,
    ) ||
    Object.entries(vmat.IntParams ?? {}).some(
      ([k, v]) =>
        ![
          'F_DO_NOT_CAST_SHADOWS',
          'F_RENDER_BACKFACES',
          'g_bFogEnabled',
          'g_nTextureAddressModeU',
          'g_nTextureAddressModeV',
        ].includes(k) || !(v === 0 || v === 1),
    ) ||
    Object.keys(vmat.VectorParams ?? {}).some(
      (k) =>
        ![
          'g_vTexCoordOffset',
          'g_vTexCoordScale',
          'GlassTintColor',
          'GlassMaskColor',
          'GlassMaskTranslucency',
          'GlassMaskTransmission',
          'TextureRoughness',
          'TextureNormal',
          'g_flTranslucencyRemap',
        ].includes(k),
    ) ||
    Object.keys(vmat.TextureParams ?? {}).some(
      (k) => !['g_tGlassDust', 'g_tGlassTintColor', 'g_tNormal'].includes(k),
    )
  )
    return;
  const name = vmat.Name,
    dust = vmat.TextureParams?.g_tGlassDust,
    tint = vmat.TextureParams?.g_tGlassTintColor;
  if (
    ![name, dust, tint].every((x) => typeof x === 'string' && x.length <= 256 && path.test(x)) ||
    !name.endsWith('.vmat') ||
    !dust.endsWith('.vtex') ||
    !tint.endsWith('.vtex')
  )
    return;
  const vectors = vmat.VectorParams ?? {};
  const remap = vectors.g_flTranslucencyRemap ?? [0, 1, 0, 0];
  if (
    !Array.isArray(remap) ||
    remap.length !== 4 ||
    remap.some((v) => !Number.isFinite(v)) ||
    remap[0] < 0 ||
    remap[0] > remap[1] ||
    remap[1] > 1 ||
    remap[2] !== 0 ||
    remap[3] !== 0
  )
    return;
  const plainUv =
    (vmat.IntParams?.g_nTextureAddressModeU ?? 0) === 0 &&
    (vmat.IntParams?.g_nTextureAddressModeV ?? 0) === 0 &&
    (!vectors.g_vTexCoordOffset ||
      (Array.isArray(vectors.g_vTexCoordOffset) &&
        vectors.g_vTexCoordOffset.length === 4 &&
        vectors.g_vTexCoordOffset.slice(0, 2).every((n) => n === 0))) &&
    (!vectors.g_vTexCoordScale ||
      (Array.isArray(vectors.g_vTexCoordScale) &&
        vectors.g_vTexCoordScale.length === 4 &&
        vectors.g_vTexCoordScale.slice(0, 2).every((n) => n === 1)));
  return {
    name,
    dust,
    tint,
    remap: remap.slice(0, 2),
    plainUv,
    castsShadow: vmat.IntParams?.F_DO_NOT_CAST_SHADOWS !== 1,
  };
}

export async function readGlassBindings(file) {
  const { handle } = await regularFile(file, 64 * 1024);
  try {
    const rows = JSON.parse(await handle.readFile('utf8'));
    if (
      !Array.isArray(rows) ||
      rows.length > 32 ||
      rows.some(
        (r) =>
          !r ||
          !Number.isSafeInteger(r.index) ||
          r.index < 0 ||
          r.index >= 20000 ||
          (r.image ? r.dustRgba !== undefined : !bytes(r.dustRgba)) ||
          !Array.isArray(r.remap) ||
          r.remap.length !== 2 ||
          !r.remap.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
          r.remap[0] > r.remap[1] ||
          (r.image &&
            (!/^dust-(?:[0-9]|[1-3][0-9])\.png$/.test(r.image.file) ||
              !/^[a-f0-9]{64}$/.test(r.image.sha256) ||
              ![r.image.width, r.image.height].every(
                (n) => Number.isInteger(n) && n > 0 && n <= 2048,
              ))) ||
          typeof r.castsShadow !== 'boolean' ||
          ![r.name, r.dust, r.tint].every(
            (v) => typeof v === 'string' && v.length <= 256 && path.test(v),
          ),
      )
    )
      throw Error('Invalid prepared glass data.');
    const images = new Map();
    let totalBytes = 0,
      totalPixels = 0;
    for (const row of rows) {
      if (!row.image) continue;
      const { file: name, sha256, width, height } = row.image;
      let data = images.get(name);
      if (!data) {
        totalPixels += width * height;
        const image = await regularFile(join(dirname(file), name), 20 * 1024 ** 2);
        try {
          totalBytes += image.stat.size;
          if (totalBytes > 32 * 1024 ** 2 || totalPixels > 16 * 1024 ** 2)
            throw Error('Prepared glass images exceed their budget.');
          data = await image.handle.readFile();
        } finally {
          await image.handle.close();
        }
        images.set(name, data);
      }
      if (
        data.length < 33 ||
        data.readUInt32BE(0) !== 0x89504e47 ||
        data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(16) !== width ||
        data.readUInt32BE(20) !== height ||
        createHash('sha256').update(data).digest('hex') !== sha256
      )
        throw Error('Prepared glass image disagrees with its binding.');
      row.imageBytes = data;
    }
    return rows;
  } finally {
    await handle.close();
  }
}

export function bindPreparedGlass(document, rows) {
  if (!rows.length) return;
  const root = document.getRoot();
  const materials = root.listMaterials();
  const vertexTinted = new Set(),
    missingUv = new Set();
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (primitive.getAttribute('COLOR_0')) vertexTinted.add(material);
      if (!primitive.getAttribute('TEXCOORD_0')) missingUv.add(material);
    }
  }
  const textures = new Map();
  for (const row of rows) {
    const material = materials[row.index];
    if (
      !material ||
      material.getBaseColorTexture() ||
      material.listExtensions().length ||
      vertexTinted.has(material)
    )
      continue;
    const inputs = sourceGlassInputs({
      extras: material.getExtras(),
      alphaMode: material.getAlphaMode(),
      pbrMetallicRoughness: { baseColorFactor: material.getBaseColorFactor() },
    });
    if (
      !inputs ||
      ['name', 'dust', 'tint', 'castsShadow'].some((k) => inputs[k] !== row[k]) ||
      !inputs.remap.every((n, i) => row.remap?.[i] === n)
    )
      continue;
    if (row.image) {
      if (!inputs.plainUv || !row.imageBytes || missingUv.has(material)) continue;
      let texture = textures.get(row.image.sha256);
      if (!texture) {
        texture = document.createTexture().setMimeType('image/png').setImage(row.imageBytes);
        textures.set(row.image.sha256, texture);
      }
      material.setBaseColorTexture(texture);
    }
    const [r, g, b, alpha] = row.dustRgba ?? [255, 255, 255, 255];
    const linear = (byte) => {
      const n = byte / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    };
    const extras = material.getExtras();
    material
      .setBaseColorFactor([linear(r), linear(g), linear(b), alpha / 255])
      .setMetallicFactor(0)
      .setExtras({
        ...extras,
        cswatch: {
          ...extras.cswatch,
          [row.image ? 'texturedGlass' : 'constantGlass']: {
            schemaVersion: 1,
            castsShadow: inputs.castsShadow,
          },
        },
      });
  }
}
