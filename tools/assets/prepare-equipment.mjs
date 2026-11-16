import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const registry = JSON.parse(
  await readFile(new URL('../../shared/equipment-icons.json', import.meta.url), 'utf8'),
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MAX_SVG_BYTES = 256 * 1024;

/** Accept only self-contained drawing primitives; the public app never serves SVG. */
export function equipmentSvg(bytes) {
  if (!bytes.length || bytes.length > MAX_SVG_BYTES) throw new Error('SVG must be 1–256 KiB.');
  let svg = bytes.toString('utf8');
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(svg)) throw new Error('SVG entities are not allowed.');
  svg = svg
    .replace(/<\?xml\s[^?]*\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  if (
    /<\?|<!|\b(?:href|src|on[a-z]+|style)\s*=|url\s*\(/i.test(svg) ||
    !/^\s*<svg\b/i.test(svg) ||
    !/<\/svg>\s*$/i.test(svg)
  )
    throw new Error('SVG must contain only local drawing primitives.');
  for (const tag of svg.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b/g))
    if (
      !['svg', 'g', 'path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line'].includes(
        tag[1],
      )
    )
      throw new Error(`Unsupported SVG element: ${tag[1]}.`);
  return Buffer.from(svg);
}

export async function prepareEquipment({ input, output, version, source }) {
  const inputRoot = await realpath(resolve(input));
  if (!(await lstat(inputRoot)).isDirectory()) throw new Error('Input must be an SVG directory.');
  const target = resolve(output);
  if (existsSync(target)) throw new Error('Output already exists. Prepare a new directory first.');
  if (!version || version.length > 120)
    throw new Error('Provide an asset version of 1–120 characters.');
  if (!source || source.length > 500)
    throw new Error('Provide a source description of 1–500 characters.');
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), '.equipment-'));
  const items = {};
  try {
    for (const [key, filename] of Object.entries(registry.items)) {
      const path = join(inputRoot, filename);
      if (!existsSync(path)) continue;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SVG_BYTES)
        throw new Error(`Invalid SVG file: ${filename}.`);
      const original = await readFile(path);
      const svg = equipmentSvg(original);
      const image = await sharp(svg, { density: 144, limitInputPixels: 1024 * 1024 })
        .resize(512, 128, { fit: 'inside' })
        .trim({ background: '#00000000', threshold: 0 })
        .resize(256, 64, { fit: 'inside' })
        .png()
        .toBuffer();
      if (image.length > 1024 * 1024) throw new Error(`PNG is too large: ${filename}.`);
      const metadata = await sharp(image).metadata();
      if (!metadata.width || !metadata.height || !metadata.hasAlpha)
        throw new Error(`SVG has no usable alpha image: ${filename}.`);
      const alpha = await sharp(image).extractChannel('alpha').stats();
      if (alpha.channels[0].max === 0) throw new Error(`SVG has no visible geometry: ${filename}.`);
      await writeFile(join(staging, key + '.png'), image, { flag: 'wx', mode: 0o644 });
      items[key] = {
        sourceFile: filename,
        sourceSha256: sha256(original),
        pngSha256: sha256(image),
        width: metadata.width,
        height: metadata.height,
        bytes: image.length,
      };
    }
    if (!Object.keys(items).length) throw new Error('No supported equipment SVGs were found.');
    await writeFile(
      join(staging, 'provenance.json'),
      JSON.stringify(
        {
          schema: 1,
          assetVersion: version,
          source,
          preparedAt: new Date().toISOString(),
          transformation:
            'Self-contained SVG primitives rasterized and alpha-trimmed to PNG, max256×64.',
          rights: 'Operator-supplied artwork. This tool does not grant redistribution rights.',
          items,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o644 },
    );
    // Keep incomplete work private. Publish this operator artwork pack with
    // predictable read permissions even under a restrictive host umask.
    for (const filename of [...Object.keys(items).map((key) => key + '.png'), 'provenance.json'])
      await chmod(join(staging, filename), 0o644);
    await chmod(staging, 0o755);
    await rename(staging, target);
    return { count: Object.keys(items).length, output: target };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]?.replace(/^--/, '');
      if (!['input', 'output', 'version', 'source'].includes(key) || !args[index + 1])
        throw new Error(
          'Usage: prepare-equipment --input SVG_DIR --output NEW_DIR --version CS2_BUILD --source SOURCE',
        );
      options[key] = args[index + 1];
    }
    if (!options.input || !options.output)
      throw new Error('Both --input and --output are required.');
    console.log(JSON.stringify(await prepareEquipment(options)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Equipment preparation failed.');
    process.exitCode = 1;
  }
}
