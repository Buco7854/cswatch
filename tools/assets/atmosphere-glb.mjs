/** Minimal GLB metadata access and append-only image edits for trusted exports. */
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import { writePreparedModel } from './prepared-model-output.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';
import sharp from 'sharp';
export const atmosphericMaterialNames = Object.freeze([
  'materials/effects/smoke/dust_002_skybox.vmat',
  'materials/effects/smoke/dust_002.vmat',
  'materials/effects/clouds_001.vmat',
]);
export const isSupportedAtmosphericMaterial = (material) =>
  atmosphericMaterialNames.includes(material?.Name) && material.ShaderName === 'csgo_effects.vfx';

export async function readAtmosphereGlb(path, binary = false) {
  await localDirectory(dirname(resolve(path)));
  const { handle, stat } = await regularFile(path, steamAssetLimits.modelBytes);
  try {
    const header = Buffer.alloc(20);
    if (
      (await handle.read(header, 0, 20, 0)).bytesRead !== 20 ||
      header.toString('ascii', 0, 4) !== 'glTF' ||
      header.readUInt32LE(4) !== 2 ||
      header.readUInt32LE(8) !== stat.size ||
      header.readUInt32LE(16) !== 0x4e4f534a
    )
      throw new Error('Expected a bounded version 2 atmosphere GLB.');
    const length = header.readUInt32LE(12);
    if (length > 64 * 1024 ** 2 || length > stat.size - 28)
      throw new Error('Atmosphere GLB metadata exceeds its bound.');
    const json = Buffer.alloc(length);
    if ((await handle.read(json, 0, length, 20)).bytesRead !== length)
      throw new Error('Incomplete atmosphere GLB metadata.');
    const document = JSON.parse(json.toString('utf8'));
    if (
      document.asset?.version !== '2.0' ||
      !Array.isArray(document.materials) ||
      document.materials.length > 20000
    )
      throw new Error('Invalid atmosphere GLB material list.');
    const chunk = Buffer.alloc(8);
    if (
      (await handle.read(chunk, 0, 8, 20 + length)).bytesRead !== 8 ||
      chunk.readUInt32LE(4) !== 0x004e4942 ||
      28 + length + chunk.readUInt32LE(0) !== stat.size
    )
      throw new Error('Atmosphere GLB must contain one complete binary chunk.');
    if (!binary) return { document };
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error('Atmosphere GLB changed while reading.');
    return { document, bytes, binOffset: 28 + length, bin: bytes.subarray(28 + length) };
  } finally {
    await handle.close();
  }
}

/** Geometry, original images and every existing BIN byte remain byte-identical. */
export async function patchAtmosphericGlb({
  input,
  output,
  materialName,
  imagePath,
  imageBytes,
  textureScale,
}) {
  if (resolve(input) === resolve(output))
    throw new Error('Atmosphere patch requires a new output file.');
  if (!atmosphericMaterialNames.includes(materialName))
    throw new Error('Unsupported source atmosphere material.');
  if (
    !Array.isArray(textureScale) ||
    textureScale.length !== 2 ||
    textureScale.some((value) => !Number.isFinite(value) || value <= 0 || value > 1)
  )
    throw new Error('Invalid atmosphere texture scale.');
  const { document, bin } = await readAtmosphereGlb(input, true);
  if (
    !Array.isArray(document.buffers) ||
    document.buffers.length !== 1 ||
    document.buffers[0].uri !== undefined ||
    document.buffers[0].byteLength > bin.length
  )
    throw new Error('Atmosphere patch requires one embedded GLB buffer.');
  const matches = document.materials.filter(
    (material) => material.extras?.vmat?.Name === materialName,
  );
  if (
    !matches.length ||
    matches.some((material) => material.extras.vmat.ShaderName !== 'csgo_effects.vfx')
  )
    throw new Error('Exact supported source atmosphere material is absent.');
  let image;
  if ((imagePath === undefined) === (imageBytes === undefined))
    throw new Error('Provide one encoded atmosphere image.');
  if (imageBytes !== undefined) {
    if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength > 32 * 1024 ** 2)
      throw new Error('Atmosphere encoded image exceeds its bound.');
    image = Buffer.from(imageBytes);
  } else {
    await localDirectory(dirname(resolve(imagePath)));
    const { handle, stat } = await regularFile(imagePath, 32 * 1024 ** 2);
    try {
      image = await handle.readFile();
      if (image.length !== stat.size) throw new Error('Atmosphere image changed while reading.');
    } finally {
      await handle.close();
    }
  }
  const metadata = await sharp(image, { limitInputPixels: 4096 ** 2 }).metadata();
  if (
    !['png', 'webp'].includes(metadata.format) ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > 4096 ||
    metadata.height > 4096
  )
    throw new Error('Atmosphere patch requires bounded PNG or WebP.');
  await sharp(image, { limitInputPixels: 4096 ** 2 })
    .raw()
    .toBuffer();
  const offset = bin.length,
    padding = (4 - (image.length % 4)) % 4;
  const updatedBin = Buffer.concat([bin, image, Buffer.alloc(padding)]);
  document.bufferViews ??= [];
  document.images ??= [];
  document.textures ??= [];
  document.samplers ??= [];
  const view =
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: image.length }) - 1;
  const imageIndex =
    document.images.push({
      name: 'cswatch_static_atmosphere',
      mimeType: `image/${metadata.format}`,
      bufferView: view,
    }) - 1;
  const sampler =
    document.samplers.push({ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }) - 1;
  const texture =
    document.textures.push(
      metadata.format === 'webp'
        ? { sampler, extensions: { EXT_texture_webp: { source: imageIndex } } }
        : { source: imageIndex, sampler },
    ) - 1;
  for (const material of matches) {
    const previous = material.pbrMetallicRoughness?.baseColorTexture;
    if (
      !previous ||
      (previous.texCoord && previous.texCoord !== 0) ||
      previous.extensions?.KHR_texture_transform
    )
      throw new Error('Atmosphere patch requires untransformed UV0 color texture.');
    material.pbrMetallicRoughness.baseColorTexture = {
      ...previous,
      index: texture,
      extensions: { ...previous.extensions, KHR_texture_transform: { scale: textureScale } },
    };
    material.alphaMode = 'BLEND';
    material.extensions = { ...material.extensions, KHR_materials_unlit: {} };
    material.extras = {
      ...material.extras,
      cswatch: {
        ...material.extras?.cswatch,
        atmosphere: { schemaVersion: 1, phase: 0, static: true },
      },
    };
  }
  document.buffers[0].byteLength = updatedBin.length;
  document.extensionsUsed = [
    ...new Set([
      ...(document.extensionsUsed ?? []),
      'KHR_texture_transform',
      'KHR_materials_unlit',
    ]),
  ];
  document.extensionsRequired = [
    ...new Set([
      ...(document.extensionsRequired ?? []),
      'KHR_texture_transform',
      'KHR_materials_unlit',
    ]),
  ];
  if (metadata.format === 'webp') {
    document.extensionsUsed = [...new Set([...document.extensionsUsed, 'EXT_texture_webp'])];
    document.extensionsRequired = [
      ...new Set([...document.extensionsRequired, 'EXT_texture_webp']),
    ];
  }
  const json = Buffer.from(JSON.stringify(document)),
    jsonPadding = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 32)]),
    header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + jsonChunk.length + updatedBin.length, 8);
  header.writeUInt32LE(jsonChunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(updatedBin.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const encoded = Buffer.concat([header, jsonChunk, binHeader, updatedBin]);
  await localDirectory(dirname(resolve(output)));
  await writePreparedModel(output, encoded);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  return {
    path: resolve(output),
    report: {
      materialName,
      materials: matches.length,
      originalBinBytes: bin.length,
      originalBinSha256: sha(bin),
      retainedBinSha256: sha(updatedBin.subarray(0, bin.length)),
      imageSha256: sha(image),
      bytes: encoded.length,
      textureScale,
    },
  };
}
