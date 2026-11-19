#!/usr/bin/env node
/** Operator-provided decorative map artwork, never a demo or public image upload. */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import { readableDirectory } from './asset-storage.mjs';
import { selectedMaps } from './steam-assets-plan.mjs';
import { completePng } from './source-image-compactor.mjs';

const maximum = 8 * 1024 ** 2;
export const previewMaps = JSON.parse(
  readFileSync(new URL('../../shared/map-previews.json', import.meta.url), 'utf8'),
).maps;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Bounded decoding/normalization only. The automatic worker runs this in its confined Node child. */
export async function normalizeMapPreview(image) {
  const input = resolve(image);
  await localDirectory(dirname(input));
  const { handle, stat } = await regularFile(input, maximum);
  let bytes;
  try {
    if (stat.size < 57) throw Error('Map preview requires a bounded PNG.');
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('Incomplete map preview input.');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw Error('Map preview changed while reading.');
  } finally {
    await handle.close();
  }
  completePng(bytes);
  const decoder = sharp(bytes, { limitInputPixels: 16 * 1024 ** 2, failOn: 'warning' });
  const info = await decoder.metadata();
  if (info.format !== 'png' || (info.pages ?? 1) !== 1)
    throw Error('Map preview must be one PNG image.');
  const { data: prepared, info: preparedInfo } = await decoder
    .resize({ width: 1600, height: 900, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  if (prepared.length > maximum) throw Error('Prepared preview exceeds its image bound.');
  completePng(prepared);
  return {
    data: prepared,
    input,
    sourceSha256: hash(bytes),
    sourceWidth: info.width,
    sourceHeight: info.height,
    width: preparedInfo.width,
    height: preparedInfo.height,
  };
}
export async function prepareMapPreview({ image, map, output, version, source }) {
  if (selectedMaps([map]).length !== 1 || !image || !output)
    throw Error('Provide one map, local PNG and output directory.');
  if (!previewMaps.includes(map)) throw Error('This map is not a supported landing preview.');
  if (
    typeof version !== 'string' ||
    !version.trim() ||
    version.length > 100 ||
    typeof source !== 'string' ||
    !source.trim() ||
    source.length > 500
  )
    throw Error('Provide a bounded source description and asset version.');
  const normalized = await normalizeMapPreview(image);
  const { data: prepared, input } = normalized;
  const parent = resolve(output, 'previews'),
    target = join(parent, map);
  await readableDirectory(parent);
  await localDirectory(parent);
  const staging = await mkdtemp(join(parent, '.preview-'));
  let claimed,
    published = false;
  try {
    await writeFile(join(staging, 'preview.png'), prepared, { flag: 'wx', mode: 0o644 });
    await writeFile(
      join(staging, 'preview.json'),
      JSON.stringify({
        schemaVersion: 1,
        map,
        assetVersion: version.trim(),
        imageSha256: hash(prepared),
      }) + '\n',
      { flag: 'wx', mode: 0o644 },
    );
    await writeFile(
      join(staging, 'provenance.json'),
      JSON.stringify({
        schemaVersion: 1,
        map,
        assetVersion: version.trim(),
        source: source.trim(),
        sourceImage: basename(input),
        sourceSha256: normalized.sourceSha256,
        imageSha256: hash(prepared),
        width: normalized.width,
        height: normalized.height,
        sourceWidth: normalized.sourceWidth,
        sourceHeight: normalized.sourceHeight,
        preparedAt: new Date().toISOString(),
        transformation:
          'Decoded and normalized local PNG, maximum 1600 by 900. Decorative only, not replay calibration.',
        rights: 'Operator-provided game artwork. Not included in Git or application images.',
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await chmod(staging, 0o755);
    await mkdir(target, { mode: 0o755 });
    claimed = await lstat(target);
    await rename(staging, target);
    published = true;
    return { map, directory: target, bytes: prepared.length, sha256: hash(prepared) };
  } finally {
    if (!published && claimed) {
      const current = await lstat(target).catch(() => null);
      if (current?.ino === claimed.ino && current.dev === claimed.dev)
        await rm(target, { recursive: true, force: true });
    }
    await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        image: { type: 'string' },
        map: { type: 'string' },
        output: { type: 'string' },
        version: { type: 'string' },
        source: { type: 'string' },
      },
    });
    console.log(JSON.stringify(await prepareMapPreview(values)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
