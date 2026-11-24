import { regularFile } from './toolchain-security.mjs';

const path = /^materials\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.(?:vmat|vtex)$/;
const white = [1, 1, 1, 1];
const bytes = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);

// Texture color, mask and normal parameters have already been compiled into
// the three referenced inputs. Refraction, runtime opacity remaps and unfamiliar
// shader features require a different blend equation.
export function constantGlassInputs(material) {
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
    Object.keys(vmat.FloatParams ?? {}).length ||
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
  return { name, dust, tint, castsShadow: vmat.IntParams?.F_DO_NOT_CAST_SHADOWS !== 1 };
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
          !bytes(r.dustRgba) ||
          typeof r.castsShadow !== 'boolean' ||
          ![r.name, r.dust, r.tint].every(
            (v) => typeof v === 'string' && v.length <= 256 && path.test(v),
          ),
      )
    )
      throw Error('Invalid prepared glass data.');
    return rows;
  } finally {
    await handle.close();
  }
}

export function bindPreparedGlass(document, rows) {
  const materials = document.getRoot().listMaterials();
  for (const row of rows) {
    const material = materials[row.index];
    if (!material || material.getBaseColorTexture()) continue;
    const inputs = constantGlassInputs({
      extras: material.getExtras(),
      alphaMode: material.getAlphaMode(),
      pbrMetallicRoughness: { baseColorFactor: material.getBaseColorFactor() },
    });
    if (!inputs || ['name', 'dust', 'tint', 'castsShadow'].some((k) => inputs[k] !== row[k]))
      continue;
    const [r, g, b, alpha] = row.dustRgba;
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
          constantGlass: { schemaVersion: 1, castsShadow: inputs.castsShadow },
        },
      });
  }
}
