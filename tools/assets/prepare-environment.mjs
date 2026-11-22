/** Trusted offline environment conversion. No Steam, HTTP or application-server access. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments, unpartition } from '@gltf-transform/functions';
import sharp from 'sharp';
import {
  inspectMapEnvironment,
  inspectMapGrade,
  inspectSkyCamera,
  inspectSkyMaterial,
  prepareCubemapFog,
} from './environment-metadata.mjs';
import {
  createSourceCubemapSampler,
  linearToSrgb,
  skyWorldMatrix,
  sourceFaces,
  srgbToLinear,
  viewerCubeDirection,
  viewerFaces,
} from './environment-space.mjs';
import { fileHash, localDirectory, regularFile } from './toolchain-security.mjs';
import { writePreparedModel } from './prepared-model-output.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { writeMapGrade } from './prepare-map-grade.mjs';
import { applyTextureBudget } from './texture-budget.mjs';

export {
  inspectMapEnvironment,
  inspectSkyCamera,
  inspectSkyMaterial,
  prepareCubemapFog,
} from './environment-metadata.mjs';
const MiB = 1024 ** 2;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceVersion = '942df5b37ebbde6153f6c488880b91d4bed003e6';

async function boundedRead(path, maximum) {
  await localDirectory(dirname(resolve(path)));
  const { handle } = await regularFile(path, maximum);
  try {
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw new Error('Environment input grew beyond its byte bound.');
    return bytes;
  } finally {
    await handle.close();
  }
}

/** NodeIO never resolves remote URIs, traversal or symbolic links from a local export. */
async function inspectGltf(path) {
  path = resolve(path);
  await localDirectory(dirname(path));
  const { handle, stat } = await regularFile(path, steamAssetLimits.modelBytes);
  let document;
  try {
    if (extname(path).toLowerCase() === '.gltf') {
      if (stat.size > 64 * MiB) throw new Error('S2V glTF JSON exceeds its metadata bound.');
      document = JSON.parse(await handle.readFile('utf8'));
    } else if (extname(path).toLowerCase() === '.glb') {
      const header = Buffer.alloc(20);
      const { bytesRead } = await handle.read(header, 0, 20, 0);
      const length = header.readUInt32LE(12);
      if (
        bytesRead !== 20 ||
        header.toString('ascii', 0, 4) !== 'glTF' ||
        header.readUInt32LE(4) !== 2 ||
        header.readUInt32LE(8) !== stat.size ||
        header.readUInt32LE(16) !== 0x4e4f534a ||
        length > 64 * MiB ||
        length > stat.size - 20
      )
        throw new Error('Expected a bounded version 2 GLB with a JSON first chunk.');
      const json = Buffer.alloc(length);
      if ((await handle.read(json, 0, length, 20)).bytesRead !== length)
        throw new Error('Incomplete GLB metadata.');
      document = JSON.parse(json.toString('utf8'));
    } else throw new Error('Environment geometry must be an S2V glTF or GLB.');
  } finally {
    await handle.close();
  }
  if (!document || typeof document !== 'object' || document.asset?.version !== '2.0')
    throw new Error('Environment geometry requires glTF version 2.0.');
  const resources = new Set([path]);
  for (const collection of [document.buffers ?? [], document.images ?? []]) {
    if (!Array.isArray(collection) || collection.length > 20000)
      throw new Error('Too many glTF resources.');
    for (const entry of collection) {
      if (entry?.uri === undefined) continue;
      if (typeof entry.uri !== 'string' || entry.uri.length > 64 * MiB)
        throw new Error('Invalid glTF resource URI.');
      if (
        /^data:(?:application\/octet-stream|application\/gltf-buffer|image\/(?:png|jpeg|webp));base64,[A-Za-z0-9+/=]*$/.test(
          entry.uri,
        )
      )
        continue;
      let uri;
      try {
        uri = decodeURIComponent(entry.uri);
      } catch {
        throw new Error('Invalid encoded glTF resource path.');
      }
      if (
        !uri ||
        uri.length > 1024 ||
        /[\x00-\x1f\x7f\\:?#%]/.test(uri) ||
        uri.startsWith('/') ||
        uri.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('glTF resources must be exact local paths inside the export directory.');
      resources.add(join(dirname(path), uri));
    }
  }
  const provenance = [];
  let bytes = 0;
  for (const resource of resources) {
    await localDirectory(dirname(resource));
    const verified = await fileHash(resource, steamAssetLimits.modelBytes);
    bytes += verified.bytes;
    if (bytes > steamAssetLimits.outputBytes)
      throw new Error('Environment source geometry exceeds its aggregate byte bound.');
    provenance.push({
      file: resource.slice(dirname(path).length + 1),
      sha256: verified.sha256,
      bytes: verified.bytes,
    });
  }
  return { path, bytes, resources: provenance };
}

function pixel(face, u, v, channel) {
  const x = Math.max(0, Math.min(face.width - 1, u * face.width - 0.5));
  const y = Math.max(0, Math.min(face.width - 1, v * face.width - 0.5));
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    x1 = Math.min(face.width - 1, x0 + 1),
    y1 = Math.min(face.width - 1, y0 + 1),
    tx = x - x0,
    ty = y - y0;
  const at = (px, py) => face.data[(py * face.width + px) * 4 + channel];
  return (
    ((at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) +
      (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty) /
    255
  );
}

/** ForceLDR emits clamped linear bytes; output PNGs are explicitly sRGB. */
export async function convertSkyFaces(paths, environment, referenceAngles = [0, 0, 0]) {
  if (
    !paths ||
    Object.keys(paths).length !== 6 ||
    sourceFaces.some((face) => typeof paths[face] !== 'string')
  )
    throw new Error('Provide exactly six decoded S2V cubemap face paths.');
  const decoded = Object.create(null),
    inputs = Object.create(null);
  let sourceSize,
    total = 0;
  for (const face of sourceFaces) {
    const input = await boundedRead(paths[face], 8 * MiB);
    total += input.length;
    if (total > 32 * MiB)
      throw new Error('Source cubemap faces exceed their aggregate byte bound.');
    if (!input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('S2V cubemap faces must be PNG images.');
    const { data, info } = await sharp(input, { limitInputPixels: 2048 ** 2 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      info.width !== info.height ||
      info.width < 1 ||
      info.width > 2048 ||
      (sourceSize !== undefined && sourceSize !== info.width)
    )
      throw new Error(
        'Source cubemap faces must be equal square images no larger than 2048 pixels.',
      );
    sourceSize = info.width;
    decoded[face] = { data, width: info.width };
    inputs[face] = { sha256: hash(input), bytes: input.length };
  }
  if (
    !environment ||
    !Array.isArray(environment.tint) ||
    environment.tint.length !== 3 ||
    environment.tint.some((value) => !Number.isFinite(value) || value < 0 || value > 255)
  )
    throw new Error('Invalid authored sky tint.');
  const tint = environment.tint.map((value) => srgbToLinear(value / 255));
  const sample = createSourceCubemapSampler(environment.angles, referenceAngles);
  const size = Math.min(sourceSize, 1024),
    outputs = Object.create(null);
  let outputBytes = 0;
  for (const face of viewerFaces) {
    const data = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const lookup = sample(viewerCubeDirection(face, (x + 0.5) / size, (y + 0.5) / size));
        for (let channel = 0; channel < 3; channel++)
          data[(y * size + x) * 3 + channel] = Math.round(
            linearToSrgb(pixel(decoded[lookup.face], lookup.u, lookup.v, channel) * tint[channel]) *
              255,
          );
      }
    outputs[face] = await sharp(data, { raw: { width: size, height: size, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    outputBytes += outputs[face].length;
    if (outputs[face].length > 8 * MiB || outputBytes > 32 * MiB)
      throw new Error('Converted sky exceeds the bounded PNG delivery contract.');
  }
  return { size, outputs, inputs, bytes: outputBytes };
}

async function writeBounded(path, bytes) {
  const disk = await statfs(dirname(path), { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(bytes.length + steamAssetLimits.reserveBytes))
    throw new Error('Insufficient free disk space for environment output and 512 MiB reserve.');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o644 });
}

export async function prepareEnvironment(config) {
  const {
    map,
    assetVersion,
    source,
    mainGltf,
    skyGltf,
    mainEntities,
    skyEntities,
    materialData,
    skyFaces,
    gradeInput,
    output,
    onProgress = () => {},
  } = config;
  if (
    !/^[a-z][a-z0-9_]{1,79}$/.test(map) ||
    typeof assetVersion !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(assetVersion) ||
    typeof source !== 'string' ||
    source.trim().length < 1 ||
    source.trim().length > 500 ||
    /[\x00-\x1f\x7f]/.test(source)
  )
    throw new Error(
      'Environment requires a valid map, asset version and bounded source description.',
    );
  const main = inspectMapEnvironment(mainEntities),
    camera = inspectSkyCamera(skyEntities),
    material = inspectSkyMaterial(materialData);
  if (!main.reference)
    throw new Error('Actual landscape preparation requires an authored skybox_reference.');
  const effective = camera.skyEnvironment ?? main;
  if (!effective.skyMaterial) throw new Error('The selected world has no authored sky material.');
  const matrix = skyWorldMatrix(main.reference, camera);
  const brightness =
    effective.brightnessScale * 2 ** (material.exposureBias + material.renderExposureBias);
  if (!Number.isFinite(brightness) || brightness < 0 || brightness > 16)
    throw new Error('Authored sky exposure exceeds the environment brightness contract.');
  const cubeFog = prepareCubemapFog({ main, camera, material, effective });
  const root = await localDirectory(output);
  const environments = await localDirectory(join(root, 'environments'), true);
  const destination = join(environments, map);
  // Reserve the final directory first; an existing environment is never overwritten.
  await mkdir(destination, { mode: 0o755 });
  let stage;
  try {
    stage = await mkdtemp(join(root, '.environment-'));
    const sourceMain = await inspectGltf(mainGltf),
      sourceSky = await inspectGltf(skyGltf);
    if (sourceMain.bytes + sourceSky.bytes > steamAssetLimits.outputBytes)
      throw new Error('Combined environment source exceeds the 4 GiB preparation bound.');
    const converted = await convertSkyFaces(
      skyFaces,
      effective,
      camera.skyEnvironment ? main.reference.angles : [0, 0, 0],
    );
    onProgress('read-main');
    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .setAllowNetwork(false);
    const mainDocument = await io.read(sourceMain.path);
    onProgress('read-sky');
    const skyDocument = await io.read(sourceSky.path);
    const mainScenes = mainDocument.getRoot().listScenes(),
      skyScenes = skyDocument.getRoot().listScenes();
    if (mainScenes.length !== 1 || skyScenes.length !== 1 || !skyScenes[0].listChildren().length)
      throw new Error('Landscape merge requires one nonempty scene in each local export.');
    if (
      mainDocument
        .getRoot()
        .listNodes()
        .some((node) => node.getExtras()?.cswatch?.kind === 'skybox')
    )
      throw new Error('Main geometry already contains a prepared sky landscape.');
    const mapping = mergeDocuments(mainDocument, skyDocument);
    const importedScene = mapping.get(skyScenes[0]);
    const landscape = mainDocument
      .createNode('cswatch_skybox')
      .setExtras({ cswatch: { kind: 'skybox', schemaVersion: 1 } })
      .setMatrix(matrix);
    for (const child of importedScene.listChildren()) landscape.addChild(child);
    mainScenes[0].addChild(landscape);
    importedScene.dispose();
    mainDocument.getRoot().setDefaultScene(mainScenes[0]);
    // Do not build a multi-gigabyte PNG GLB only to shrink it in the next stage.
    // The same final desktop residency policy bounds this intermediate, and
    // unchanged WebP images are reused by subsequent tier preparation.
    onProgress('budget-textures');
    const texturePreparation = await applyTextureBudget(mainDocument, { tier: 'desktop' });
    await mainDocument.transform(unpartition());
    mainDocument
      .getRoot()
      .listExtensionsUsed()
      .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
      ?.dispose();
    onProgress('encode-geometry');
    const encoded = await io.writeBinary(mainDocument);
    if (encoded.byteLength + converted.bytes > steamAssetLimits.outputBytes)
      throw new Error('Combined prepared environment exceeds its 4 GiB output bound.');
    const mergedInput = join(stage, 'merged.glb');
    await writePreparedModel(mergedInput, encoded);
    const faces = Object.fromEntries(
      viewerFaces.map((face) => [face, hash(converted.outputs[face])]),
    );
    const authoredGrade = gradeInput && inspectMapGrade(mainEntities);
    if (gradeInput && (!authoredGrade || !/^[a-f0-9]{64}$/.test(gradeInput.sha256)))
      throw Error('Prepared grading requires authored entity provenance.');
    const grade = authoredGrade
      ? await writeMapGrade(destination, authoredGrade, gradeInput.data)
      : undefined;
    const descriptor = {
      schemaVersion: 2,
      map,
      assetVersion,
      source: source.trim(),
      landscape: true,
      sky: { brightness, faces },
      ...(cubeFog.fog ? { fog: cubeFog.fog } : {}),
      ...(grade ? { grade } : {}),
    };
    const report = {
      schemaVersion: 1,
      map,
      assetVersion,
      mainEnvironment: main,
      skyCamera: camera,
      effectiveEnvironment: effective,
      material,
      cubeFog,
      ...(grade ? { postProcessing: { ...authoredGrade, sha256: gradeInput.sha256 } } : {}),
      skyWorldMatrix: matrix,
      landscape: true,
      brightness,
      faceSize: converted.size,
      sourceMain,
      sourceSky,
      sourceFaces: converted.inputs,
      intermediateTextureBudget: texturePreparation.manifest,
      output: { mergedBytes: encoded.byteLength, mergedSha256: hash(encoded), faces },
      conversion: {
        s2vCommit: sourceVersion,
        faceConvention: 'TextureExtract.SampleCubemapDirection; Three CubeTexture flipEnvMap=-1',
        color:
          'ForceLDR clamped linear input to sRGB PNG; authored linear tint; exposure in descriptor',
        skyPass: 'tagged geometry must render before main world with depth cleared',
      },
      limitations: [
        'HDR values above one were clipped by ForceLDR.',
        'Authored cubemap fog supports the scoped opaque black_unlit compatibility material only.',
        'Source global, gradient and volumetric fog and other material shading are not reconstructed.',
      ],
    };
    const provenance = Buffer.from(JSON.stringify(report, null, 2));
    if (provenance.length > MiB)
      throw new Error('Environment provenance exceeds its 1 MiB report bound.');
    for (const face of viewerFaces)
      await writeBounded(join(destination, `${face}.png`), converted.outputs[face]);
    await writeBounded(
      join(destination, 'environment.json'),
      Buffer.from(JSON.stringify(descriptor, null, 2)),
    );
    await writeBounded(join(destination, 'provenance.json'), provenance);
    onProgress('complete');
    return { mergedInput, environmentPath: destination, report };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (stage) await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
