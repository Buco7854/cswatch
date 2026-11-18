import { originalEquipmentGLB } from './original-equipment';

/** Original asymmetric one-joint QA actor in raw S2V axes, not a game character. */
export function originalAgentGLB() {
  const previous = originalEquipmentGLB(),
    length = previous.readUInt32LE(12),
    json = JSON.parse(previous.subarray(20, 20 + length).toString()),
    start = 28 + length,
    oldBinary = previous.subarray(start),
    marker = oldBinary.length,
    joints = marker + 36 * 3 * 4,
    weights = joints + 36 * 4,
    inverse = weights + 36 * 4 * 4,
    binary = Buffer.alloc(inverse + 64);
  oldBinary.copy(binary);
  // glTF skins use joint space. Bake original shapes into their vertex positions,
  // rather than relying on mesh-node transforms that skinning can cancel.
  for (let vertex = 0; vertex < 36; vertex++) {
    const x = oldBinary.readFloatLE(vertex * 12),
      y = oldBinary.readFloatLE(vertex * 12 + 4),
      z = oldBinary.readFloatLE(vertex * 12 + 8);
    binary.writeFloatLE(x, vertex * 12);
    binary.writeFloatLE(y * 20 + 0.8, vertex * 12 + 4);
    binary.writeFloatLE(z * 2, vertex * 12 + 8);
    binary.writeFloatLE(x * 0.5, marker + vertex * 12);
    binary.writeFloatLE(y * 2 + 1.1, marker + vertex * 12 + 4);
    binary.writeFloatLE(z * 6 + 0.32, marker + vertex * 12 + 8);
    binary.writeFloatLE(1, weights + vertex * 16);
  }
  for (let index = 0; index < 16; index++)
    binary.writeFloatLE(index % 5 === 0 ? 1 : 0, inverse + index * 4);
  json.asset.generator = 'Original cswatch skinned actor QA, not game artwork';
  json.nodes = [
    { name: 'qa-original-agent-root', children: [1, 2, 3] },
    { name: 'qa-original-agent-body', mesh: 0, skin: 0 },
    { name: 'qa-original-agent-native-front', mesh: 1, skin: 0 },
    { name: 'qa-original-agent-bone' },
  ];
  json.scenes = [{ nodes: [0] }];
  json.meshes = [0, 1].map((material) => ({
    primitives: [
      {
        attributes: { POSITION: material === 0 ? 0 : 2, NORMAL: 1, JOINTS_0: 3, WEIGHTS_0: 4 },
        material,
      },
    ],
  }));
  json.materials = [
    [0.02, 0.04, 0.9],
    [0.02, 0.9, 0.04],
  ].map((color) => ({
    extensions: { KHR_materials_unlit: {} },
    pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1 },
  }));
  json.skins = [
    { name: 'qa-original-one-joint', joints: [3], skeleton: 3, inverseBindMatrices: 5 },
  ];
  json.bufferViews.push(
    { buffer: 0, byteOffset: marker, byteLength: 36 * 12 },
    { buffer: 0, byteOffset: joints, byteLength: 36 * 4 },
    { buffer: 0, byteOffset: weights, byteLength: 36 * 16 },
    { buffer: 0, byteOffset: inverse, byteLength: 64 },
  );
  json.accessors[0].min = [-0.3, 0, -0.08];
  json.accessors[0].max = [0.3, 1.6, 0.08];
  json.accessors.push(
    {
      bufferView: 2,
      componentType: 5126,
      count: 36,
      type: 'VEC3',
      min: [-0.15, 1.02, 0.08],
      max: [0.15, 1.18, 0.56],
    },
    { bufferView: 3, componentType: 5121, count: 36, type: 'VEC4' },
    { bufferView: 4, componentType: 5126, count: 36, type: 'VEC4' },
    { bufferView: 5, componentType: 5126, count: 1, type: 'MAT4' },
  );
  json.buffers = [{ byteLength: binary.length }];
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
