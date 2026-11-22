import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { steamAssetLimits, selectedMaps } from './steam-assets-plan.mjs';
import { checkFreeReserve, fileHash, readableDirectory, regular } from './asset-storage.mjs';

import { verifyPreparedGlb } from './prepared-glb.mjs';
import { mapGradeBytes, mapGradeFile, validMapGrade } from '../../shared/map-grade.mjs';
import { validPreparedFog } from './prepared-environment-fog.mjs';
import { validateTexturePlan } from './texture-plan-validation.mjs';

const environmentFaces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const exactKeys = (object, keys) =>
  object &&
  typeof object === 'object' &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...keys].sort().join(',');

async function validateEnvironment(prepared, map, assetVersion) {
  const pack = join(prepared, 'environments', map);
  const metadata = join(pack, 'environment.json');
  await regular(metadata, 16384);
  const data = JSON.parse(await readFile(metadata, 'utf8'));
  const hasFog = data && typeof data === 'object' && Object.hasOwn(data, 'fog');
  const hasGrade = data && typeof data === 'object' && Object.hasOwn(data, 'grade');
  if (
    !exactKeys(data, [
      'schemaVersion',
      'map',
      'assetVersion',
      'source',
      'landscape',
      'sky',
      ...(hasFog ? ['fog'] : []),
      ...(hasGrade ? ['grade'] : []),
    ]) ||
    (hasFog && !validPreparedFog(data.fog)) ||
    data.schemaVersion !== (hasGrade ? 2 : 1) ||
    (hasGrade && !validMapGrade(data.grade)) ||
    data.map !== map ||
    data.assetVersion !== assetVersion ||
    typeof data.source !== 'string' ||
    !data.source.trim() ||
    data.source.length > 500 ||
    typeof data.landscape !== 'boolean' ||
    !exactKeys(data.sky, ['faces', 'brightness']) ||
    !Number.isFinite(data.sky.brightness) ||
    data.sky.brightness < 0 ||
    data.sky.brightness > 16 ||
    !exactKeys(data.sky.faces, environmentFaces) ||
    environmentFaces.some(
      (face) =>
        typeof data.sky.faces[face] !== 'string' || !/^[a-f0-9]{64}$/.test(data.sky.faces[face]),
    )
  )
    throw new Error(
      'Prepared environment does not match this installation or its bounded fixed-face contract.',
    );
  const files = [];
  let total = 0,
    dimension;
  for (const face of environmentFaces) {
    const path = join(pack, `${face}.png`);
    const info = await regular(path, 8 * 1024 ** 2, 57);
    total += info.size;
    if (total > 32 * 1024 ** 2) throw new Error('Prepared sky exceeds its aggregate image limit.');
    const bytes = await readFile(path);
    const decoder = sharp(bytes, { limitInputPixels: 1024 ** 2, failOn: 'error' });
    const image = await decoder.metadata();
    if (
      image.format !== 'png' ||
      !image.width ||
      image.width !== image.height ||
      image.width > 1024 ||
      (image.pages ?? 1) !== 1 ||
      (dimension !== undefined && image.width !== dimension) ||
      createHash('sha256').update(bytes).digest('hex') !== data.sky.faces[face]
    )
      throw new Error('Prepared sky faces must have matching square PNG dimensions and hashes.');
    await decoder.raw().toBuffer();
    dimension = image.width;
    files.push({
      path: `environments/${map}/${face}.png`,
      bytes: info.size,
      sha256: data.sky.faces[face],
    });
  }
  for (const filename of ['environment.json', 'provenance.json']) {
    const path = join(pack, filename);
    const maximum = filename === 'environment.json' ? 16384 : 1024 * 1024;
    files.push({
      path: `environments/${map}/${filename}`,
      bytes: (await regular(path, maximum)).size,
      sha256: await fileHash(path, 'sha256', maximum),
    });
  }
  if (hasGrade) {
    const path = join(pack, mapGradeFile);
    const bytes = mapGradeBytes(data.grade.lut.size);
    await regular(path, bytes, bytes);
    const sha256 = await fileHash(path, 'sha256', bytes);
    if (sha256 !== data.grade.lut.sha256) throw Error('Prepared grading LUT hash mismatch.');
    files.push({ path: `environments/${map}/${mapGradeFile}`, bytes, sha256 });
  }
  return files;
}

export async function validatePreparedMap(prepared, map, assetVersion) {
  selectedMaps([map]);
  if (typeof assetVersion !== 'string' || !assetVersion.trim() || assetVersion.length > 100)
    throw new Error('Prepared map requires a bounded asset version.');
  const files = [];
  for (const tier of ['desktop', 'mobile']) {
    const path = join(prepared, map, tier, 'scene.glb');
    const model = await verifyPreparedGlb(path);
    files.push({ path: `${map}/${tier}/scene.glb`, ...model });
    const manifest = join(prepared, map, tier, 'manifest.json');
    await regular(manifest, 16384);
    const data = JSON.parse(await readFile(manifest, 'utf8'));
    if (
      data.schemaVersion !== 1 ||
      data.map !== map ||
      data.tier !== tier ||
      data.assetVersion !== assetVersion
    )
      throw new Error('Prepared map provenance does not match this installation.');
    if (
      (data.bytes !== undefined && data.bytes !== model.bytes) ||
      (data.outputSha256 !== undefined && data.outputSha256 !== model.sha256)
    )
      throw new Error('Prepared model differs from its output manifest binding.');
    files.push({
      path: `${map}/${tier}/manifest.json`,
      bytes: (await lstat(manifest)).size,
      sha256: await fileHash(manifest, 'sha256', 16384),
    });
    const texturePlan = join(prepared, map, tier, 'texture-plan.json');
    if (data.textureBudget !== undefined) {
      const info = await regular(texturePlan, 4 * 1024 ** 2);
      const bytes = await readFile(texturePlan);
      validateTexturePlan(data, bytes, tier);
      files.push({
        path: `${map}/${tier}/texture-plan.json`,
        bytes: info.size,
        sha256: data.textureBudget.planSha256,
      });
    } else if (
      await lstat(texturePlan).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      })
    )
      throw new Error('Prepared texture plan has no manifest binding.');
  }
  const compact = join(prepared, map, 'compact');
  const compactDirectory = await lstat(compact).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (compactDirectory) {
    if (!compactDirectory.isDirectory() || compactDirectory.isSymbolicLink())
      throw new Error('Invalid compact tier directory.');
    const model = await verifyPreparedGlb(join(compact, 'scene.glb'), { compact: true });
    const manifest = join(compact, 'manifest.json');
    const info = await regular(manifest, 16384);
    const data = JSON.parse(await readFile(manifest, 'utf8'));
    const mobile = files.find((file) => file.path === `${map}/mobile/scene.glb`);
    if (
      data.schemaVersion !== 1 ||
      data.map !== map ||
      data.tier !== 'compact' ||
      data.assetVersion !== assetVersion ||
      data.sourceFile !== 'scene.glb' ||
      data.sourceSha256 !== mobile.sha256 ||
      data.sourceBytes !== mobile.bytes ||
      data.outputSha256 !== model.sha256 ||
      data.bytes !== model.bytes ||
      data.bytes >= mobile.bytes ||
      data.triangles !== model.triangles ||
      data.primitives !== model.primitives ||
      !Number.isSafeInteger(data.sourceTriangles) ||
      data.sourceTriangles < data.triangles
    )
      throw new Error('Compact map must match its hashed mobile source and output manifest.');
    files.push(
      { path: `${map}/compact/scene.glb`, bytes: model.bytes, sha256: model.sha256 },
      {
        path: `${map}/compact/manifest.json`,
        bytes: info.size,
        sha256: await fileHash(manifest, 'sha256', 16384),
      },
    );
  }
  const overview = join(prepared, 'overviews', map),
    metadata = join(overview, 'overview.json'),
    image = join(overview, 'overview.png');
  await regular(metadata, 16384);
  const data = JSON.parse(await readFile(metadata, 'utf8'));
  if (
    data.schemaVersion !== 1 ||
    data.map !== map ||
    data.assetVersion !== assetVersion ||
    data.referenceSize !== 1024 ||
    !Number.isFinite(data.scale) ||
    data.scale < 0.001 ||
    data.scale > 10000 ||
    ![data.origin?.x, data.origin?.y].every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 1e7,
    )
  )
    throw new Error('Prepared overview calibration does not match this installation.');
  await regular(image, 8 * 1024 ** 2);
  const png = await readFile(image),
    dimensions = await sharp(png, { limitInputPixels: 2048 ** 2, failOn: 'error' }).metadata();
  if (
    dimensions.format !== 'png' ||
    !dimensions.width ||
    dimensions.width !== dimensions.height ||
    dimensions.width > 2048 ||
    createHash('sha256').update(png).digest('hex') !== data.imageSha256
  )
    throw new Error('Prepared overview is invalid or its image hash changed.');
  for (const name of ['overview.json', 'overview.png', 'provenance.json']) {
    const path = join(overview, name),
      size = (await regular(path, name === 'overview.png' ? 8 * 1024 ** 2 : 16384)).size;
    files.push({
      path: `overviews/${map}/${name}`,
      bytes: size,
      sha256: await fileHash(path, 'sha256', size),
    });
  }
  files.push(...(await validateEnvironment(prepared, map, assetVersion)));
  if (files.reduce((sum, file) => sum + file.bytes, 0) > steamAssetLimits.outputBytes)
    throw new Error('Prepared map pair exceeds the output limit.');
  return files;
}
/** Copy only checked runtime artifacts. Source exports never enter the web asset directory. */
export async function publishPreparedMap(prepared, output, map, assetVersion, provenance) {
  const files = await validatePreparedMap(prepared, map, assetVersion),
    claimed = [];
  await readableDirectory(output);
  await readableDirectory(join(output, 'overviews'));
  await readableDirectory(join(output, 'environments'));
  const stage = await mkdtemp(join(output, '.cswatch-map-'));
  try {
    for (const file of files) {
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true });
      await checkFreeReserve(stage, output, file.bytes);
      await copyFile(join(prepared, file.path), target);
      if ((await fileHash(target, 'sha256', file.bytes)) !== file.sha256)
        throw new Error('Prepared map changed before publication.');
      await chmod(target, 0o644);
    }
    await writeFile(
      join(stage, map, 'installation.json'),
      JSON.stringify({ ...provenance, files }, null, 2) + '\n',
      { mode: 0o644, flag: 'wx' },
    );
    for (const target of [
      join(output, map),
      join(output, 'overviews', map),
      join(output, 'environments', map),
    ]) {
      await mkdir(target, { mode: 0o700 });
      claimed.push(target);
    }
    for (const [from, target] of [
      [join(stage, map), claimed[0]],
      [join(stage, 'overviews', map), claimed[1]],
      [join(stage, 'environments', map), claimed[2]],
    ])
      for (const name of await readdir(from)) await rename(join(from, name), join(target, name));
    for (const target of claimed) await chmod(target, 0o755);
    for (const tier of ['desktop', 'mobile']) await chmod(join(output, map, tier), 0o755);
    return { map, assetVersion, files };
  } catch (error) {
    for (const target of claimed) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
