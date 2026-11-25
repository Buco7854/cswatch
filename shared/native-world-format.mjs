const MiB = 1024 ** 2;
const bounded = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const vec = (values, length) =>
  Array.isArray(values) && values.length === length && values.every(Number.isFinite);
const box = (b) => vec(b, 6) && b.slice(0, 3).every((x, i) => x <= b[i + 3]);
const bytesPerBlock = {
  DXT1: 8,
  DXT5: 16,
  ATI1N: 8,
  ATI2N: 16,
  BC7: 16,
  BC6H: 16,
};
function validateTexture(texture, m) {
  const file = m.files[texture.file],
    bank = 'mips' in texture;
  const levels = bank ? texture.mips : texture.levels;
  if (!file || !Array.isArray(levels) || !levels.length || levels.length > 16)
    throw Error('Invalid mip layout');
  if (
    bank &&
    (!Array.isArray(texture.textures) || !texture.textures.length || texture.textures.length > 128)
  )
    throw Error('Invalid texture layers');
  let offset = 0;
  const top = levels.at(-1);
  const paged = levels[0].file !== undefined;
  for (const [i, l] of levels.entries()) {
    const page = l.file ? m.files[l.file] : file;
    if (
      !page ||
      (l.file !== undefined) !== paged ||
      !bounded(l.offset, (page.decodedSize ?? page.size) - l.size)
    )
      throw Error('Invalid mip page layout');
    const depth = bank ? texture.textures.length : (l.d ?? 0);
    if (
      !bounded(l.w, bank ? 1024 : 16384) ||
      !l.w ||
      !bounded(l.h, bank ? 1024 : 16384) ||
      !l.h ||
      !bounded(depth, 2048) ||
      !depth ||
      l.level !== levels.length - 1 - i ||
      l.w !== Math.max(1, top.w >> l.level) ||
      l.h !== Math.max(1, top.h >> l.level) ||
      (!paged && l.offset !== offset)
    )
      throw Error('Invalid mip layout');
    const block = bytesPerBlock[texture.format],
      astc = Number(/^ASTC([4568])x\1$/.exec(texture.format)?.[1] ?? 0);
    const bytes = astc
      ? Math.ceil(l.w / astc) * Math.ceil(l.h / astc) * 16
      : block
        ? Math.ceil(l.w / 4) * Math.ceil(l.h / 4) * block
        : l.w *
          l.h *
          ({
            RGBA8888: 4,
            RGBA16161616F: 8,
          }[texture.format] ?? 0);
    if (!bytes || l.size !== bytes * depth) throw Error('Invalid mip byte count');
    offset += l.size;
  }
  if (!paged && offset !== (file.decodedSize ?? file.size))
    throw Error('Invalid texture payload size');
}
export function validate(value) {
  const m = value;
  if (
    !m ||
    m.format !== 'cswatch-native-world' ||
    m.version !== 3 ||
    m.units !== 'inches' ||
    m.up !== 'Z' ||
    !box(m.bounds)
  )
    throw Error('Unknown native world format or bounds');
  if (!m.files || Object.keys(m.files).length > 8192) throw Error('Invalid file table');
  let total = 0;
  for (const [name, f] of Object.entries(m.files)) {
    if (
      !/^[0-9a-f]{64}\.bin$/.test(name) ||
      name !== f.sha256 + '.bin' ||
      (f.br !== undefined &&
        (!bounded(f.br.size, f.size) || !f.br.size || !/^[a-f0-9]{64}$/.test(f.br.sha256))) ||
      !bounded(f.size, 256 * MiB) ||
      (f.packing !== undefined &&
        (![1, 8, 16].includes(f.packing) ||
          !bounded(f.decodedSize, 256 * MiB) ||
          f.decodedSize < f.size ||
          f.decodedSize % f.packing !== 0)) ||
      (f.decodedSize !== undefined && f.packing === undefined)
    )
      throw Error('Invalid file record');
    total += f.decodedSize ?? f.size;
  }
  const g = m.geometry;
  if (
    total > 2 * 1024 * MiB ||
    g?.stride !== 60 ||
    !bounded(g.vertices, 12000000) ||
    !bounded(g.indices, 40000000) ||
    g.indices % 3 ||
    !m.files[g.vb] ||
    !m.files[g.ib]
  )
    throw Error('Invalid geometry budget');
  if (
    !Array.isArray(m.chunks) ||
    m.chunks.length > 65536 ||
    !Array.isArray(m.materials) ||
    !m.materials.length ||
    m.materials.length > 8192 ||
    !Array.isArray(m.entities) ||
    m.entities.length > 65536 ||
    !Array.isArray(m.arrays) ||
    m.arrays.length > 2048 ||
    !Array.isArray(m.roles) ||
    m.roles.length > 32
  )
    throw Error('Invalid scene table');
  let next = 0,
    vertices = 0;
  for (const c of m.chunks) {
    if (
      !box(c.bounds) ||
      !Array.isArray(c.ranges) ||
      c.ranges.length > 8192 ||
      c.banks.length !== m.roles.length ||
      !c.banks.every((i) => i === -1 || bounded(i, m.arrays.length - 1))
    )
      throw Error('Invalid chunk');
    for (const r of c.ranges) {
      if (
        r.first !== next ||
        !bounded(r.count, g.indices - next) ||
        !r.count ||
        r.count % 3 ||
        !box(r.bounds) ||
        !bounded(r.material, m.materials.length - 1) ||
        !(r.entity === -1 || bounded(r.entity, m.entities.length - 1))
      )
        throw Error('Invalid draw range');
      if (
        !bounded(r.vertices, g.vertices - vertices) ||
        !r.vertices ||
        !vec(r.uvBounds, 4) ||
        !vec(r.positionGrid, 6) ||
        (r.placement !== undefined && !vec(r.placement, 16)) ||
        !vec(r.attributes, 4) ||
        !Array.isArray(r.streams) ||
        r.streams.length !== 7 ||
        !r.streams.every((entry, index) =>
          entry === null
            ? index >= 3
            : vec(entry, 3) &&
              bounded(entry[2], 2) &&
              bounded(entry[0], m.files[g.vb].decodedSize ?? m.files[g.vb].size) &&
              bounded(entry[1], (m.files[g.vb].decodedSize ?? m.files[g.vb].size) - entry[0]) &&
              entry[1] > 0,
        )
      )
        throw Error('Invalid vertex streams');
      vertices += r.vertices;
      next += r.count;
    }
  }
  if (next !== g.indices || vertices !== g.vertices) throw Error('Incomplete index coverage');
  let gpuBytes = 0;
  for (const texture of [...m.arrays, ...Object.values(m.specials)]) {
    validateTexture(texture, m);
    for (const mip of 'mips' in texture ? texture.mips : texture.levels) gpuBytes += mip.size;
    if (gpuBytes > 2 * 1024 * MiB) throw Error('Texture allocation budget exceeded');
  }
  const p = m.phone;
  if (
    !p ||
    !Array.isArray(p.arrays) ||
    p.arrays.length !== m.arrays.length ||
    !p.specials ||
    !p.hdr ||
    !p.lightmaps ||
    !p.volumes
  )
    throw Error('Invalid phone texture tier');
  p.arrays.forEach((bank, index) => {
    const desktop = m.arrays[index];
    if (
      !/^ASTC([4568])x\1$/.test(bank.format) ||
      bank.id !== desktop.id ||
      bank.role !== desktop.role ||
      bank.srgb !== desktop.srgb ||
      !Array.isArray(bank.textures) ||
      bank.textures.length !== desktop.textures.length ||
      bank.textures.some((name, layer) => name !== desktop.textures[layer])
    )
      throw Error('Invalid phone texture bank');
  });
  let phoneBytes = 0;
  for (const texture of [...p.arrays, ...Object.values(p.specials)]) {
    validateTexture(texture, m);
    for (const mip of 'mips' in texture ? texture.mips : texture.levels) phoneBytes += mip.size;
    if (phoneBytes > 512 * MiB) throw Error('Phone texture allocation budget exceeded');
  }
  for (const [name, range] of Object.entries(p.hdr))
    if (!p.specials[name] || !(range > 0 && range <= 64)) throw Error('Invalid phone HDR range');
  for (const env of m.environments)
    if (p.specials[p.lightmaps[env.world]]?.levels.at(-1).d !== 3)
      throw Error('Invalid phone lightmap atlas');
  for (const [name, volume] of Object.entries(p.volumes))
    if (
      !p.specials[name] ||
      !volume.shadowBase ||
      !bounded(volume.shadowBase, (p.specials[name].levels.at(-1).d ?? 0) - 1)
    )
      throw Error('Invalid phone probe volume');
  for (const mat of m.materials) {
    for (const ref of Object.values(mat.bindings)) {
      if (
        !vec(ref, 2) ||
        !bounded(ref[0], m.arrays.length - 1) ||
        !bounded(ref[1], m.arrays[ref[0]].textures.length - 1)
      )
        throw Error('Invalid material texture reference');
    }
  }
  for (const env of m.environments) {
    if (
      !vec(env.transform, 16) ||
      !vec(env.lighting.m_vLightmapUvScale, 2) ||
      !Array.isArray(env.entities) ||
      env.entities.length > 65536
    )
      throw Error('Invalid world environment');
    for (const probe of env.entities.filter((e) => e.cubemaptexture && e.array_index != null))
      if (!bounded(Number(probe.array_index), 319)) throw Error('Invalid probe index');
  }
  for (const p of Object.values(m.post))
    if (
      !bounded(p.dimension, 64) ||
      p.dimension < 2 ||
      m.files[p.lut]?.size !== p.dimension ** 3 * 4
    )
      throw Error('Invalid color grading LUT');
  if (m.visibility && (!m.files[m.visibility.file] || !bounded(m.visibility.clusters, 65536)))
    throw Error('Invalid visibility table');
  return m;
}
