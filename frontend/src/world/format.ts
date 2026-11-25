import { validate as validateShared } from '../../../shared/native-world-format.mjs';
import { transposeBlocks } from './block-layout.mjs';
export interface Mip {
  file?: string;
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
  entities: (Entity & {
    initialVisibility: boolean;
    parentEntity?: number;
    model?: string;
    hammeruniqueid?: string;
  })[];
  /** Phone ASTC tier. Banks keep the desktop ids and layer order. */
  phone: {
    arrays: Bank[];
    specials: Record<string, Texture>;
    rgbm: Record<string, number>;
    lightmaps: Record<string, string>;
    volumes: Record<string, { shadow: string; shadowBase: number }>;
  };
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
export function validate(value: unknown): Manifest {
  return validateShared(value) as Manifest;
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
  return readFileRecord(dir, file, m.files[file]);
}
export async function readFileRecord(dir: URL, file: string, f: Manifest['files'][string]) {
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
