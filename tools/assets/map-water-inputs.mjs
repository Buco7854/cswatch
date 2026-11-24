import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { regularFile } from './toolchain-security.mjs';

const family = 'csgo_water_fancy.vfx';
const path = /^materials\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.vmat$/;
const inRange = (v, low, high) => Number.isFinite(v) && v >= low && v <= high;

export function staticWaterInputs(vmat) {
  if (
    vmat?.ShaderName !== family ||
    typeof vmat.Name !== 'string' ||
    vmat.Name.length > 256 ||
    !path.test(vmat.Name)
  )
    return;
  const flags = vmat.IntParams ?? {},
    f = vmat.FloatParams ?? {},
    v = vmat.VectorParams ?? {};
  if (
    flags.F_REFRACTION !== 1 ||
    ![1, 2].includes(flags.F_REFLECTION_TYPE) ||
    ![0, 1].includes(flags.F_CAUSTICS ?? 0) ||
    ![0, 1].includes(flags.F_INTERACTION_EFFECTS ?? 0) ||
    Object.entries(flags).some(
      ([key, value]) =>
        key.startsWith('F_') &&
        value !== 0 &&
        !['F_REFRACTION', 'F_REFLECTION_TYPE', 'F_CAUSTICS', 'F_INTERACTION_EFFECTS'].includes(key),
    )
  )
    return;
  const fog = v.g_vWaterFogColor,
    tint = v.g_vColorTint;
  if (
    !Array.isArray(fog) ||
    fog.length !== 4 ||
    !fog.every((x) => inRange(x, 0, 1)) ||
    fog[3] !== 1 ||
    !Array.isArray(tint) ||
    tint.length !== 4 ||
    !tint.slice(0, 3).every((x) => x === 1) ||
    tint[3] !== 0 ||
    !inRange(f.g_flWaterFogStrength, 0, 32) ||
    !inRange(f.g_flReflectance, 0, 0.5) ||
    !inRange(f.g_flFresnelExponent, 1, 32) ||
    !inRange(f.g_flWaterRoughnessMin, 0, 1) ||
    !inRange(f.g_flWaterRoughnessMax, f.g_flWaterRoughnessMin, 1)
  )
    return;
  return {
    name: vmat.Name,
    fog: fog.slice(0, 3),
    density: f.g_flWaterFogStrength,
    reflectance: f.g_flReflectance,
    exponent: f.g_flFresnelExponent,
    roughness: f.g_flWaterRoughnessMin,
  };
}

// The existing confined shader preflight already decodes CRC-checked VMAT DATA.
// Keep its static surface terms only. Dynamic expressions and sky-only programs
// need a different evaluation path, even when the exporter includes default values.
export function waterFromMaterialData(text) {
  if (
    typeof text !== 'string' ||
    text.length > 256 * 1024 ||
    !/^\s*m_dynamicParams\s*=\s*\[\s*\]\s*$/m.test(text) ||
    !/^\s*m_dynamicTextureParams\s*=\s*\[\s*\]\s*$/m.test(text)
  )
    return;
  const name = /^\s*m_materialName\s*=\s*"([^"\r\n]+)"\s*$/m.exec(text)?.[1];
  const shader = /^\s*m_shaderName\s*=\s*"([^"\r\n]+)"\s*$/m.exec(text)?.[1];
  const vmat = { Name: name, ShaderName: shader };
  for (const [field, next, key, kind] of [
    ['intParams', 'floatParams', 'IntParams', 'nValue'],
    ['floatParams', 'vectorParams', 'FloatParams', 'flValue'],
    ['vectorParams', 'textureParams', 'VectorParams', 'value'],
  ]) {
    const block = new RegExp(
      '^\\s*m_' + field + '\\s*=([\\s\\S]*?)^\\s*m_' + next + '\\s*=',
      'm',
    ).exec(text)?.[1];
    if (!block) return;
    const params = Object.create(null);
    for (const row of block.matchAll(
      new RegExp('m_name\\s*=\\s*"([a-zA-Z0-9_]+)"\\s+m_' + kind + '\\s*=\\s*([^\\r\\n]+)', 'g'),
    )) {
      if (Object.hasOwn(params, row[1])) return;
      const literal = row[2].trim();
      if (kind === 'value') {
        if (!/^\[\s*[-+\d.eE]+(?:\s*,\s*[-+\d.eE]+){3}\s*\]$/.test(literal)) return;
        params[row[1]] = literal.slice(1, -1).split(',').map(Number);
      } else params[row[1]] = Number(literal);
    }
    if (Object.keys(params).length !== [...block.matchAll(/\bm_name\s*=/g)].length) return;
    vmat[key] = params;
  }
  return staticWaterInputs(vmat);
}

export async function writeWaterBindings(stage, preflights) {
  const materials = new Map();
  for (const report of preflights)
    for (const material of report.materials) {
      if (material.shader !== 'csgo_water_fancy') continue;
      const prior = materials.get(material.resource);
      // The main world and sky prefab can resolve the same path differently.
      if (prior === null || (prior && prior.sha256 !== material.sha256))
        materials.set(material.resource, null);
      else materials.set(material.resource, material);
    }
  const rows = [...materials.values()]
    .flatMap((m) => (m?.water && m.resource === m.water.name + '_c' ? [m.water] : []))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 64);
  if (!rows.length) return [];
  const file = join(stage, 'water-bindings.json');
  await writeFile(file, JSON.stringify(rows), { flag: 'wx', mode: 0o600 });
  return ['--water-bindings', file];
}

export async function readWaterBindings(file) {
  const { handle } = await regularFile(file, 64 * 1024);
  try {
    const rows = JSON.parse(await handle.readFile('utf8'));
    if (
      !Array.isArray(rows) ||
      rows.length > 64 ||
      rows.some(
        (r) =>
          typeof r?.name !== 'string' ||
          !path.test(r.name) ||
          r.name.length > 256 ||
          !Array.isArray(r.fog) ||
          r.fog.length !== 3 ||
          !r.fog.every((x) => inRange(x, 0, 1)) ||
          !inRange(r.density, 0, 32) ||
          !inRange(r.reflectance, 0, 0.5) ||
          !inRange(r.exponent, 1, 32) ||
          !inRange(r.roughness, 0, 1),
      ) ||
      new Set(rows.map((r) => r.name)).size !== rows.length
    )
      throw Error('Invalid prepared water data.');
    return new Map(rows.map((row) => [row.name, row]));
  } finally {
    await handle.close();
  }
}
