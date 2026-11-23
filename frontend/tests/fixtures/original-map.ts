import { crc32, deflateSync } from 'node:zlib';
import type { Playback } from '../../../shared/playback';
import type { MapEnvironment } from '../../../shared/map-assets';

/** Original QA geometry and raster only. These are not CS2 artwork or map data. */
export const qaMap = 'de_original_map_qa';
export const qaActor = '76561198000000001';
export const qaOverview = {
  image: `/api/maps/${qaMap}/overview.png`,
  origin: { x: -1024, y: 1024 },
  scale: 2,
  referenceSize: 1024 as const,
  assetVersion: 'synthetic-original-qa-not-CS2',
};
export const qaEnvironment: MapEnvironment = {
  assetVersion: 'original-qa-sky-not-CS2-v1',
  landscape: false,
  sky: {
    faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
      (face) => `/api/maps/${qaMap}/environment/${face}.png`,
    ) as MapEnvironment['sky']['faces'],
    brightness: 1,
  },
};
const rooms = [
  [128, 256, 384, 768],
  [640, 256, 896, 768],
  [384, 448, 640, 576],
];
function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
/** Six original colored cube slots, with asymmetric white/black left-corner marks. */
export function originalEnvironmentPNG(index: number) {
  const colors = [
      [210, 35, 35],
      [35, 200, 35],
      [35, 35, 210],
      [210, 210, 35],
      [210, 35, 210],
      [35, 210, 210],
    ],
    side = 32,
    stride = side * 4 + 1,
    pixels = Buffer.alloc(stride * side);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const color =
          x < 12 && y < 12 ? [245, 245, 245] : x < 12 && y >= 20 ? [12, 12, 12] : colors[index],
        offset = y * stride + 1 + x * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
export function originalOverviewPNG() {
  const side = 1024,
    stride = side * 4 + 1,
    pixels = Buffer.alloc(stride * side);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const offset = y * stride + 1 + x * 4,
        walkable = rooms.some(
          ([left, top, right, bottom]) => x >= left && x < right && y >= top && y < bottom,
        );
      pixels[offset] = walkable ? 119 : 35;
      pixels[offset + 1] = walkable ? 151 : 44;
      pixels[offset + 2] = walkable ? 137 : 42;
      pixels[offset + 3] = 255;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
export function originalMapGLB(
  engineLight = false,
  texture?: 'webp' | 'broken',
  landscape?: 'tagged' | 'untagged',
  black?: 'exact' | 'name-only',
  vertexLighting = false,
) {
  const positions: number[] = [],
    normals: number[] = [],
    coordinates: number[] = [];
  // Distinct floor and landscape colors make pass order measurable after grading.
  const floorColor = landscape ? [0.18, 0.59, 0.25, 1] : [0.46, 0.59, 0.53, 1];
  for (const [left, top, right, bottom] of rooms) {
    const source = [
      [left, top],
      [right, bottom],
      [right, top],
      [left, top],
      [left, bottom],
      [right, bottom],
    ];
    for (const [x, y] of source) {
      const sx = -1024 + x * 2,
        sy = 1024 - y * 2;
      // Inverse of the app's documented S2V +90deg-Y map transform.
      positions.push(Math.fround(sy * 0.0254), 0, Math.fround(sx * 0.0254));
      normals.push(0, 1, 0);
      coordinates.push(x / 1024, y / 1024);
    }
  }
  // Original lossless 16x16 red/blue test raster, generated from two solid RGB colors.
  const webp =
      texture === 'broken'
        ? Buffer.from('Explicit original QA malformed WebP')
        : Buffer.from(
            'UklGRioAAABXRUJQVlA4TB0AAAAvD8ADAA9wkaR3KR8mc/5jCWLBZP7S3RlE9D90AQA=',
            'base64',
          ),
    vertexData = [...positions, ...normals, ...(texture ? coordinates : [])],
    imageOffset = vertexData.length * 4,
    vertexOffset = imageOffset + (texture ? Math.ceil(webp.length / 4) * 4 : 0),
    vertexBytes = vertexLighting ? (positions.length / 3) * 4 : 0,
    binary = Buffer.alloc(vertexOffset + vertexBytes);
  vertexData.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  if (texture) webp.copy(binary, imageOffset);
  if (vertexLighting) binary.fill(Buffer.from([255, 0, 0, 128]), vertexOffset);
  const document = {
    asset: { version: '2.0', generator: 'Original cswatch QA geometry, not CS2 content' },
    scene: 0,
    scenes: [
      { nodes: [0, ...(engineLight ? [1] : []), ...(landscape ? [engineLight ? 2 : 1] : [])] },
    ],
    nodes: [
      { mesh: 0 },
      ...(engineLight
        ? [
            {
              rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
              extensions: { KHR_lights_punctual: { light: 0 } },
            },
          ]
        : []),
      ...(landscape
        ? [
            {
              name: 'cswatch_skybox',
              mesh: 1,
              translation: [0, 2, 0],
              scale: [3, 1, 3],
              ...(landscape === 'tagged'
                ? { extras: { cswatch: { kind: 'skybox', schemaVersion: 1 } } }
                : {}),
            },
          ]
        : []),
    ],
    ...(engineLight || texture
      ? {
          extensionsUsed: [
            ...(engineLight ? ['KHR_lights_punctual'] : []),
            ...(texture ? ['EXT_texture_webp'] : []),
          ],
          ...(texture ? { extensionsRequired: ['EXT_texture_webp'] } : {}),
          ...(engineLight
            ? {
                extensions: {
                  KHR_lights_punctual: {
                    lights: [{ type: 'directional', color: [1, 1, 1], intensity: 2049 }],
                  },
                },
              }
            : {}),
        }
      : {}),
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              ...(texture ? { TEXCOORD_0: 2 } : {}),
              ...(vertexLighting ? { _COLOR_1: texture ? 3 : 2 } : {}),
            },
            material: 0,
          },
        ],
      },
      ...(landscape
        ? [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 1 }] }]
        : []),
    ],
    materials: [
      {
        ...(black
          ? {
              name: 'black_simple',
              ...(black === 'exact'
                ? {
                    extras: {
                      vmat: {
                        Name: 'materials/dev/black_simple.vmat',
                        ShaderName: 'csgo_black_unlit.vfx',
                        IntParams: { g_bFogEnabled: 1 },
                      },
                    },
                  }
                : {}),
            }
          : {}),
        doubleSided: true,
        ...(vertexLighting ? { extras: { cswatch: { vertexLighting: true } } } : {}),
        pbrMetallicRoughness: {
          baseColorFactor: texture || black || vertexLighting ? [1, 1, 1, 1] : floorColor,
          ...(texture ? { baseColorTexture: { index: 0 } } : {}),
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
      ...(landscape
        ? [
            {
              doubleSided: true,
              pbrMetallicRoughness: {
                baseColorFactor: [0.02, 0.04, 0.9, 1],
                metallicFactor: 0,
                roughnessFactor: 1,
              },
            },
          ]
        : []),
    ],
    ...(texture
      ? {
          images: [{ bufferView: 3, mimeType: 'image/webp' }],
          textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }],
        }
      : {}),
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length * 4, target: 34962 },
      {
        buffer: 0,
        byteOffset: positions.length * 4,
        byteLength: normals.length * 4,
        target: 34962,
      },
      ...(texture
        ? [
            {
              buffer: 0,
              byteOffset: (positions.length + normals.length) * 4,
              byteLength: coordinates.length * 4,
              target: 34962,
            },
            { buffer: 0, byteOffset: imageOffset, byteLength: webp.length },
          ]
        : []),
      ...(vertexLighting
        ? [{ buffer: 0, byteOffset: vertexOffset, byteLength: vertexBytes, target: 34962 }]
        : []),
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: [0, 1, 2].map((axis) =>
          Math.min(...positions.filter((_, index) => index % 3 === axis)),
        ),
        max: [0, 1, 2].map((axis) =>
          Math.max(...positions.filter((_, index) => index % 3 === axis)),
        ),
      },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      ...(texture
        ? [{ bufferView: 2, componentType: 5126, count: coordinates.length / 2, type: 'VEC2' }]
        : []),
      ...(vertexLighting
        ? [
            {
              bufferView: texture ? 4 : 2,
              componentType: 5121,
              normalized: true,
              count: positions.length / 3,
              type: 'VEC4',
            },
          ]
        : []),
    ],
  };
  const json = Buffer.from(
    JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length / 4) * 4, ' '),
  );
  const header = Buffer.alloc(12),
    jsonHeader = Buffer.alloc(8),
    binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  jsonHeader.writeUInt32LE(json.length);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(binary.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, binary]);
}
export function originalMapReplay(map = qaMap): Playback {
  return {
    map,
    sample: false,
    tickRate: 64,
    players: [
      { id: qaActor, name: 'Original QA reviewer', team: 3 },
      { id: '76561198000000002', name: 'Original QA opponent', team: 2 },
    ],
    frames: [0, 640].map((tick) => ({
      tick,
      players: [-512, 512].map((x, index) => ({
        id: index ? '76561198000000002' : qaActor,
        x: x + (index ? 0 : tick / 2.5),
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        health: 100,
        team: index ? 2 : 3,
        alive: true,
        weapon: 'ak47',
      })),
    })),
    rounds: [{ number: 1, tick: 0, liveTick: 64 }],
    events: [
      {
        type: 'grenade_thrown',
        tick: 0,
        user_steamid: qaActor,
        weapon: 'smokegrenade',
        entityid: 7,
      },
      {
        type: 'smokegrenade_detonate',
        tick: 256,
        user_steamid: qaActor,
        weapon: 'smokegrenade',
        entityid: 7,
        x: 512,
        y: 0,
        z: 0,
      },
    ],
    grenades: [
      {
        id: '7-0',
        kind: 'CSmokeGrenadeProjectile',
        points: [
          { tick: 0, x: -512, y: 0, z: 10 },
          { tick: 128, x: 0, y: 0, z: 300 },
          { tick: 256, x: 512, y: 0, z: 0 },
        ],
      },
    ],
    // Deliberately wider than the map to prove the overview never uses replay bounds.
    worldBounds: { minX: -2048, maxX: 2048, minY: -2048, maxY: 2048, minZ: 0, maxZ: 300 },
  };
}

export function originalEnvironmentReplay(map = qaMap): Playback {
  const replay = originalMapReplay(map);
  return {
    ...replay,
    events: [],
    grenades: [],
    frames: [
      [0, 0],
      [180, 0],
      [90, 0],
      [-90, 0],
      [0, -90],
      [0, 90],
      [30, -20],
      [-30, -20],
      [30, 20],
    ].map(([yaw, pitch], index) => ({
      tick: index * 64,
      // Put this original QA camera outside the tiny QA geometry so all sky rays are unobstructed.
      players: replay.frames[0].players.map((player, i) =>
        i ? player : { ...player, x: 10000, y: 10000, z: 10000, yaw, pitch },
      ),
    })),
  };
}
