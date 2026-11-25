// Material slots follow ValveResourceFormat 21.1 (MIT). See THIRD_PARTY_NOTICES.txt.
// Phase one writes the desktop tier and the phone ASTC plan. finish.mjs completes the pack.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { MeshoptEncoder } from '../../frontend/node_modules/meshoptimizer/meshopt_encoder.js';
import { geometry, modelTriangles, stride } from './geometry.mjs';
import { vertexArchive } from './quantize.mjs';
import { simplifierReady, simplifyRange } from './simplify.mjs';
import { packFiles, packPayload } from './pack-files.mjs';
import { materialCap, phonePlan } from './texture-tiers.mjs';
import { overviewCalibration, overviewRaster, playableCalibration } from './overview.mjs';

const [source, out, stage] = process.argv.slice(2);
if (!source || !out || !stage) throw Error('Usage: pack.mjs <source> <pack> <stage>');
const scene = JSON.parse(readFileSync(join(source, 'source.json'), 'utf8'));
const cache = new Map(),
  arrays = [],
  groups = new Map(),
  refs = new Map();
// Source payloads stay cached up to 512 MiB, least recently used first out, so a large world
// streams through bounded memory.
let cachedBytes = 0;
function read(file) {
  let bytes = cache.get(file);
  if (bytes) {
    cache.delete(file);
    cache.set(file, bytes);
    return bytes;
  }
  bytes = readFileSync(join(source, file));
  cache.set(file, bytes);
  cachedBytes += bytes.length;
  for (const [name, old] of cache) {
    if (cachedBytes <= 512 * 1024 ** 2 || name === file) break;
    cache.delete(name);
    cachedBytes -= old.length;
  }
  return bytes;
}
function clearCache() {
  cache.clear();
  cachedBytes = 0;
}
const { files, store, addMip, flush } = packFiles(out);
function keep(file) {
  if (!files[file]) {
    writeFileSync(join(out, file), readFileSync(join(source, file)), { flag: 'wx' });
    files[file] = scene.files[file];
  }
  return file;
}

// Lightmap kinds other than the three sampled ones and unbound volume textures are not drawn.
const sampledLightmap = /\/(irradiance|directional_irradiance|direct_light_shadows)\.vtex$/;
for (const [name, texture] of Object.entries(scene.textures)) {
  const category = scene.files[texture.file].category;
  if (
    (category === 'lightmaps' && !sampledLightmap.test(name)) ||
    (category === 'textures' && texture.levels.at(-1).d > 1)
  )
    delete scene.textures[name];
}
const ids = new Map(Object.keys(scene.materials).map((name, index) => [name, index]));
const MiB = 1024 ** 2;
// Per-map download budgets: 100 MB desktop and 70 MB phone. Geometry is shared by both tiers, so it
// may take 45% of the phone plan at an assumed 8.5 bytes per triangle. The desktop estimate
// measures every payload with the writer's packing, so it keeps 5% below 95.4 MiB for paging.
const desktopBudget = 91 * MiB,
  geometryAllowance = 0.45 * 64.5 * MiB,
  bytesPerTriangle = 8.5;
const roles = {
  color: ['g_tColor', 'g_tColor1', 'g_tGlassTintColor'],
  normal: ['g_tLayer1NormalRoughness', 'g_tNormal', 'g_tNormal1'],
  ao: ['g_tLayer1AmbientOcclusion', 'g_tAmbientOcclusion'],
  // csgo_environment_blend names its second layer g_tColor2/g_tNormal2.
  color2: ['g_tLayer2Color', 'g_tColor2'],
  normal2: ['g_tLayer2NormalRoughness', 'g_tNormal2'],
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
const materialId = (name) => ids.get(name);
const materialList = Object.values(scene.materials);
// Large opaque ranges, never foliage cards, may be simplified.
const simplifiable = (range) =>
  !range.sky &&
  range.family === 'opaque' &&
  range.indices.length / 12 >= 256 &&
  !materialList[range.mat]?.shader.includes('foliage');
// Pass one decodes every range once to measure texel density and triangle counts; nothing is
// retained, so any world fits in bounded memory.
const density = new Map(),
  instances = new Map(),
  coarse = new Set();
let fineTriangles = 0,
  fineSimplifiable = 0;
geometry(scene, read, materialId, density, new Set(), instances, (range) => {
  const count = range.indices.length / 12;
  fineTriangles += count;
  if (simplifiable(range)) fineSimplifiable += count;
});
clearCache();
let estimate = fineTriangles;
if (estimate * bytesPerTriangle > geometryAllowance) {
  // The placements whose coarser LOD saves the most triangles switch first.
  const savings = [...instances]
    .map(([name, count]) => {
      const t = modelTriangles(scene.models[name]);
      return { name, saving: t.coarse === undefined ? 0 : count * (t.fine - t.coarse) };
    })
    .filter((s) => s.saving > 0)
    .sort((a, b) => b.saving - a.saving);
  for (const { name, saving } of savings) {
    if (estimate * bytesPerTriangle <= geometryAllowance) break;
    coarse.add(name);
    estimate -= saving;
  }
}
// Geometry still above its allowance is simplified within 2 inches of the source and without
// removing surface (see simplify.mjs). On de_train 2 inches was indistinguishable at the spawns
// (MAE 0.34) while 8 inches bent window frames, so geometry that still exceeds the allowance stays
// over budget. Borders stay locked so neighbouring ranges and lightmap seams keep meeting.
const fixedTriangles = estimate - fineSimplifiable * (estimate / fineTriangles);
const simplifyError = estimate * bytesPerTriangle > geometryAllowance ? 2 : 0;
const ratio = simplifyError
  ? Math.max(
      0.05,
      (geometryAllowance / bytesPerTriangle - fixedTriangles) / (estimate - fixedTriangles),
    )
  : 1;
if (simplifyError) await simplifierReady;
// Radar artwork the game files lack is rendered from the world, against the official calibration
// when only the image is missing.
let overview, generatedOverview;
const official =
  !existsSync(join(source, 'overview.png')) && existsSync(join(source, 'overview.txt'))
    ? overviewCalibration(readFileSync(join(source, 'overview.txt'), 'utf8'))
    : undefined;
if (!existsSync(join(source, 'overview.png'))) {
  const main = Object.entries(scene.worlds).find(([name]) => name === `maps/${scene.map}`)?.[1];
  const calibration = official
    ? { ...official, ceiling: playableCalibration(main?.entities ?? [])?.ceiling }
    : playableCalibration(main?.entities ?? []);
  if (calibration) overview = overviewRaster(scene.map, calibration);
}
// Pass two simplifies and encodes each range as it is decoded and keeps only its compressed
// streams and local indices. A material's optional streams depend on its texture slots, not on
// the texture plan, so encoding precedes planning.
const hasLayer = (material, role) =>
  Object.entries(material.slots).some(
    ([slot, texture]) =>
      roles[role].includes(slot) &&
      scene.textures[texture] &&
      scene.textures[texture].levels.at(-1).d === 1,
  );
const encodeMaterials = materialList.map((material) => ({
  ...material,
  bindings: hasLayer(material, 'color2') ? { color2: true } : {},
}));
await MeshoptEncoder.ready;
const archive = vertexArchive();
const records = [];
let triangles = 0,
  retainedIndexBytes = 0;
const { entities, environments } = geometry(
  scene,
  read,
  materialId,
  new Map(),
  coarse,
  new Map(),
  (range) => {
    if (simplifyError && simplifiable(range)) {
      const count = range.indices.length / 4;
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) indices[i] = range.indices.readUInt32LE(i * 4);
      const kept = simplifyRange(range.v, stride, indices, ratio, simplifyError);
      if (kept) {
        const remap = new Map();
        for (const index of kept) if (!remap.has(index)) remap.set(index, remap.size);
        const v = Buffer.alloc(remap.size * stride);
        for (const [from, to] of remap)
          range.v.copy(v, to * stride, from * stride, (from + 1) * stride);
        const out = Buffer.alloc(kept.length * 4);
        kept.forEach((index, i) => out.writeUInt32LE(remap.get(index), i * 4));
        range.v = v;
        range.indices = out;
      }
    }
    overview?.add(range);
    const count = range.indices.length / 4;
    triangles += count / 3;
    retainedIndexBytes += range.indices.length;
    if (retainedIndexBytes > 512 * 1024 ** 2) throw Error('Geometry exceeds retained index budget');
    records.push({
      sky: range.sky,
      family: range.family,
      side: range.side,
      cell: range.cell,
      mat: range.mat,
      entityIndex: range.entityIndex,
      bounds: range.bounds,
      cubeHandshake: range.cubeHandshake,
      probeHandshake: range.probeHandshake,
      vertices: range.v.length / stride,
      indices: range.indices,
      vertexData: archive.encode(range, encodeMaterials[range.mat]),
    });
  },
);
clearCache();
const simplified = estimate - triangles > 0 && simplifyError ? estimate - triangles : 0;
if (overview) {
  const rendered = overview.finish();
  if (rendered) {
    writeFileSync(join(source, 'overview.png'), rendered.png);
    if (!official) writeFileSync(join(source, 'overview.txt'), rendered.text);
    generatedOverview = official ? 'image comes' : 'calibration and image come';
  }
}
// Drop whole authored levels, preserving the remaining Valve block payloads.
// The desktop tier takes the first plan whose estimate fits its budget: distant 3D-sky
// lightmaps, then the sun shadow, material texel density and baked lighting resolution give way.
// Estimates use measured Brotli/raw ratios per category.
const desktopPlans = [
  { target: undefined, max: 1024, irradiance: 4096, shadow: 8192, skyLightmap: Infinity },
  { target: undefined, max: 1024, irradiance: 4096, shadow: 8192, skyLightmap: 1024 },
  { target: undefined, max: 1024, irradiance: 4096, shadow: 4096, skyLightmap: 1024 },
  { target: undefined, max: 512, irradiance: 4096, shadow: 4096, skyLightmap: 1024 },
  { target: 1, max: 512, irradiance: 2048, shadow: 2048, skyLightmap: 1024 },
  { target: 1, max: 256, irradiance: 2048, shadow: 2048, skyLightmap: 512 },
  { target: 0.75, max: 256, irradiance: 1024, shadow: 1024, skyLightmap: 512 },
  { target: 0.75, max: 256, irradiance: 1024, shadow: 1024, skyLightmap: 512, cube: 64 },
];
// Each texture level's stored size is measured once with the writer's own packing, so plans are
// chosen on measured bytes rather than category ratios.
const packedLevels = new Map();
function packedLevel(texture, level) {
  const key = texture.file + ':' + level.offset;
  let size = packedLevels.get(key);
  if (size === undefined) {
    const bytes = read(texture.file).subarray(level.offset, level.offset + level.size);
    size = packPayload(bytes, texture.format).bytes.length;
    packedLevels.set(key, size);
  }
  return size;
}
const mainWorld = 'maps/' + scene.map + '/';
function texturePlanCaps(plan) {
  const caps = new Map();
  for (const [name, material] of Object.entries(scene.materials)) {
    const cap = materialCap(material, density.get(name), plan.target, plan.max);
    for (const texture of Object.values(material.slots))
      caps.set(texture, Math.max(cap, caps.get(texture) ?? 0));
  }
  return caps;
}
function capFor(name, category, plan, caps) {
  if (category === 'cubemaps') return plan.cube ?? 128;
  if (category === 'sky') return 128;
  if (category === 'lightmaps') {
    const own = /direct_light_shadows/.test(name) ? plan.shadow : plan.irradiance;
    return name.startsWith(mainWorld) ? own : Math.min(own, plan.skyLightmap);
  }
  return category === 'textures' ? (caps.get(name) ?? Math.min(256, plan.max)) : Infinity;
}
const geometryWire = deflateSync(archive.finish()).length;
function desktopEstimate(plan) {
  const caps = texturePlanCaps(plan);
  // Vertex streams are measured after deflate; indices cost about 0.12 bytes each (de_inferno:
  // 1.4 MB for 12.1M indices).
  let bytes = geometryWire + triangles * 3 * 0.12;
  for (const [name, texture] of Object.entries(scene.textures)) {
    const category = scene.files[texture.file].category;
    const cap = capFor(name, category, plan, caps);
    let kept = texture.levels.filter((level) => Math.max(level.w, level.h) <= cap);
    if (!kept.length) kept = texture.levels.slice(0, 1);
    if (name.endsWith('/direct_light_shadows.vtex')) kept = kept.slice(-1);
    bytes += kept.reduce((n, level) => n + packedLevel(texture, level), 0);
  }
  return bytes;
}
const desktopPlan =
  desktopPlans.find((plan) => desktopEstimate(plan) <= desktopBudget) ?? desktopPlans.at(-1);
desktopPlan.estimateMiB = +(desktopEstimate(desktopPlan) / MiB).toFixed(1);
const textureCaps = texturePlanCaps(desktopPlan);
const sourceLevels = new Map();
for (const [name, texture] of Object.entries(scene.textures)) {
  sourceLevels.set(
    name,
    texture.levels.map((level) => ({ ...level })),
  );
  const category = scene.files[texture.file].category;
  const cap = capFor(name, category, desktopPlan, textureCaps);
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
const mats = Object.entries(scene.materials).map(([name, m]) => {
  const bindings = {},
    slots = {};
  for (const [slot, tex] of Object.entries(m.slots)) {
    if (!scene.textures[tex] || scene.textures[tex].levels.at(-1).d > 1) {
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
  if (category === 'textures') continue;
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
flush();
for (const bank of arrays) bank.file = bank.mips[0].file;
for (const texture of Object.values(specials))
  if (texture.levels[0].file) texture.file = texture.levels[0].file;
// A map whose post-processing files are absent uses VRF's default filmic curve, no bloom and an
// identity grading LUT.
const defaultGrade = !Object.keys(scene.post).length;
if (defaultGrade) {
  const size = 32,
    lut = Buffer.alloc(size ** 3 * 4);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const at = 4 * (r + size * (g + size * b));
        lut.set(
          [r, g, b].map((c) => Math.round((c * 255) / (size - 1))),
          at,
        );
        lut[at + 3] = 255;
      }
  scene.post['default'] = {
    tonemap: {
      m_flExposureBias: 0,
      m_flShoulderStrength: 0.15,
      m_flLinearStrength: 0.5,
      m_flLinearAngle: 0.1,
      m_flToeStrength: 0.2,
      m_flToeNum: 0.02,
      m_flToeDenom: 0.3,
      m_flWhitePoint: 4,
    },
    bloom: { m_flBloomStrength: 0, m_flBloomThreshold: 1.05, m_flBloomThresholdWidth: 0 },
    dimension: size,
    lut: store(lut, 'grading'),
  };
}
for (const [name, p] of Object.entries(scene.post))
  if (name !== 'default' || !defaultGrade) keep(p.lut);
if (scene.visibility) keep(scene.visibility.file);
const batches = new Map();
for (const r of records) {
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
      for (let i = 0; i < count; i++)
        r.indices.writeUInt32LE(r.indices.readUInt32LE(i * 4) + base, i * 4);

      indices.push(r.indices);
      chunk.ranges.push({
        ...r.vertexData,
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
      base += r.vertices;
    }
  }
}
const vb = store(archive.finish(), 'geometry');
const ib = store(MeshoptEncoder.encodeIndexBuffer(Buffer.concat(indices), first, 4), 'geometry');
const bounds = scene.worlds[`maps/${scene.map}`].bounds[0];
const manifest = {
  format: 'cswatch-native-world',
  version: 3,
  map: scene.map,
  sourceManifest: scene.manifest,
  units: 'inches',
  up: 'Z',
  bounds: [...bounds.m_vMinBounds, ...bounds.m_vMaxBounds],
  roles: Object.keys(roles),
  geometry: { vb, ib, stride, vertices: base, indices: first },
  counts: {
    drawRanges: records.length,
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
  // Budget decisions: the desktop texture plan and the placements drawn at their coarser LOD.
  budget: {
    desktop: desktopPlan,
    coarseModels: [...coarse].sort(),
    triangles: Math.round(triangles),
    simplifiedTriangles: Math.round(simplified),
    fineTriangles: Math.round(fineTriangles),
  },
  unsupported: [
    'Frustum culling only. Decoded PVS is exported separately.',
    ...(coarse.size
      ? [`${coarse.size} models are drawn at their coarser LOD to fit the download budget.`]
      : []),
    ...(simplified
      ? [
          `${Math.round(simplified)} triangles were simplified away (within ${simplifyError} inches of the source) to fit the download budget.`,
        ]
      : []),
    'Tool occluder materials are excluded from color draws. Static highest-detail model pose. F_VERTEX_ANIMATION, wind and entity I/O are not evaluated.',
    'Effects use static time. F_DEPTH_FEATHER and volumetric noise animation are omitted.',
    'Translucent ranges are depth sorted by their bounds. Intersecting triangles within a range retain source ordering.',
    'Box cubemaps use six array layers and lack cross-face filtering. Small-scale material response and glass transmission are approximations.',
    'Dynamic direct lights and animated shadow casters are omitted. On this snapshot all local lights use baked or disabled direct illumination.',
    'The map master volume sets fixed exposure. Color grading uses its neutral LUT diagonal.',
    ...(Object.values(scene.materials).some((m) => m.shader.includes('water'))
      ? [
          'Water fogs and decays the scene behind by its column depth and mixes the cubemap reflection by Fresnel. The scene is blended rather than refracted; waves, foam, debris, caustics and screen-space reflection are omitted.',
        ]
      : []),
    ...(generatedOverview
      ? [
          `The game files lack this map's radar overview; the ${generatedOverview} from a top-down render of the world below the spawns' height, bounded by spawn, objective and buy-zone entities.`,
        ]
      : []),
    ...(defaultGrade
      ? [
          "The game files lack this map's post-processing; it uses a default filmic curve without bloom or grading.",
        ]
      : []),
    ...(scene.missingSkies?.length
      ? ['Referenced 3D skies absent from the game files: ' + scene.missingSkies.join(', ') + '.']
      : []),
    ...(scene.missingResources?.length
      ? [
          'Referenced models, materials and post-processing absent from the game files are skipped: ' +
            scene.missingResources.slice(0, 8).join(', ') +
            (scene.missingResources.length > 8 ? ' and others.' : '.'),
        ]
      : []),
  ],
  textureConversions: [],
};
writeFileSync(join(stage, 'desktop.json'), JSON.stringify(manifest));
writeFileSync(
  join(stage, 'astc-plan.json'),
  JSON.stringify(phonePlan(manifest, scene, sourceLevels)),
);
console.log(JSON.stringify(manifest.counts));
