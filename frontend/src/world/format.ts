import { transposeBlocks } from './block-layout.mjs';
export interface Mip {
  level: number;
  w: number;
  h: number;
  offset: number;
  size: number;
  d?: number;
}
export interface Texture {
  radiance?: number[];
  file: string;
  format: string;
  flags: number;
  levels: Mip[];
}
export interface Bank {
  file: string;
  format: string;
  srgb: boolean;
  flags: number;
  textures: string[];
  mips: Mip[];
}
export interface Material {
  name: string;
  shader: string;
  slots: Record<string, unknown>;
  ints: Record<string, number>;
  scalars: Record<string, number>;
  vectors: Record<string, number[]>;
  bindings: Record<string, number[]>;
}
export interface Range {
  bounds: number[];
  first: number;
  count: number;
  entity: number;
  material: number;
  vertices: number;
  uvBounds: number[];
  positionGrid: number[];
  placement?: number[];
  streams: ([number, number, number] | null)[];
  attributes: number[];
}
export interface Chunk {
  bounds: number[];
  family: string;
  sky: boolean;
  side: boolean;
  banks: number[];
  ranges: Range[];
}
export interface Entity {
  classname: string;
  origin: number[] | string;
  angles: number[] | string;
  [key: string]: unknown;
}
export interface Environment {
  sky: boolean;
  world: string;
  transform: number[];
  entities: Entity[];
  lighting: { m_vLightmapUvScale: number[] };
}
export interface Manifest {
  format: string;
  version: number;
  map: string;
  units: string;
  up: string;
  roles: string[];
  bounds: number[];
  visibility: { file: string; clusters: number } | null;
  geometry: { vb: string; ib: string; stride: number; indices: number; vertices: number };
  files: Record<
    string,
    { sha256: string; size: number; category: string; decodedSize?: number; packing?: number }
  >;
  materials: Material[];
  arrays: Bank[];
  chunks: Chunk[];
  specials: Record<string, Texture>;
  environments: Environment[];
  entities: { initialVisibility: boolean }[];
  post: Record<
    string,
    {
      dimension: number;
      lut: string;
      tonemap: Record<string, number>;
      bloom: Record<string, number>;
    }
  >;
}
const MiB = 1024 ** 2;
const bounded = (n: number, max: number) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const vec = (values: number[], length: number) =>
  Array.isArray(values) && values.length === length && values.every(Number.isFinite);
const box = (b: number[]) => vec(b, 6) && b.slice(0, 3).every((x, i) => x <= b[i + 3]);
const bytesPerBlock: Record<string, number> = {
  DXT1: 8,
  DXT5: 16,
  ATI1N: 8,
  ATI2N: 16,
  BC7: 16,
  BC6H: 16,
};

function validateTexture(texture: Bank | Texture, m: Manifest) {
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
  const top = levels.at(-1)!;
  for (const [i, l] of levels.entries()) {
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
      l.offset !== offset
    )
      throw Error('Invalid mip layout');
    const block = bytesPerBlock[texture.format];
    const bytes = block
      ? Math.ceil(l.w / 4) * Math.ceil(l.h / 4) * block
      : l.w * l.h * ({ RGBA8888: 4, RGBA16161616F: 8 }[texture.format] ?? 0);
    if (!bytes || l.size !== bytes * depth) throw Error('Invalid mip byte count');
    offset += l.size;
  }
  if (offset !== (file.decodedSize ?? file.size)) throw Error('Invalid texture payload size');
}

export function validate(value: unknown): Manifest {
  const m = value as Manifest;
  if (
    !m ||
    m.format !== 'cswatch-native-world' ||
    m.version !== 2 ||
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
      !bounded(f.size, 256 * MiB) ||
      (f.packing !== undefined &&
        (![1, 8, 16].includes(f.packing) ||
          !bounded(f.decodedSize!, 256 * MiB) ||
          f.decodedSize! < f.size ||
          f.decodedSize! % f.packing !== 0)) ||
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
  for (const texture of [...m.arrays, ...Object.values(m.specials)]) validateTexture(texture, m);
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
async function boundedBody(response: Response, max: number, expected?: number) {
  if (!response.ok || !response.body) throw Error('Map request HTTP ' + response.status);
  if (Number(response.headers.get('content-length') ?? 0) > max)
    throw Error('Map response exceeds byte limit');
  const stream = response.body.getReader(),
    chunks: Uint8Array[] = [];
  const target = expected === undefined ? null : new Uint8Array(expected);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await stream.read();
      if (done) break;
      if (size + value.byteLength > max) {
        await stream.cancel();
        throw Error('Map response exceeds byte limit');
      }
      if (target) target.set(value, size);
      else chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    stream.releaseLock();
  }
  if (target) {
    if (size !== target.length) throw Error('Truncated map file');
    return target;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function loadManifest(dir: URL) {
  const bytes = await boundedBody(await fetch(new URL('map.json', dir)), 16 * MiB);
  return validate(JSON.parse(new TextDecoder().decode(bytes)));
}
export async function readAsset(dir: URL, m: Manifest, file: string) {
  const f = m.files[file];
  if (!f) throw Error('Unknown map file');
  const bytes = await boundedBody(await fetch(new URL(file, dir)), f.size, f.size);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== f.sha256) throw Error('Map file failed integrity check ' + file);
  if (f.packing) {
    const decoded = await boundedBody(
      new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))),
      f.decodedSize!,
      f.decodedSize,
    );
    return f.packing === 1 ? decoded : transposeBlocks(decoded, f.packing, true);
  }
  return bytes;
}
