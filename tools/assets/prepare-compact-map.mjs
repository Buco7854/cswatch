#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Document, NodeIO, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  joinPrimitives,
  prune,
  quantize,
  reorder,
  simplify,
  transformPrimitive,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { compressGlbGeometry, MeshoptDecoder } from './meshopt-glb.mjs';
import { MapBakedLightingExtension } from './map-baked-lighting-extension.mjs';
import { writeTierMetadata } from './map-tier-output.mjs';
import { writePreparedModel } from './prepared-model-output.mjs';
import limits from '../../shared/compact-map.json' with { type: 'json' };

const cellSize = 32;
const maxSourceVertices = 4_000_000;
const maxSourceIndices = 12_000_000;
const maxSourceBytes = 512 * 1024 ** 2;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

async function colorOf(material, samples) {
  const factor = material?.getBaseColorFactor() ?? [1, 1, 1, 1];
  const texture = material?.getBaseColorTexture();
  const bytes = texture?.getImage();
  if (
    !bytes ||
    !['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(texture.getMimeType())
  )
    return factor;
  if (!samples.has(texture)) {
    const { data } = await sharp(bytes, { limitInputPixels: 16 * 1024 ** 2 })
      .toColourspace('srgb')
      .ensureAlpha()
      .resize(16, 16, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sum = [0, 0, 0];
    let alpha = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const weight = data[offset + 3] / 255;
      for (let axis = 0; axis < 3; axis++) sum[axis] += linear(data[offset + axis] / 255) * weight;
      alpha += weight;
    }
    samples.set(texture, alpha ? sum.map((value) => value / alpha) : [1, 1, 1]);
  }
  return samples.get(texture).map((value, axis) => value * factor[axis]);
}

function supportedNode(node, animated) {
  for (let current = node; current; current = current.getParentNode()) {
    const metadata = current.getExtras()?.cswatch;
    if (
      animated.has(current) ||
      current.getSkin() ||
      current.getExtension('EXT_mesh_gpu_instancing') ||
      (metadata?.kind === 'skybox' && metadata.schemaVersion === 1)
    )
      return false;
  }
  return true;
}

/** Derive a texture-free, spatially batched world from a prepared Source map. */
export async function buildCompactMap(source) {
  const original = source.getRoot(),
    scene = original.getDefaultScene() ?? original.listScenes()[0];
  if (!scene) return;
  const animated = new Set(
    original
      .listAnimations()
      .flatMap((animation) => animation.listChannels().map((channel) => channel.getTargetNode())),
  );
  const nodes = [];
  scene.traverse((node) => {
    if (node.getMesh() && supportedNode(node, animated)) nodes.push(node);
  });
  const document = new Document(),
    buffer = document.createBuffer(),
    world = document.createScene('Compact world'),
    opaque = document.createMaterial('Opaque surfaces').setRoughnessFactor(1).setMetallicFactor(0),
    sided = document
      .createMaterial('Two-sided surfaces')
      .setRoughnessFactor(1)
      .setMetallicFactor(0)
      .setDoubleSided(true);
  document.getRoot().setDefaultScene(world);
  const samples = new Map(),
    colors = new Map(),
    cells = new Map();
  let vertices = 0,
    indices = 0;
  for (const node of nodes) {
    const matrix = node.getWorldMatrix();
    if (!matrix.every(Number.isFinite)) continue;
    for (const source of node.getMesh().listPrimitives()) {
      const material = source.getMaterial();
      const position = source.getAttribute('POSITION');
      if (
        source.getMode() !== Primitive.Mode.TRIANGLES ||
        !position ||
        position.getType() !== 'VEC3' ||
        source.listTargets().length ||
        (material && material.getAlphaMode() !== 'OPAQUE')
      )
        continue;
      const count = position.getCount();
      const index = source.getIndices()?.getArray();
      const indexCount = index?.length ?? count;
      if (!indexCount || indexCount % 3) continue;
      vertices += count;
      indices += indexCount;
      if (vertices > maxSourceVertices || indices > maxSourceIndices) return;
      if (!colors.has(material)) colors.set(material, await colorOf(material, samples));
      const color = colors.get(material);
      const encodedColor = new Uint8Array(count * 3);
      const c = color.slice(0, 3).map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
      for (let vertex = 0; vertex < count; vertex++) encodedColor.set(c, vertex * 3);
      const positions = document
        .createAccessor()
        .setBuffer(buffer)
        .setType('VEC3')
        .setArray(position.getArray().slice())
        .setNormalized(position.getNormalized());
      const indexArray = index
        ? Uint32Array.from(index)
        : Uint32Array.from({ length: count }, (_, i) => i);
      if (indexArray.some((entry) => entry >= count))
        throw new Error('Invalid compact source index.');
      const twoSided = material?.getDoubleSided();
      const primitive = document
        .createPrimitive()
        .setMaterial(twoSided ? sided : opaque)
        .setAttribute('POSITION', positions)
        .setAttribute(
          'COLOR_0',
          document
            .createAccessor()
            .setBuffer(buffer)
            .setType('VEC3')
            .setArray(encodedColor)
            .setNormalized(true),
        )
        .setIndices(
          document.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(indexArray),
        );
      transformPrimitive(primitive, matrix);
      const min = positions.getMin([]),
        max = positions.getMax([]);
      if (![...min, ...max].every((value) => Number.isFinite(value) && Math.abs(value) <= 100_000))
        throw new Error('Invalid compact source bounds.');
      const key = [
        Boolean(twoSided),
        ...min.map((value, axis) => Math.floor((value + max[axis]) / 2 / cellSize)),
      ].join(':');
      const batch = cells.get(key) ?? [];
      batch.push(primitive);
      cells.set(key, batch);
    }
  }
  if (!cells.size || cells.size > limits.primitives) return;
  for (const [key, batch] of cells) {
    const primitive = batch.length === 1 ? batch[0] : joinPrimitives(batch);
    if (batch.length > 1) for (const source of batch) source.dispose();
    world.addChild(document.createNode(key).setMesh(document.createMesh().addPrimitive(primitive)));
  }
  await document.transform(
    prune({ keepAttributes: true }),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.22, error: 0.004, lockBorder: true }),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(POSITION|COLOR_0)$/, quantizePosition: 14, quantizeColor: 8 }),
    prune({ keepAttributes: true }),
  );
  const primitives = document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives());
  const triangles = primitives.reduce(
    (sum, primitive) => sum + primitive.getIndices().getCount() / 3,
    0,
  );
  if (!triangles || triangles > limits.triangles) return;
  return { document, triangles, primitives: primitives.length, sourceTriangles: indices / 3 };
}

export async function prepareCompactMap({ input, output, map }) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(map)) throw new Error('Invalid compact map name.');
  input = resolve(input);
  output = resolve(output);
  await localDirectory(dirname(input));
  await localDirectory(dirname(output), true);
  const { handle } = await regularFile(join(dirname(input), 'manifest.json'), 16384);
  let source;
  try {
    source = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (
    source.schemaVersion !== 1 ||
    source.map !== map ||
    source.tier !== 'mobile' ||
    typeof source.assetVersion !== 'string' ||
    !source.assetVersion.trim() ||
    source.assetVersion.length > 100 ||
    !/^[a-f0-9]{64}$/.test(source.outputSha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes < 48
  )
    throw new Error('Compact map requires a matching prepared mobile tier manifest.');
  if (source.bytes > maxSourceBytes) return;
  const verified = await verifyPreparedGlb(input);
  if (source.bytes !== verified.bytes || source.outputSha256 !== verified.sha256)
    throw new Error('Compact source does not match its prepared manifest.');
  const bytes = await readFile(input);
  if (bytes.length !== verified.bytes || sha256(bytes) !== verified.sha256)
    throw new Error('Compact source changed before decoding.');
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, MapBakedLightingExtension])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .setAllowNetwork(false);
  const compact = await buildCompactMap(await io.readBinary(bytes));
  if (!compact) return;
  const encoded = (await compressGlbGeometry(await io.writeBinary(compact.document))).bytes;
  if (encoded.length > limits.bytes || encoded.length >= verified.bytes) return;
  const manifest = {
    schemaVersion: 1,
    tier: 'compact',
    map,
    assetVersion: source.assetVersion,
    sourceFile: basename(input),
    sourceBytes: verified.bytes,
    sourceSha256: verified.sha256,
    bytes: encoded.length,
    outputSha256: sha256(encoded),
    sourceTriangles: compact.sourceTriangles,
    triangles: compact.triangles,
    primitives: compact.primitives,
  };
  await mkdir(output, { mode: 0o755 });
  try {
    await writePreparedModel(join(output, 'scene.glb'), encoded);
    await writeTierMetadata(
      join(output, 'manifest.json'),
      Buffer.from(JSON.stringify(manifest, null, 2)),
    );
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { input: { type: 'string' }, output: { type: 'string' }, map: { type: 'string' } },
  });
  if (!values.input || !values.output || !values.map)
    throw new Error(
      'Usage: node prepare-compact-map.mjs --input MAP/mobile/scene.glb --output NEW/compact --map de_mirage',
    );
  const result = await prepareCompactMap(values);
  if (!result)
    throw new Error('The map cannot produce a smaller compact tier within the geometry budget.');
  console.log(JSON.stringify(result));
}
