import { createHash } from 'node:crypto';
import type { EquipmentModelCatalog } from '../../../shared/equipment-models';
import { originalMapReplay } from './original-map';

/** An original bright cuboid prop for renderer QA, not game artwork or a weapon replica. */
export function originalEquipmentGLB(
  color: [number, number, number] = [1, 0, 1],
  muzzle = false,
  transform?: { position: [number, number, number]; scale: [number, number, number] },
) {
  const faces = [
    [
      [1, 0, 0],
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
    [
      [-1, 0, 0],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
      [-1, -1, -1],
    ],
    [
      [0, 1, 0],
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
    ],
    [
      [0, -1, 0],
      [-1, -1, 1],
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
    ],
    [
      [0, 0, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
      [-1, -1, 1],
    ],
    [
      [0, 0, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
    ],
  ];
  const positions: number[] = [],
    normals: number[] = [];
  for (const [normal, ...corners] of faces)
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const corner = corners[index];
      positions.push(corner[0] * 0.3, corner[1] * 0.04, corner[2] * 0.04);
      normals.push(...normal);
    }
  const binary = Buffer.alloc((positions.length + normals.length) * 4);
  [...positions, ...normals].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const json = {
    asset: { version: '2.0', generator: 'Original cswatch equipment QA, not CS2' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: 'qa-original-equipment-body',
        mesh: 0,
        ...(muzzle ? { children: [1] } : {}),
        ...(transform ? { translation: transform.position, scale: transform.scale } : {}),
      },
      ...(muzzle
        ? [
            {
              name: 'cswatch_native_muzzle',
              translation: [0.31, 0.02, 0],
              extras: { cswatchNativeAttachment: 'muzzle_flash' },
            },
          ]
        : []),
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [
      {
        name: 'qa-original-bright-prop',
        extensions: { KHR_materials_unlit: {} },
        pbrMetallicRoughness: {
          baseColorFactor: [...color, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    extensionsUsed: ['KHR_materials_unlit'],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length * 4 },
      { buffer: 0, byteOffset: positions.length * 4, byteLength: normals.length * 4 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 36,
        type: 'VEC3',
        min: [-0.3, -0.04, -0.04],
        max: [0.3, 0.04, 0.04],
      },
      { bufferView: 1, componentType: 5126, count: 36, type: 'VEC3' },
    ],
  };
  const raw = Buffer.from(JSON.stringify(json)),
    document = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
  raw.copy(document);
  const output = Buffer.alloc(28 + document.length + binary.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(document.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  document.copy(output, 20);
  output.writeUInt32LE(binary.length, 20 + document.length);
  output.writeUInt32LE(0x004e4942, 24 + document.length);
  binary.copy(output, 28 + document.length);
  return output;
}
export function originalEquipmentCatalog(
  ids = [
    'ak47',
    'flashbang',
    'hegrenade',
    'smokegrenade',
    'molotov',
    'incgrenade',
    'decoy',
    'c4',
    'plantedc4',
  ],
): EquipmentModelCatalog {
  const bytes = originalEquipmentGLB();
  return {
    schemaVersion: 2,
    items: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          model: `/api/assets/equipment-models/${id}.glb`,
          assetVersion: 'original-QA-static-prop-v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
          decodedTextureBytes: 0,
          geometryBytes: 864,
          bounds: { min: [-0.3, -0.04, -0.04], max: [0.3, 0.04, 0.04] },
        },
      ]),
    ),
  };
}
export function originalEquipmentReplay() {
  const replay = originalMapReplay('de_equipment_qa');
  replay.frames = replay.frames.map((frame) => ({
    ...frame,
    players: frame.players.map((player) => ({ ...player, weapon: 'ak47', yaw: 0, pitch: 0 })),
  }));
  replay.itemState = {
    complete: true,
    coverage: { dropped: true, planted: true, projectile: true },
  };
  replay.itemSamples = [
    {
      id: 'item:1:0:0',
      tick: 0,
      present: true,
      equipment: 'ak47',
      kind: 'dropped',
      x: 200,
      y: 0,
      z: 8,
      pitch: 0,
      yaw: 90,
      roll: 0,
    },
    {
      id: 'item:2:0:0',
      tick: 0,
      present: true,
      equipment: 'plantedc4',
      kind: 'planted',
      x: 0,
      y: 200,
      z: 8,
    },
    ...['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'incgrenade', 'decoy'].map(
      (equipment, index) => ({
        id: `item:${index + 3}:0:0`,
        tick: 0,
        present: true as const,
        equipment,
        kind: 'projectile' as const,
        x: 100 + index * 20,
        y: -100,
        z: 60,
        pitch: 0,
        yaw: 0,
        roll: 0,
      }),
    ),
    { id: 'item:1:0:0', tick: 64, present: false },
  ];
  // Intentionally nearby trajectory with unrelated identity must not add a second body.
  replay.grenades = [
    {
      id: 'trajectory-without-serial',
      kind: 'smokegrenade',
      points: [
        { tick: 0, x: 100, y: -100, z: 60 },
        { tick: 128, x: 180, y: -100, z: 60 },
      ],
    },
  ];
  return replay;
}
