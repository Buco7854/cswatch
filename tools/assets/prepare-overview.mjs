#!/usr/bin/env node
/** Trusted operator-only overview preparation. No downloads or public upload surface. */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const MAX_IMAGE = 8 * 1024 ** 2,
  MAX_TEXT = 16384,
  DIMENSION = 2048;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const mapName = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function calibration(origin, scale) {
  if (
    !origin ||
    ![origin.x, origin.y].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7,
    ) ||
    typeof scale !== 'number' ||
    !Number.isFinite(scale) ||
    scale < 0.001 ||
    scale > 10000
  )
    throw new Error(
      'Overview calibration requires finite origins within ±10000000 and scale from 0.001 to 10000.',
    );
  return { origin: { x: origin.x, y: origin.y }, scale };
}

/** A small KeyValues subset, never an include-capable/config interpreter. */
function readValveOverview(data, map) {
  if (!Buffer.isBuffer(data) || data.length > MAX_TEXT || data.includes(0))
    throw new Error('Invalid overview text.');
  const text = data.toString('utf8'),
    tokens = [];
  let offset = 0;
  while (offset < text.length) {
    if (/\s/.test(text[offset])) {
      offset++;
      continue;
    }
    if (text.startsWith('//', offset)) {
      const end = text.indexOf('\n', offset);
      offset = end < 0 ? text.length : end + 1;
      continue;
    }
    if ('{}'.includes(text[offset])) {
      tokens.push(text[offset++]);
      continue;
    }
    if (text[offset] === '"') {
      offset++;
      let value = '',
        closed = false;
      while (offset < text.length) {
        const character = text[offset++];
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === '\\') {
          if (!['"', '\\'].includes(text[offset])) throw new Error('Unsupported overview escape.');
          value += text[offset++];
        } else value += character;
      }
      if (!closed) throw new Error('Unclosed overview value.');
      tokens.push(value);
    } else {
      const start = offset;
      while (offset < text.length && !/[\s{}"]/.test(text[offset])) offset++;
      if (start === offset) throw new Error('Invalid overview token.');
      tokens.push(text.slice(start, offset));
    }
    if (tokens.length > 256) throw new Error('Overview text is too complex.');
  }
  // Variants such as de_ancient_night keep their base map's root key.
  const root =
    tokens[0] === map ||
    (/^[a-z0-9]+_[a-z0-9_]+$/i.test(tokens[0] ?? '') && map.startsWith(tokens[0] + '_'));
  if (!mapName(map) || !root || tokens[1] !== '{' || tokens.at(-1) !== '}')
    throw new Error('Overview map name or root block does not match.');
  const fields = new Map();
  let sections;
  for (let index = 2; index < tokens.length - 1; index += 2) {
    const key = tokens[index]?.toLowerCase(),
      value = tokens[index + 1];
    if (key === 'verticalsections' && value === '{' && !sections) {
      sections = {};
      index += 2;
      for (; tokens[index] !== '}'; index++) {
        const name = tokens[index];
        if (
          !name ||
          !/^[a-z]{1,24}$/.test(name) ||
          Object.hasOwn(sections, name) ||
          Object.keys(sections).length >= 8 ||
          tokens[++index] !== '{'
        )
          throw Error('Invalid layered overview section.');
        const properties = new Map();
        for (index++; tokens[index] !== '}'; index += 2) {
          const property = tokens[index]?.toLowerCase();
          const raw = tokens[index + 1];
          if (
            !['altitudemin', 'altitudemax'].includes(property) ||
            properties.has(property) ||
            !/^[+-]?\d+(?:\.\d+)?$/.test(raw ?? '')
          )
            throw Error('Invalid layered overview altitude.');
          properties.set(property, Number(raw));
        }
        const min = properties.get('altitudemin'),
          max = properties.get('altitudemax');
        if (min < -1e7 || max > 1e7 || !(min < max))
          throw Error('Invalid layered overview altitude range.');
        sections[name] = { min, max };
      }
      const sorted = Object.values(sections).sort((a, b) => a.min - b.min);
      if (!sections.default || sorted.some(({ min }, i) => i && min < sorted[i - 1].max))
        throw Error('Layered overview sections overlap or omit the primary raster.');
      index--;
      continue;
    }
    if (!key || !value || ['{', '}'].includes(key) || ['{', '}'].includes(value))
      throw new Error('Layered or nested overviews are not supported.');
    if (fields.has(key)) throw new Error('Duplicate overview field.');
    if (
      !['pos_x', 'pos_y', 'scale', 'material', 'zoom', 'rotate'].includes(key) &&
      !/^(?:(?:ctspawn|tspawn|bomba|bombb|hostage[1-9])_[xy]|inset_(?:left|top|right|bottom))$/.test(
        key,
      )
    )
      throw new Error('Unsupported overview field. Use explicitly calibrated unrotated artwork.');
    fields.set(key, value);
  }
  const number = (key) => {
    const value = fields.get(key);
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
      throw new Error('Missing or invalid numeric overview calibration.');
    return Number(value);
  };
  const displayRotate = fields.has('rotate') ? number('rotate') : null;
  if (displayRotate !== null && displayRotate !== 0 && displayRotate !== 1)
    throw new Error('Overview rotate must be the legacy display flag 0 or 1.');
  // Valve's CMapOverview::WorldToMap always applies this north-up calibration.
  // rotate controls GetViewAngle/MapToPanel, rotating the complete in-game panel,
  // rather than changing the source raster or its world-to-image transform.
  // https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/client/game_controls/MapOverview.cpp
  return {
    calibration: calibration({ x: number('pos_x'), y: number('pos_y') }, number('scale')),
    displayRotate,
    sections,
  };
}

export function parseValveOverview(data, map) {
  return readValveOverview(data, map).calibration;
}

async function localFile(path, max) {
  const absolute = resolve(path),
    parts = absolute.slice(parse(absolute).root.length).split('/');
  let current = parse(absolute).root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    )
      throw new Error('Input files and ancestors must be regular local paths without links.');
  }
  const file = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > max)
      throw new Error('Input file exceeds the overview limit.');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('Incomplete overview input.');
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error('Overview input changed while reading.');
    return bytes;
  } finally {
    await file.close();
  }
}

export async function prepareOverview({
  image,
  overview,
  origin,
  scale,
  output,
  map,
  version,
  source,
}) {
  if (!mapName(map) || !output || !image)
    throw new Error('Provide a map name, local PNG image and output directory.');
  if (
    typeof version !== 'string' ||
    !version.trim() ||
    version.length > 100 ||
    typeof source !== 'string' ||
    !source.trim() ||
    source.length > 500
  )
    throw new Error(
      'Provide asset version (1–100 characters) and source description (1–500 characters).',
    );
  if (overview && (origin !== undefined || scale !== undefined))
    throw new Error('Choose overview text or explicit calibration, not both.');
  const text = overview ? await localFile(overview, MAX_TEXT) : undefined;
  const parsedOverview = text ? readValveOverview(text, map) : undefined;
  const geometry = parsedOverview?.calibration ?? calibration(origin, scale);
  const original = await localFile(image, MAX_IMAGE);
  if (!original.subarray(0, 8).equals(signature))
    throw new Error('Overview artwork must be a PNG, never SVG or a remote URL.');
  const decoder = sharp(original, { limitInputPixels: DIMENSION ** 2, failOn: 'error' });
  const info = await decoder.metadata();
  if (
    info.format !== 'png' ||
    !info.width ||
    info.width !== info.height ||
    info.width > DIMENSION ||
    (info.pages ?? 1) !== 1
  )
    throw new Error('Overview PNG must be a single square image up to 2048 pixels.');
  const png = await decoder
    .toColourspace('srgb')
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (png.length > MAX_IMAGE) throw new Error('Prepared overview exceeds the 8 MiB image limit.');
  const metadata = {
    schemaVersion: 1,
    map,
    ...geometry,
    referenceSize: 1024,
    assetVersion: version.trim(),
    imageSha256: hash(png),
  };
  const parent = resolve(output, 'overviews'),
    target = join(parent, map);
  const created = await mkdir(parent, { recursive: true, mode: 0o755 });
  if (created) {
    // Restrictive umasks must not make newly created artwork ancestors unreadable.
    // Existing operator directories retain their original permissions.
    let directory = resolve(created);
    await chmod(directory, 0o755);
    for (const part of relative(directory, parent).split('/').filter(Boolean)) {
      directory = join(directory, part);
      await chmod(directory, 0o755);
    }
  }
  const staging = await mkdtemp(join(parent, '.overview-'));
  let claimed = false;
  try {
    await writeFile(join(staging, 'overview.png'), png, { flag: 'wx', mode: 0o644 });
    await writeFile(join(staging, 'overview.json'), JSON.stringify(metadata, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o644,
    });
    await writeFile(
      join(staging, 'provenance.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          map,
          assetVersion: version.trim(),
          source: source.trim(),
          sourceImage: basename(image),
          sourceImageSha256: hash(original),
          sourceOverview: overview ? basename(overview) : null,
          sourceOverviewSha256: text ? hash(text) : null,
          sourceDisplayRotate: parsedOverview?.displayRotate ?? null,
          sourceVerticalSections: parsedOverview?.sections ?? null,
          imageSha256: metadata.imageSha256,
          preparedAt: new Date().toISOString(),
          transformation:
            'Local PNG decoded and normalized to self-contained RGBA PNG. North-up Source coordinates retained at 1024 reference size. Valve rotate is an in-game panel display flag and is not applied to the raster.',
          rights: 'Operator-supplied artwork. This tool does not grant redistribution rights.',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o644 },
    );
    // Claim a new destination without replacing any existing pack, even empty.
    try {
      await mkdir(target, { mode: 0o700 });
      claimed = true;
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error('Overview output already exists. Prepare a new asset directory.');
      throw error;
    }
    for (const name of ['overview.png', 'overview.json', 'provenance.json']) {
      await chmod(join(staging, name), 0o644);
      await rename(join(staging, name), join(target, name));
    }
    await chmod(target, 0o755);
    return { output: target, width: info.width, bytes: png.length };
  } catch (error) {
    if (claimed) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        image: { type: 'string' },
        overview: { type: 'string' },
        'origin-x': { type: 'string' },
        'origin-y': { type: 'string' },
        scale: { type: 'string' },
        output: { type: 'string' },
        map: { type: 'string' },
        version: { type: 'string' },
        source: { type: 'string' },
      },
    });
    const result = await prepareOverview({
      ...values,
      origin:
        values['origin-x'] !== undefined || values['origin-y'] !== undefined
          ? { x: Number(values['origin-x']), y: Number(values['origin-y']) }
          : undefined,
      scale: values.scale === undefined ? undefined : Number(values.scale),
    });
    console.log('Prepared local overview:', result.output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
