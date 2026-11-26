// Original synthetic native world: flat floor quads, constant textures and baked lighting in both
// texture tiers. Geometry streams use the same encoder as the offline packer. No game content.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import { MeshoptEncoder } from '../../../frontend/node_modules/meshoptimizer/meshopt_encoder.js';
import { vertexArchive } from '../../cs2export/quantize.mjs';
import { writeInstance } from '../../cs2export/instances.mjs';
await MeshoptEncoder.ready;
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const roles = [
  'color',
  'normal',
  'ao',
  'color2',
  'normal2',
  'blend',
  'detail',
  'metal',
  'aux0',
  'aux1',
  'aux2',
  'illum',
  'detailMask',
  'ao2',
  'height',
  'rough',
];
function half(value) {
  if (value === 0) return 0;
  const exponent = Math.floor(Math.log2(value));
  return ((exponent + 15) << 10) | Math.round((value / 2 ** exponent - 1) * 1024);
}
const rgba16f = (rgba, texels) => {
  const bytes = Buffer.alloc(texels * 8);
  for (let i = 0; i < texels; i++)
    rgba.forEach((value, c) => bytes.writeUInt16LE(half(value), i * 8 + c * 2));
  return bytes;
};
const rgba8 = (rgba, texels) => Buffer.alloc(texels * 4).map((_, i) => rgba[i % 4]);
function dxt1([r, g, b]) {
  const color = (Math.round(r * 31) << 11) | (Math.round(g * 63) << 5) | Math.round(b * 31);
  const block = Buffer.alloc(8);
  block.writeUInt16LE(color, 0);
  block.writeUInt16LE(color, 2);
  return block;
}
// ASTC LDR void-extent block: one constant UNORM16 color for the whole block.
function astcConstant(rgba) {
  const block = Buffer.from([
    0xfc, 0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  rgba.forEach((value, c) => block.writeUInt16LE(Math.round(value * 65535), 8 + c * 2));
  return block;
}
/**
 * Floor quads are [minX, minY, maxX, maxY] on Z=0, drawn as instances of one unit quad scaled into
 * place; faces are four [x, y, z] corners in an ordinary range. Source inches.
 */
export function nativeWorldPack({
  map,
  sourceManifest = '42',
  quads = [[0, 0, 1, 1]],
  faces = [],
  floor = [0.46, 0.59, 0.53],
}) {
  const files = new Map(),
    records = {};
  const add = (bytes, category) => {
    const hash = sha(bytes),
      name = hash + '.bin';
    files.set(name, bytes);
    records[name] = { size: bytes.length, sha256: hash, category };
    return name;
  };
  const unit = (a) => a.map((x) => x / Math.hypot(...a));
  function mesh(all) {
    const v = Buffer.alloc(all.length * 4 * 60),
      indices = Buffer.alloc(all.length * 6 * 4);
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    all.forEach((corners, q) => {
      const edge = (i) => corners[i].map((x, c) => x - corners[0][c]);
      const [e, f] = [edge(1), edge(3)];
      const normal = unit([
          e[1] * f[2] - e[2] * f[1],
          e[2] * f[0] - e[0] * f[2],
          e[0] * f[1] - e[1] * f[0],
        ]),
        tangent = unit(e);
      corners.forEach((point, corner) => {
        const o = (q * 4 + corner) * 60;
        point.forEach((x, c) => {
          v.writeFloatLE(x, o + c * 4);
          v.writeInt8(Math.round(normal[c] * 127), o + 12 + c);
          v.writeInt8(Math.round(tangent[c] * 127), o + 16 + c);
          min[c] = Math.min(min[c], x);
          max[c] = Math.max(max[c], x);
        });
        v[o + 19] = 127;
        v.writeFloatLE(corner === 1 || corner === 2 ? 1 : 0, o + 20);
        v.writeFloatLE(corner >= 2 ? 1 : 0, o + 24);
        v.writeUInt16LE(32768, o + 28);
        v.writeUInt16LE(32768, o + 30);
        v.fill(255, o + 32, o + 36);
        v[o + 52] = 1;
        v.fill(255, o + 56, o + 60);
      });
      [0, 1, 2, 0, 2, 3].forEach((index, i) =>
        indices.writeUInt32LE(q * 4 + index, (q * 6 + i) * 4),
      );
    });
    return { v, indices, localBounds: [...min, ...max], quads: all.length };
  }
  const floorMesh = mesh([
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
    ]),
    faceMesh = faces.length ? mesh(faces) : null;
  if (!quads.length) throw Error('The fixture needs at least one floor quad');
  const placements = quads.map(([x0, y0, x1, y1]) => [
    x1 - x0,
    0,
    0,
    0,
    0,
    y1 - y0,
    0,
    0,
    0,
    0,
    1,
    0,
    x0,
    y0,
    0,
    1,
  ]);
  const quadBounds = quads.map(([x0, y0, x1, y1]) => [x0, y0, 0, x1, y1, 0]);
  const union = (boxes) =>
    boxes.reduce(
      (a, b) =>
        [0, 1, 2, 3, 4, 5].map((i) => (i < 3 ? Math.min(a[i], b[i]) : Math.max(a[i], b[i]))),
      [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    );
  const floorBounds = union(quadBounds),
    bounds = union([floorBounds, ...(faceMesh ? [faceMesh.localBounds] : [])]);
  const material = {
    name: 'materials/fixture/floor.vmat',
    shader: 'csgo_complex.vfx',
    ints: {},
    scalars: {},
    vectors: {},
    attrs: {},
    signature: [],
    slots: { g_tColor: { name: 'fixture/floor', ref: [0, 0] } },
    bindings: { color: [0, 0] },
  };
  const archive = vertexArchive(),
    floorRange = archive.encode(floorMesh, material),
    faceRange = faceMesh && archive.encode(faceMesh, material);
  const table = Buffer.alloc(placements.length * 64);
  placements.forEach((placement, i) => writeInstance(table, i, placement, floorRange.attributes));
  const indices = Buffer.concat([
    floorMesh.indices,
    ...(faceMesh
      ? [
          Buffer.from(
            new Uint32Array(
              new Uint32Array(
                faceMesh.indices.buffer,
                faceMesh.indices.byteOffset,
                faceMesh.quads * 6,
              ).map((index) => index + 4),
            ).buffer,
          ),
        ]
      : []),
  ]);
  const vertexCount = 4 + (faceMesh?.quads ?? 0) * 4,
    indexCount = 6 + (faceMesh?.quads ?? 0) * 6;
  const vb = add(archive.finish(), 'geometry'),
    ib = add(Buffer.from(MeshoptEncoder.encodeIndexBuffer(indices, indexCount, 4)), 'geometry'),
    instances = { file: add(table, 'geometry'), count: placements.length };
  const ranges = [
    {
      ...floorRange,
      first: 0,
      count: 6,
      bounds: floorBounds,
      material: 0,
      entity: -1,
      instances: [0, placements.length],
    },
    ...(faceMesh
      ? [
          {
            ...faceRange,
            first: 6,
            count: faceMesh.quads * 6,
            bounds: faceMesh.localBounds,
            material: 0,
            entity: -1,
          },
        ]
      : []),
  ];
  const special = (format, w, h, d, bytes, category) => ({
    file: add(bytes, category),
    format,
    flags: 0,
    first: 0,
    depth: d,
    levels: [{ level: 0, w, h, d, offset: 0, size: bytes.length }],
  });
  const world = `maps/${map}`,
    light = `${world}/lightmaps/`;
  const names = {
    sky: 'materials/fixture/sky.vtex',
    cube: `${world}/cubemaps/env_cubemap_array.vtex`,
    lpv: `${light}env_light_probe_volume_atlas.vtex`,
    occlusion: `${light}env_light_probe_volume_atlas_dlshd.vtex`,
    irradiance: `${light}irradiance.vtex`,
    direction: `${light}directional_irradiance.vtex`,
    shadow: `${light}direct_light_shadows.vtex`,
    phone: `${light}phone.vtex`,
  };
  const skyColor = [0.55, 0.7, 0.9, 1],
    ambient = [0.6, 0.6, 0.6, 1];
  const specials = {
    [names.sky]: special('RGBA16161616F', 4, 4, 6, rgba16f(skyColor, 96), 'sky'),
    [names.cube]: special('RGBA16161616F', 4, 4, 6, rgba16f(skyColor, 96), 'cubemaps'),
    [names.lpv]: special('RGBA16161616F', 4, 4, 6, rgba16f(ambient, 96), 'probes'),
    [names.occlusion]: special('RGBA8888', 4, 4, 1, rgba8([0, 0, 0, 255], 16), 'probes'),
    [names.irradiance]: special('RGBA16161616F', 4, 4, 1, rgba16f(ambient, 16), 'lightmaps'),
    [names.direction]: special('DXT1', 4, 4, 1, dxt1([0.5, 0.5, 1]), 'lightmaps'),
    [names.shadow]: special('ATI1N', 4, 4, 1, Buffer.alloc(8), 'lightmaps'),
    'vrf/brdf_lut': special('RGBA16161616F', 4, 4, 3, rgba16f([0.9, 0.1, 0, 1], 48), 'lighting'),
  };
  // The phone HDR encoding with range 1: log2(1 + 1023 v) / 10 per channel.
  const hdr = (rgba) => [
    ...rgba.slice(0, 3).map((x) => Math.round((Math.log2(1 + 1023 * x) / 10) * 255)),
    255,
  ];
  const phone = {
    arrays: [
      {
        id: 0,
        role: 'color',
        srgb: true,
        format: 'ASTC4x4',
        w: 4,
        h: 4,
        levels: 1,
        flags: 0,
        textures: ['fixture/floor'],
        file: add(astcConstant([...floor, 1]), 'textures'),
        mips: [{ level: 0, w: 4, h: 4, offset: 0, size: 16 }],
      },
    ],
    specials: {
      [names.sky]: special('RGBA8888', 4, 4, 6, rgba8(hdr(skyColor), 96), 'sky'),
      [names.cube]: special('RGBA8888', 4, 4, 6, rgba8(hdr(skyColor), 96), 'cubemaps'),
      [names.lpv]: special(
        'RGBA8888',
        4,
        4,
        7,
        Buffer.concat([rgba8(hdr(ambient), 96), rgba8([0, 0, 0, 255], 16)]),
        'probes',
      ),
      [names.phone]: special(
        'RGBA8888',
        4,
        4,
        3,
        Buffer.concat([
          rgba8(hdr(ambient), 16),
          rgba8([128, 128, 255, 255], 16),
          rgba8([0, 0, 0, 255], 16),
        ]),
        'lightmaps',
      ),
      'vrf/brdf_lut': specials['vrf/brdf_lut'],
    },
    hdr: { [names.sky]: 1, [names.cube]: 1, [names.lpv]: 1, [names.phone]: 1 },
    lightmaps: { [world]: names.phone },
    volumes: { [names.lpv]: { shadow: names.occlusion, shadowBase: 6 } },
  };
  // Identity grading cube with two samples per channel.
  const lut = add(
    Buffer.from(
      Array.from({ length: 8 }, (_, i) => [
        i & 1 ? 255 : 0,
        i & 2 ? 255 : 0,
        i & 4 ? 255 : 0,
        255,
      ]).flat(),
    ),
    'grading',
  );
  const vpost = 'lighting/postprocessing/fixture.vpost';
  const value = {
    format: 'cswatch-native-world',
    version: 4,
    map,
    sourceManifest,
    units: 'inches',
    up: 'Z',
    bounds,
    roles,
    geometry: {
      stride: 60,
      vertices: vertexCount,
      indices: indexCount,
      vb,
      ib,
      instances,
    },
    files: records,
    chunks: [
      {
        cell: '0,0,0',
        family: 'opaque',
        side: true,
        sky: false,
        banks: roles.map((role) => (role === 'color' ? 0 : -1)),
        bounds,
        ranges,
      },
    ],
    materials: [
      material,
      {
        name: 'materials/fixture/sky.vmat',
        shader: 'sky.vfx',
        ints: {},
        scalars: {},
        vectors: {},
        attrs: {},
        signature: [],
        slots: { g_tSkyTexture: names.sky },
        bindings: {},
      },
    ],
    arrays: [
      {
        id: 0,
        role: 'color',
        srgb: true,
        format: 'DXT1',
        w: 4,
        h: 4,
        levels: 1,
        flags: 0,
        textures: ['fixture/floor'],
        file: add(dxt1(floor), 'textures'),
        mips: [{ level: 0, w: 4, h: 4, offset: 0, size: 8 }],
      },
    ],
    specials,
    phone,
    post: {
      [vpost]: {
        dimension: 2,
        lut,
        tonemap: {
          m_flExposureBias: 0,
          m_flShoulderStrength: 0,
          m_flLinearStrength: 0.001,
          m_flLinearAngle: 0.001,
          m_flToeStrength: 1,
          m_flToeNum: 1,
          m_flToeDenom: 1,
          m_flWhitePoint: 1.5,
        },
        bloom: { m_flBloomThreshold: 1, m_flBloomThresholdWidth: 1, m_flBloomStrength: 0 },
      },
    },
    entities: [],
    environments: [
      {
        world,
        sky: false,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        lighting: { m_vLightmapUvScale: [1, 1] },
        entities: [
          {
            classname: 'env_sky',
            skyname: 'materials/fixture/sky.vmat',
            brightnessscale: 1,
            origin: [0, 0, 0],
            angles: [0, 0, 0],
          },
          {
            classname: 'light_environment',
            origin: [0, 0, 0],
            angles: [-60, 30, 0],
            color: [255, 248, 235],
            brightness: 1,
          },
          {
            classname: 'env_combined_light_probe_volume',
            origin: [0, 0, 0],
            angles: [0, 0, 0],
            box_mins: [-4096, -4096, -1024],
            box_maxs: [4096, 4096, 1024],
            edge_fade_dists: [8, 8, 8],
            indoor_outdoor_level: 0,
            array_index: 0,
            cubemaptexture: names.cube,
            lightprobetexture: names.lpv,
            lightprobetexture_dlshd: names.occlusion,
            light_probe_atlas_x: 0,
            light_probe_atlas_y: 0,
            light_probe_atlas_z: 0,
            light_probe_size_x: 4,
            light_probe_size_y: 4,
            light_probe_size_z: 1,
          },
          {
            classname: 'post_processing_volume',
            master: true,
            postprocessing: vpost,
            enableexposure: false,
            origin: [0, 0, 0],
            angles: [0, 0, 0],
          },
        ],
      },
    ],
    visibility: null,
  };
  const model = Buffer.from(JSON.stringify(value));
  return { value, model, files };
}
export const vertexFile = nativeWorldPack({ map: 'fixture' }).value.geometry.vb;
export function writeNativeWorld(root, map, sourceManifest = '42', options = {}) {
  const { model, files } = nativeWorldPack({ map, sourceManifest, ...options });
  const dir = join(root, map);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'map.json'), model);
  writeFileSync(join(dir, 'map.json.br'), brotliCompressSync(model));
  return model;
}
