// Material slots follow ValveResourceFormat 21.1 (MIT). See THIRD_PARTY_NOTICES.txt.
import { readFileSync, writeFileSync, statfsSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MeshoptEncoder } from '../../frontend/node_modules/meshoptimizer/meshopt_encoder.js';
import { geometry, stride } from './geometry.mjs';

import { vertexArchive } from './quantize.mjs';
import { precompress } from './precompress.mjs';
import { deflateSync } from 'node:zlib';
import { transposeBlocks } from '../../frontend/src/world/block-layout.mjs';
import { materialCaps } from './material-caps.mjs';
const materialCap = Number(process.env.CS2EXPORT_MATERIAL_CAP ?? 256);
if (![256, 512, 1024].includes(materialCap)) throw Error('Material cap must be 256, 512 or 1024');
const [source, out] = process.argv.slice(2);
const scene = JSON.parse(readFileSync(join(source, 'source.json'), 'utf8'));
const files = {},
  cache = new Map(),
  arrays = [],
  groups = new Map(),
  refs = new Map();
function read(file) {
  let bytes = cache.get(file);
  if (!bytes) {
    bytes = readFileSync(join(source, file));
    cache.set(file, bytes);
  }
  return bytes;
}
function store(bytes, category, format) {
  const decodedSize = bytes.length;
  let packing;
  if (bytes.length >= 1024) {
    const stride = { DXT1: 8, DXT5: 16, ATI1N: 8, ATI2N: 16, BC6H: 16, BC7: 16 }[format];
    const original = bytes;
    for (const laneBytes of stride ? [1, stride] : [1]) {
      const packed = deflateSync(
        laneBytes === 1 ? original : transposeBlocks(original, laneBytes, false),
        { level: 6 },
      );
      if (packed.length + 64 < bytes.length) {
        bytes = packed;
        packing = laneBytes;
      }
    }
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex'),
    file = sha256 + '.bin';
  if (!files[file]) {
    const fs = statfsSync(out);
    if (fs.bavail * fs.bsize - bytes.length < 4 * 1024 ** 3) throw Error('Disk reserve reached');
    writeFileSync(join(out, file), bytes, { flag: 'wx' });
    files[file] = {
      size: bytes.length,
      sha256,
      category,
      ...(packing ? { packing, decodedSize } : {}),
    };
  }
  return file;
}
function keep(file) {
  if (!files[file]) {
    linkSync(join(source, file), join(out, file));
    files[file] = scene.files[file];
  }
  return file;
}

// Drop whole authored levels, preserving the remaining Valve block payloads.
const textureCaps = new Map();
if (!process.env.CS2EXPORT_MATERIAL_CAP)
  for (const [name, material] of Object.entries(scene.materials)) {
    const cap = materialCaps[name] ?? 256;
    for (const texture of Object.values(material.slots))
      textureCaps.set(texture, Math.max(cap, textureCaps.get(texture) ?? 0));
  }
for (const [name, texture] of Object.entries(scene.textures)) {
  const category = scene.files[texture.file].category;
  const cap =
    category === 'cubemaps' || category === 'sky'
      ? 128
      : category === 'lightmaps'
        ? /direct_light_shadows/.test(name)
          ? 8192
          : 4096
        : category === 'textures'
          ? (textureCaps.get(name) ?? materialCap)
          : Infinity;
  while (
    texture.levels.length > 1 &&
    Math.max(texture.levels.at(-1).w, texture.levels.at(-1).h) > cap
  ) {
    texture.levels.pop();
    texture.first++;
  }
  if (name.endsWith('/direct_light_shadows.vtex')) texture.levels = texture.levels.slice(-1);
  const skipped = texture.levels.at(-1).level;
  for (const level of texture.levels) level.level -= skipped;
}
function layer(name, role, srgb) {
  const key = [name, role, srgb].join('|');
  if (refs.has(key)) return refs.get(key);
  const tex = scene.textures[name],
    top = tex.levels.at(-1);
  if (top.d !== 1) throw Error('Expected a flat material texture ' + name);
  const shape = [role, tex.format, srgb, top.w, top.h, tex.levels.length, tex.flags & 3].join('/');
  let bank = groups.get(shape);
  if (!bank || bank.textures.length === 128) {
    bank = {
      id: arrays.length,
      role,
      srgb,
      format: tex.format,
      w: top.w,
      h: top.h,
      levels: tex.levels.length,
      flags: tex.flags,
      textures: [],
    };
    arrays.push(bank);
    groups.set(shape, bank);
  }
  const ref = [bank.id, bank.textures.length];
  bank.textures.push(name);
  refs.set(key, ref);
  return ref;
}
const roles = {
  color: ['g_tColor', 'g_tColor1', 'g_tGlassTintColor'],
  normal: ['g_tLayer1NormalRoughness', 'g_tNormal', 'g_tNormal1'],
  ao: ['g_tLayer1AmbientOcclusion', 'g_tAmbientOcclusion'],
  color2: ['g_tLayer2Color'],
  normal2: ['g_tLayer2NormalRoughness'],
  blend: ['g_tBlendModulation'],
  detail: ['g_tLayer1Detail', 'g_tDetail'],
  metal: ['g_tMetalness'],
  aux0: ['g_tGlassDust', 'g_tMask1', 'g_tTransmissiveColor'],
  aux1: ['g_tMask2', 'g_tTintMask'],
  aux2: ['g_tMask3'],
  illum: ['g_tSelfIllumMask'],
  detailMask: ['g_tDetailMask'],
  ao2: ['g_tLayer2AmbientOcclusion'],
  height: ['g_tHeight1'],
  rough: ['g_tRoughness'],
};
const mats = Object.entries(scene.materials).map(([name, m]) => {
  const bindings = {},
    slots = {};
  for (const [slot, tex] of Object.entries(m.slots)) {
    if (scene.textures[tex].levels.at(-1).d > 1) {
      slots[slot] = tex;
      continue;
    }
    const role = Object.entries(roles).find(([, names]) => names.includes(slot))?.[0] ?? slot;
    const srgb =
      ['color', 'color2', 'illum'].includes(role) ||
      ['g_tGlassDust', 'g_tTransmissiveColor'].includes(slot);
    slots[slot] = { name: tex, ref: layer(tex, role, srgb) };
    bindings[role] = slots[slot].ref;
  }
  return { name, ...m, slots, bindings };
});
const ids = new Map(mats.map((m, i) => [m.name, i]));
const { ranges, entities, environments } = geometry(scene, read, (name) => ids.get(name));
cache.clear();
// Pages group compatible blocks by refinement level. The bootstrap never shares a
// file with large mips. Each mip remains one contiguous run of GPU-ready layers.
const pages = new Map();
function addMip(category, format, level, bytes, first) {
  const wave = first || Math.max(level.w, level.h) <= 16 ? 0 : Math.max(level.w, level.h);
  const key = [category, format, wave].join('/');
  const list = pages.get(key) ?? [];
  let page = list.at(-1);
  if (!page || page.size + bytes.length > 2 * 1024 ** 2) {
    page = { category, format, size: 0, parts: [], levels: [] };
    list.push(page);
    pages.set(key, list);
  }
  const descriptor = { ...level, offset: page.size, size: bytes.length };
  page.parts.push(bytes);
  page.levels.push(descriptor);
  page.size += bytes.length;
  return descriptor;
}
for (const bank of arrays) {
  bank.mips = scene.textures[bank.textures[0]].levels.map((level, index) => {
    const parts = bank.textures.map((name) => {
      const source = scene.textures[name],
        mip = source.levels[index];
      return read(source.file).subarray(mip.offset, mip.offset + mip.size);
    });
    const { level: mip, w, h } = level;
    return addMip('textures', bank.format, { level: mip, w, h }, Buffer.concat(parts), index === 0);
  });
  cache.clear();
}
const specials = {};
for (const [name, texture] of Object.entries(scene.textures)) {
  const category = scene.files[texture.file].category;
  if (category === 'textures' && texture.levels.at(-1).d === 1) continue;
  const source = read(texture.file);
  if (category === 'cubemaps' || category === 'sky') {
    specials[name] = {
      ...texture,
      levels: texture.levels.map((mip, index) =>
        addMip(
          category,
          texture.format,
          mip,
          source.subarray(mip.offset, mip.offset + mip.size),
          index === 0,
        ),
      ),
    };
  } else {
    const start = texture.levels[0].offset,
      last = texture.levels.at(-1);
    specials[name] = {
      ...texture,
      file: store(source.subarray(start, last.offset + last.size), category, texture.format),
      levels: texture.levels.map((mip) => ({ ...mip, offset: mip.offset - start })),
    };
  }
  cache.clear();
}
for (const list of pages.values())
  for (const page of list) {
    const file = store(Buffer.concat(page.parts), page.category, page.format);
    for (const mip of page.levels) mip.file = file;
  }
pages.clear();
for (const bank of arrays) bank.file = bank.mips[0].file;
for (const texture of Object.values(specials))
  if (texture.levels[0].file) texture.file = texture.levels[0].file;
for (const p of Object.values(scene.post)) keep(p.lut);
if (scene.visibility) keep(scene.visibility.file);
const batches = new Map();
for (const r of ranges) {
  const bankIds = Object.keys(roles).map((role) => mats[r.mat].bindings[role]?.[0] ?? -1);
  const key = [r.sky, r.family, r.side, ...bankIds].join('/');
  let batch = batches.get(key);
  if (!batch) {
    batch = { sky: r.sky, family: r.family, side: r.side, banks: bankIds, cells: new Map() };
    batches.set(key, batch);
  }
  const keyCell = r.entityIndex < 0 ? r.cell : 'entity/' + r.entityIndex;
  if (!batch.cells.has(keyCell)) batch.cells.set(keyCell, []);
  batch.cells.get(keyCell).push(r);
}
await MeshoptEncoder.ready;
const archive = vertexArchive();
const indices = [],
  chunks = [];
let first = 0,
  base = 0;
for (const batch of batches.values()) {
  for (const [cell, rs] of batch.cells) {
    const chunk = {
      cell,
      sky: batch.sky,
      side: batch.side,
      family: batch.family,
      banks: batch.banks,
      ranges: [],
      bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    };
    chunks.push(chunk);
    for (const r of rs) {
      const count = r.indices.length / 4;
      const vertexData = archive.encode(r, mats[r.mat]);
      for (let i = 0; i < count; i++)
        r.indices.writeUInt32LE(r.indices.readUInt32LE(i * 4) + base, i * 4);

      indices.push(r.indices);
      chunk.ranges.push({
        ...vertexData,
        first,
        count,
        bounds: r.bounds,
        material: r.mat,
        entity: r.entityIndex,
        cubeHandshake: r.cubeHandshake,
        probeHandshake: r.probeHandshake,
      });
      for (let j = 0; j < 3; j++) {
        chunk.bounds[j] = Math.min(chunk.bounds[j], r.bounds[j]);
        chunk.bounds[j + 3] = Math.max(chunk.bounds[j + 3], r.bounds[j + 3]);
      }
      first += count;
      base += r.v.length / stride;
    }
  }
}
const vb = store(archive.finish(), 'geometry');
const ib = store(MeshoptEncoder.encodeIndexBuffer(Buffer.concat(indices), first, 4), 'geometry');
const bounds = scene.worlds['maps/de_mirage'].bounds[0];
const manifest = {
  format: 'cswatch-native-world',
  version: 3,
  map: 'de_mirage',
  sourceManifest: '8225060435969537482',
  units: 'inches',
  up: 'Z',
  bounds: [...bounds.m_vMinBounds, ...bounds.m_vMaxBounds],
  roles: Object.keys(roles),
  geometry: { vb, ib, stride, vertices: base, indices: first },
  counts: {
    drawRanges: ranges.length,
    chunks: chunks.length,
    triangles: first / 3,
    materials: mats.length,
    textures: Object.keys(scene.textures).length,
  },
  chunks,
  materials: mats,
  arrays,
  specials,
  entities,
  environments,
  post: scene.post,
  visibility: scene.visibility,
  files,
  unsupported: [
    'Frustum culling only. Decoded PVS is exported separately.',
    'Tool occluder materials are excluded from color draws. Static highest-detail model pose. F_VERTEX_ANIMATION, wind and entity I/O are not evaluated.',
    'Effects use static time. F_DEPTH_FEATHER and volumetric noise animation are omitted.',
    'Translucent ranges are depth sorted by their bounds. Intersecting triangles within a range retain source ordering.',
    'Box cubemaps use six array layers and lack cross-face filtering. Small-scale material response and glass transmission are approximations.',
    'Dynamic direct lights and animated shadow casters are omitted. On this snapshot all local lights use baked or disabled direct illumination.',
    'The map master volume sets fixed exposure. Color grading uses its neutral LUT diagonal.',
  ],
  textureConversions: [],
};
for (const [name, record] of Object.entries(files)) record.br = precompress(out, name);
writeFileSync(join(out, 'map.json'), JSON.stringify(manifest), { flag: 'wx' });
precompress(out, 'map.json');
console.log(JSON.stringify(manifest.counts));
