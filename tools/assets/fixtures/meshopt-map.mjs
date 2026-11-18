/** Original grid geometry and checker pixels, never Counter-Strike content. */
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
export async function meshoptMapFixture() {
  const document = new Document(),
    buffer = document.createBuffer(),
    side = 33,
    positions = [],
    normals = [],
    uvs = [],
    colors = [],
    indices = [];
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      positions.push(
        Math.fround((x - 16) * 1.125),
        Math.fround(Math.sin(x * 0.125) * 0.125),
        Math.fround((y - 16) * 1.125),
      );
      normals.push(0, 1, 0);
      uvs.push(x / 32, y / 32);
      colors.push((x * 17) % 256, (y * 19) % 256, 160, (x + y) % 2 ? 128 : 255);
      if (x < side - 1 && y < side - 1) {
        const a = y * side + x,
          b = a + 1,
          c = a + side,
          d = c + 1;
        indices.push(b, c, a, c, b, d);
      }
    }
  const accessor = (name, type, array, normalized = false) =>
    document
      .createAccessor(name)
      .setBuffer(buffer)
      .setType(type)
      .setArray(array)
      .setNormalized(normalized);
  const pixels = Buffer.alloc(8 * 8 * 4);
  for (let p = 0; p < 64; p++) pixels.set([p % 2 ? 100 : 140, 150, 80, 180 + (p % 75)], p * 4);
  const texture = document
    .createTexture('Original checker')
    .setMimeType('image/png')
    .setImage(
      await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } })
        .png()
        .toBuffer(),
    );
  const material = document
    .createMaterial('Original QA surface')
    .setBaseColorTexture(texture)
    .setAlphaMode('BLEND');
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', accessor('position', 'VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', accessor('normal', 'VEC3', new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', accessor('uv', 'VEC2', new Float32Array(uvs)))
    .setAttribute('COLOR_0', accessor('color', 'VEC4', new Uint8Array(colors), true))
    .setIndices(accessor('indices', 'SCALAR', new Uint32Array(indices)))
    .setMaterial(material);
  const mesh = document.createMesh('Original grid').addPrimitive(primitive),
    sky = document
      .createNode('cswatch_skybox')
      .setExtras({ cswatch: { kind: 'skybox', schemaVersion: 1 } })
      .setTranslation([1, -3, 2])
      .setScale([0.25, 0.25, 0.25]);
  sky.addChild(document.createNode('Original landscape grid').setMesh(mesh));
  document
    .createScene()
    .addChild(document.createNode('Original main grid').setMesh(mesh))
    .addChild(sky);
  return new NodeIO().writeBinary(document);
}
