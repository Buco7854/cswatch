/** Original synthetic geometry for contract tests, never game content. */
export function triangle(change = () => {}) {
  const data = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
  };
  change(data);
  const text = JSON.stringify(data),
    json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' ')),
    binary = Buffer.alloc(36),
    header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  binary.writeFloatLE(1, 12);
  binary.writeFloatLE(1, 28);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + 8 + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(binary.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, binHeader, binary]);
}
