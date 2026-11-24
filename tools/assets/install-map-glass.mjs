import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';
import { regularFile } from './toolchain-security.mjs';
import { source2References } from './source2-dependencies.mjs';
import { sourceGlassInputs } from './prepare-map-glass.mjs';

// One pixel can occupy a whole 4 × 4 compression block. Inspect the texture
// header before launching the native decode, including depth and display rect.
function textureHeader(text, allowImage) {
  const field = (name) =>
    Number(new RegExp('^' + name + '\\s*=\\s*(\\d+)\\s*$', 'm').exec(text)?.[1]);
  const width = field('Width'),
    height = field('Height'),
    mips = field('NumMipLevels');
  if (field('VTEX Version') !== 1 || field('Depth') !== 1 || !/^Flags\s*=\s*0x0+\s*$/m.test(text))
    return;
  if (
    [1, 4].includes(width) &&
    [1, 4].includes(height) &&
    (width === 1 || field('DisplayRectW') === 1) &&
    (height === 1 || field('DisplayRectH') === 1) &&
    mips === 1
  )
    return { width: 1, height: 1 };
  if (
    allowImage &&
    width >= 8 &&
    width <= 2048 &&
    height >= 8 &&
    height <= 2048 &&
    mips >= 1 &&
    mips <= 1 + Math.floor(Math.log2(Math.max(width, height))) &&
    /^Format\s*=\s*\d+ \(VTEX_FORMAT_(?:BC7|DXT5|RGBA8888)\)\s*$/m.test(text)
  )
    return { width, height };
}

// S2V's raw GLB extras select candidates. Its independently decoded, CRC-checked
// VMAT must identify the same shader, texture roles and shadow switch.
function matchingGlassData(text, row) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || text.includes('\0'))
    return false;
  const field = (name) =>
    new RegExp('^\\s*' + name + '\\s*=\\s*"([^"\\r\\n]+)"\\s*$', 'm').exec(text)?.[1];
  if (field('m_shaderName') !== 'csgo_glass.vfx' || field('m_materialName') !== row.name)
    return false;
  const ints = text.match(/^\s*m_intParams\s*=([\s\S]*?)^\s*m_floatParams\s*=/m)?.[1];
  if (!ints) return false;
  const settings = {};
  for (const match of ints.matchAll(/m_name\s*=\s*"([a-zA-Z_0-9]+)"\s+m_nValue\s*=\s*(-?\d+)/g)) {
    if (Object.hasOwn(settings, match[1])) return false;
    settings[match[1]] = Number(match[2]);
  }
  if (Object.keys(settings).length !== [...ints.matchAll(/m_name\s*=/g)].length) return false;
  const floatBlock = /m_floatParams\s*=\s*\[([\s\S]*?)\]\s*(?:,|$)/m.exec(text)?.[1];
  if (
    floatBlock === undefined ||
    (floatBlock.trim() &&
      !/^\s*\{\s*m_name\s*=\s*"g_flModelTintAmount"\s+m_flValue\s*=\s*1(?:\.0+)?\s*\},?\s*$/.test(
        floatBlock,
      ))
  )
    return false;
  const vectors = {};
  const block = text.match(/^\s*m_vectorParams\s*=([\s\S]*?)^\s*m_textureParams\s*=/m)?.[1] ?? '';
  for (const match of block.matchAll(
    /m_name\s*=\s*"([A-Za-z_0-9]+)"\s+m_value\s*=\s*\[([^\]]+)\]/g,
  )) {
    if (Object.hasOwn(vectors, match[1])) return false;
    vectors[match[1]] = match[2].split(',').map(Number);
  }
  if (Object.keys(vectors).length !== [...block.matchAll(/m_name\s*=/g)].length) return false;
  const maps = {};
  for (const match of text.matchAll(
    /m_name\s*=\s*"(g_tGlassDust|g_tGlassTintColor)"\s+m_pValue\s*=\s*resource:"([^"\r\n]+)"/g,
  )) {
    if (Object.hasOwn(maps, match[1])) return false;
    maps[match[1]] = match[2];
  }
  const checked = sourceGlassInputs({
    alphaMode: 'BLEND',
    extras: {
      vmat: {
        Name: row.name,
        ShaderName: 'csgo_glass.vfx',
        TextureParams: maps,
        IntParams: settings,
        VectorParams: vectors,
      },
    },
  });
  return (
    checked?.castsShadow === row.castsShadow &&
    checked.dust === row.dust &&
    checked.tint === row.tint &&
    checked.plainUv === row.plainUv &&
    checked.remap.every((n, i) => Math.abs(n - row.remap[i]) < 0.000001)
  );
}

export async function prepareInstalledGlass({ input, stage, getBanks, execute, s2v }) {
  const { document } = await readAtmosphereGlb(input);
  const vertexTints = new Set(),
    missingUv = new Set();
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.attributes?.TEXCOORD_0 === undefined) missingUv.add(primitive.material);
      if (primitive.attributes?.COLOR_0 !== undefined) vertexTints.add(primitive.material);
    }
  }
  const candidates = document.materials
    .flatMap((m, index) => {
      const row = !vertexTints.has(index) && sourceGlassInputs(m);
      return row ? [{ ...row, index, textured: row.plainUv && !missingUv.has(index) }] : [];
    })
    .slice(0, 32);
  if (!candidates.length) return { args: [], proof: [] };
  const banks = await getBanks(),
    folder = join(stage, 'source-glass');
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
    images = new Map(),
    rows = [],
    proof = [];
  let decodedPixels = 0,
    savedPixels = 0,
    savedBytes = 0;
  async function texture(resource, allowImage) {
    const cacheKey = resource + (allowImage ? ':image' : ':pixel');
    if (textures.has(cacheKey)) return textures.get(cacheKey);
    if (textures.size >= 32) return;
    const id = textures.size;
    textures.set(cacheKey, undefined);
    const compiled = await verified(resource, allowImage ? 6 * 1024 ** 2 : 64 * 1024);
    if (!compiled) return;
    const source = join(folder, id + '.vtex_c'),
      png = join(folder, id + '.png');
    await writeFile(source, compiled.data, { flag: 'wx', mode: 0o600 });
    try {
      const header = await execute(s2v, ['-i', source, '--block', 'DATA'], 'glass-header-' + id, {
        allowFailure: true,
      });
      if (header.code !== 0) return;
      const size = textureHeader(header.stdout, allowImage);
      if (!size || decodedPixels + size.width * size.height > 16 * 1024 ** 2) return;
      decodedPixels += size.width * size.height;
      const decoded = await execute(
        s2v,
        ['-i', source, '--decompile', '-o', folder, '--quiet'],
        'glass-image-' + id,
        { allowFailure: true },
      );
      if (decoded.code !== 0) return;
      let output;
      try {
        output = await regularFile(png, size.width === 1 ? 8192 : 20 * 1024 ** 2);
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      let data;
      try {
        data = await output.handle.readFile();
      } finally {
        await output.handle.close();
      }
      if (
        data.length < 33 ||
        data.readUInt32BE(0) !== 0x89504e47 ||
        data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(16) !== size.width ||
        data.readUInt32BE(20) !== size.height
      )
        return;
      let result;
      try {
        const image = sharp(data, { limitInputPixels: size.width * size.height }),
          meta = await image.metadata();
        if (!meta.hasAlpha || meta.depth !== 'uchar' || meta.channels !== 4) return;
        const rgba = await image.raw().toBuffer();
        if (rgba.length !== size.width * size.height * 4) return;
        if (size.width === 1) result = { rgba: [...rgba] };
        else result = { size, data, rgbaBytes: rgba };
      } catch {
        return;
      }
      result.crc32 = compiled.crc32;
      textures.set(cacheKey, result);
      return result;
    } finally {
      await unlink(source);
      await unlink(png).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }

  // The Source shader applies the opacity remap after the dust lookup.
  // For ordinary UV0 sampling the linear remap commutes with filtering. Bake
  // it once into the 8-bit alpha channel so glTF and the viewer share one map.
  async function spatialBinding(dust, row) {
    const key = JSON.stringify([row.dust, row.remap]);
    if (images.has(key)) return images.get(key);
    const [lo, hi] = row.remap;
    const pixels = dust.size.width * dust.size.height;
    if (savedPixels + pixels > 16 * 1024 ** 2) return;
    let png = dust.data;
    if (lo !== 0 || hi !== 1) {
      const rgba = Buffer.from(dust.rgbaBytes);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = Math.round(lo * 255 + (hi - lo) * rgba[i]);
      png = await sharp(rgba, { raw: { ...dust.size, channels: 4 } })
        .png()
        .toBuffer();
    }
    if (savedBytes + png.length > 32 * 1024 ** 2) return;
    savedBytes += png.length;
    savedPixels += pixels;
    const file = 'dust-' + images.size + '.png';
    await writeFile(join(folder, file), png, { flag: 'wx', mode: 0o600 });
    const image = { file, ...dust.size, sha256: createHash('sha256').update(png).digest('hex') };
    images.set(key, image);
    return image;
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
    const tint = await texture(row.tint, false);
    // Only neutral transmitted RGB can be represented with ordinary alpha
    // blending. Tint A controls backlighting, independently of dust opacity.
    if (!tint?.rgba?.slice(0, 3).every((n) => n === 255)) continue;
    const dust = await texture(row.dust, row.textured);
    if (!dust) continue;
    let binding;
    if (dust.rgba) {
      const [lo, hi] = row.remap;
      const [r, g, b, a] = dust.rgba;
      binding = { dustRgba: [r, g, b, Math.round(lo * 255 + (hi - lo) * a)] };
    } else {
      const image = await spatialBinding(dust, row);
      if (!image) continue;
      binding = { image };
    }
    rows.push({ ...row, ...binding });
    proof.push({
      ...row,
      ...binding,
      materialCrc32: material.crc32,
      dustCrc32: dust.crc32,
      tintCrc32: tint.crc32,
      tintRgba: tint.rgba,
    });
  }
  if (!rows.length) return { args: [], proof };
  const file = join(folder, 'bindings.json');
  await writeFile(file, JSON.stringify(rows), { flag: 'wx', mode: 0o600 });
  return { args: ['--glass-bindings', file], proof };
}
