import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';
import { regularFile } from './toolchain-security.mjs';
import { source2References } from './source2-dependencies.mjs';
import { constantGlassInputs } from './prepare-map-glass.mjs';

// One pixel can occupy a whole 4 × 4 compression block. Inspect the texture
// header before launching the native decode, including depth and display rect.
function constantHeader(text) {
  const field = (name) =>
    Number(new RegExp('^' + name + '\\s*=\\s*(\\d+)\\s*$', 'm').exec(text)?.[1]);
  return (
    field('VTEX Version') === 1 &&
    [1, 4].includes(field('Width')) &&
    [1, 4].includes(field('Height')) &&
    (field('Width') === 1 || field('DisplayRectW') === 1) &&
    (field('Height') === 1 || field('DisplayRectH') === 1) &&
    field('Depth') === 1 &&
    field('NumMipLevels') === 1 &&
    /^Flags\s*=\s*0x0+\s*$/m.test(text)
  );
}

// S2V's raw GLB extras select candidates. Its independently decoded, CRC-checked
// VMAT must identify the same shader, texture roles and shadow switch.
function matchingGlassData(text, row) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || text.includes('\0'))
    return false;
  const field = (name) =>
    new RegExp('^\\s*' + name + '\\s*=\\s*"([^"\\r\\n]+)"\\s*$', 'm').exec(text)?.[1];
  if (
    field('m_shaderName') !== 'csgo_glass.vfx' ||
    field('m_materialName') !== row.name ||
    !/^\s*m_floatParams\s*=\s*\[\s*\]\s*$/m.test(text)
  )
    return false;
  const ints = text.match(/^\s*m_intParams\s*=([\s\S]*?)^\s*m_floatParams\s*=/m)?.[1];
  if (!ints) return false;
  const settings = {};
  for (const match of ints.matchAll(/m_name\s*=\s*"([a-zA-Z_0-9]+)"\s+m_nValue\s*=\s*(-?\d+)/g)) {
    if (Object.hasOwn(settings, match[1])) return false;
    settings[match[1]] = Number(match[2]);
  }
  if (Object.keys(settings).length !== [...ints.matchAll(/m_name\s*=/g)].length) return false;
  const maps = {};
  for (const match of text.matchAll(
    /m_name\s*=\s*"(g_tGlassDust|g_tGlassTintColor)"\s+m_pValue\s*=\s*resource:"([^"\r\n]+)"/g,
  )) {
    if (Object.hasOwn(maps, match[1])) return false;
    maps[match[1]] = match[2];
  }
  const checked = constantGlassInputs({
    alphaMode: 'BLEND',
    extras: {
      vmat: {
        Name: row.name,
        ShaderName: 'csgo_glass.vfx',
        TextureParams: maps,
        IntParams: settings,
      },
    },
  });
  return (
    checked?.castsShadow === row.castsShadow &&
    checked.dust === row.dust &&
    checked.tint === row.tint
  );
}

export async function prepareInstalledGlass({ input, stage, getBanks, execute, s2v }) {
  const { document } = await readAtmosphereGlb(input);
  const vertexTints = new Set();
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.attributes?.COLOR_0 !== undefined) vertexTints.add(primitive.material);
    }
  }
  const candidates = document.materials
    .flatMap((m, index) => {
      const row = !vertexTints.has(index) && constantGlassInputs(m);
      return row ? [{ ...row, index }] : [];
    })
    .slice(0, 32);
  if (!candidates.length) return { args: [], proof: [] };
  const banks = await getBanks(),
    folder = join(stage, 'constant-glass');
  await mkdir(folder, { mode: 0o700 });
  async function verified(resource, limit) {
    const key = resource + '_c',
      matches = banks.filter((bank) => bank.entries.has(key)),
      entry = matches[0]?.entries.get(key);
    if (!entry) return;
    const size = entry.length + entry.preloadBytes;
    if (
      size < 1 ||
      size > limit ||
      matches.some((bank) => {
        const other = bank.entries.get(key);
        return other.crc32 !== entry.crc32 || other.length + other.preloadBytes !== size;
      })
    )
      return;
    for (const bank of matches) {
      const data = await bank.readEntry(key);
      if (data?.length === size) return { data, crc32: entry.crc32 };
    }
  }
  const textures = new Map(),
    rows = [],
    proof = [];
  async function pixel(resource) {
    if (textures.has(resource)) return textures.get(resource);
    if (textures.size >= 32) return;
    const id = textures.size;
    textures.set(resource, undefined);
    const compiled = await verified(resource, 64 * 1024);
    if (!compiled) return;
    const source = join(folder, id + '.vtex_c'),
      image = join(folder, id + '.png');
    await writeFile(source, compiled.data, { flag: 'wx', mode: 0o600 });
    try {
      const header = await execute(s2v, ['-i', source, '--block', 'DATA'], 'glass-header-' + id, {
        allowFailure: true,
      });
      if (header.code !== 0 || !constantHeader(header.stdout)) return;
      const decoded = await execute(
        s2v,
        ['-i', source, '--decompile', '-o', folder, '--quiet'],
        'glass-pixel-' + id,
        { allowFailure: true },
      );
      if (decoded.code !== 0) return;
      let output;
      try {
        output = await regularFile(image, 8192);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      const { handle } = output;
      let data;
      try {
        data = await handle.readFile();
      } finally {
        await handle.close();
      }
      // Inspect IHDR before decoding: S2V may preserve the padded encoded
      // dimensions even for an input with a one-pixel display rect.
      if (
        data.length < 33 ||
        data.readUInt32BE(0) !== 0x89504e47 ||
        data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(16) !== 1 ||
        data.readUInt32BE(20) !== 1
      )
        return;
      let rgba;
      try {
        const decoded = await sharp(data, { limitInputPixels: 1 })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (decoded.info.width !== 1 || decoded.info.height !== 1 || decoded.info.channels !== 4)
          return;
        rgba = decoded.data;
      } catch {
        return;
      } // Only the in-memory decode of the optional PNG failed.
      const result = { rgba: [...rgba], crc32: compiled.crc32 };
      textures.set(resource, result);
      return result;
    } finally {
      await unlink(source);
      await unlink(image).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }
  for (const row of candidates) {
    const material = await verified(row.name, 256 * 1024);
    if (!material) continue;
    const refs = source2References(material.data);
    if (![row.dust, row.tint].every((texture) => refs.includes(texture + '_c'))) continue;
    const compiled = join(folder, 'glass-' + row.index + '.vmat_c');
    await writeFile(compiled, material.data, { flag: 'wx', mode: 0o600 });
    let matches;
    try {
      const data = await execute(
        s2v,
        ['-i', compiled, '--block', 'DATA'],
        'glass-material-' + row.index,
        { allowFailure: true },
      );
      matches = data.code === 0 && matchingGlassData(data.stdout, row);
    } finally {
      await unlink(compiled);
    }
    if (!matches) continue;
    const dust = await pixel(row.dust),
      tint = await pixel(row.tint);
    // Colored transmission requires destination-color blending, and cannot use
    // this ordinary alpha pass. Leave unsupported materials as exported.
    if (!dust || !tint?.rgba.every((n) => n === 255)) continue;
    rows.push({ ...row, dustRgba: dust.rgba });
    proof.push({
      ...row,
      materialCrc32: material.crc32,
      dustCrc32: dust.crc32,
      tintCrc32: tint.crc32,
      dustRgba: dust.rgba,
      tintRgba: tint.rgba,
    });
  }
  if (!rows.length) return { args: [], proof };
  const file = join(folder, 'bindings.json');
  await writeFile(file, JSON.stringify(rows), { flag: 'wx', mode: 0o600 });
  return { args: ['--glass-bindings', file], proof };
}
