#!/usr/bin/env node
/** Fixed official particle textures for the native fire, smoke and blast effects.
 * Asset-service/operator only: pinned source, CRC-checked selection, confined
 * decoding and atlas packing, no-replace publication. Never runs in HTTP/parser. */
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runAssetProcess } from './install-steam-assets.mjs';
import { readVpkDirectory } from './source2-dependencies.mjs';
import { parseSteamListing, checkedBatch } from './steam-assets-plan.mjs';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import { regular, fileHash, checkStorage, checkFreeReserve, exists } from './asset-storage.mjs';
import { prepareToolchain } from './prepare-toolchain.mjs';
import { markSteamRateLimit } from './official-map-inventory.mjs';
import {
  effectTextureLimits as limits,
  effectTextureRegistry as registry,
  managedEffectDirectory,
} from '../../shared/effect-texture-bank.mjs';

const MiB = 1024 ** 2;
const script = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const effectTextureIds = Object.freeze(Object.keys(registry.items));
if (
  registry.schemaVersion !== 1 ||
  !effectTextureIds.length ||
  effectTextureIds.length > limits.items ||
  effectTextureIds.some(
    (id) =>
      !/^[a-z0-9-]{1,40}$/.test(id) ||
      !/^materials\/[a-z0-9_/-]{1,200}\.vtex_c$/.test(registry.items[id].source),
  )
)
  throw Error('Invalid fixed effect texture registry.');

async function boundedRead(path, max) {
  const { handle, stat } = await regularFile(path, max);
  try {
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
      if (!bytesRead) throw Error('Incomplete effect texture artifact.');
      at += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** The decompiled sheet: frames per sequence from S2V's .mks, or one frame. */
export function parseSheet(text, id) {
  const sequences = [];
  for (const line of String(text).split('\n')) {
    const value = line.trim();
    if (/^sequence\s+\d+/.test(value)) sequences.push({ frames: [], clamp: false });
    else if (/^clamp/.test(value) && sequences.length) sequences.at(-1).clamp = true;
    else {
      const frame = /^frame\s+([A-Za-z0-9_.-]+\.png)\b/.exec(value);
      if (frame && sequences.length) {
        if (!frame[1].startsWith(id + '_seq')) throw Error('Unexpected effect sheet frame.');
        sequences.at(-1).frames.push(frame[1]);
      }
    }
  }
  if (
    !sequences.length ||
    sequences.length > limits.sequences ||
    sequences.some((sequence) => !sequence.frames.length) ||
    sequences.reduce((sum, sequence) => sum + sequence.frames.length, 0) > limits.frames
  )
    throw Error('Effect sheet exceeds its bounds.');
  return sequences;
}

/** Confined child: pack one decoded texture into a square-cell atlas PNG and its sheet. */
export async function packEffectTexture({ input, id, output }) {
  if (!effectTextureIds.includes(id)) throw Error('Unknown fixed effect texture.');
  const { default: sharp } = await import('sharp');
  const directory = resolve(input);
  await localDirectory(directory);
  const names = await readdir(directory);
  const sheetName = `${id}.mks`;
  const sequences = names.includes(sheetName)
    ? parseSheet((await boundedRead(join(directory, sheetName), 256 * 1024)).toString('utf8'), id)
    : [{ frames: [`${id}.png`], clamp: true }];
  const files = sequences.flatMap((sequence) => sequence.frames);
  for (const file of files) if (!names.includes(file)) throw Error('Missing effect frame.');
  const decoded = [];
  let edge = 1;
  for (const file of files) {
    const bytes = await boundedRead(join(directory, file), 16 * MiB);
    const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
    const meta = await image.metadata();
    if (meta.format !== 'png' || !meta.width || !meta.height)
      throw Error('Effect frame is not PNG.');
    edge = Math.max(edge, meta.width, meta.height);
    decoded.push(bytes);
  }
  const columns = Math.ceil(Math.sqrt(files.length)),
    rows = Math.ceil(files.length / columns);
  // Frames keep their authored size unless the atlas would exceed its edge.
  const cell = Math.max(8, Math.min(edge, Math.floor(limits.atlasEdge / columns)));
  const composite = [];
  for (const [index, bytes] of decoded.entries())
    composite.push({
      input: await sharp(bytes)
        .resize({
          width: cell,
          height: cell,
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .ensureAlpha()
        .png()
        .toBuffer(),
      left: (index % columns) * cell,
      top: Math.floor(index / columns) * cell,
    });
  const atlas = await sharp({
    create: {
      width: columns * cell,
      height: rows * cell,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composite)
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (atlas.length > limits.atlasBytes) throw Error('Effect atlas exceeds its byte bound.');
  let start = 0;
  const sheet = {
    id,
    width: columns * cell,
    height: rows * cell,
    cell,
    columns,
    sequences: sequences.map((sequence) => {
      const entry = { start, count: sequence.frames.length, clamp: sequence.clamp };
      start += sequence.frames.length;
      return entry;
    }),
  };
  await writeFile(join(output, `${id}.png`), atlas, { flag: 'wx', mode: 0o644 });
  await writeFile(join(output, `${id}.json`), JSON.stringify(sheet), { flag: 'wx', mode: 0o644 });
  return { id, bytes: atlas.length };
}

function validSheet(sheet, id) {
  return (
    sheet &&
    sheet.id === id &&
    [sheet.width, sheet.height, sheet.cell, sheet.columns].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= limits.atlasEdge,
    ) &&
    Array.isArray(sheet.sequences) &&
    sheet.sequences.length >= 1 &&
    sheet.sequences.length <= limits.sequences &&
    sheet.sequences.every(
      (s) =>
        Number.isSafeInteger(s.start) &&
        Number.isSafeInteger(s.count) &&
        s.count >= 1 &&
        s.start + s.count <= limits.frames &&
        typeof s.clamp === 'boolean',
    )
  );
}

export async function installEffectTextures(options, adapters = {}) {
  if (
    !options.cache ||
    !options.output ||
    !/^[1-9]\d{0,19}$/.test(options.manifest ?? '') ||
    BigInt(options.manifest) > 18446744073709551615n ||
    Boolean(options.s2v) !== Boolean(options.downloader)
  )
    throw Error('Explicit cache/output/manifest and both tools or neither are required.');
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60 * 1000)])
    : AbortSignal.timeout(15 * 60 * 1000);
  const cache = resolve(options.cache),
    output = resolve(options.output);
  if (cache === output || cache.startsWith(output + '/') || output.startsWith(cache + '/'))
    throw Error('Keep private effect sources separate from runtime assets.');
  await localDirectory(cache, true);
  await localDirectory(output);
  if (!options.networkDeny) throw Error('Required effect conversion confinement is unavailable.');
  await regular(options.networkDeny, MiB);
  const probe = spawnSync(options.networkDeny, ['--check'], {
    stdio: 'pipe',
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (probe.error || probe.status !== 0)
    throw Error('Required effect conversion confinement is unavailable.');
  const bankRoot = join(output, managedEffectDirectory);
  try {
    await mkdir(bankRoot, { mode: 0o755 });
    await chmod(bankRoot, 0o755);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await localDirectory(bankRoot);
  if (await exists(join(bankRoot, 'effects'))) {
    await localDirectory(join(bankRoot, 'effects'));
    return { status: 'installed' };
  }
  const game = join(cache, 'steam');
  await localDirectory(game, true);
  const tools = options.s2v
    ? { s2v: resolve(options.s2v), downloader: resolve(options.downloader) }
    : await (adapters.prepareToolchain ?? prepareToolchain)({
        cache: options.toolchainCache ? resolve(options.toolchainCache) : join(cache, 'tools'),
        signal,
      });
  for (const tool of [tools.s2v, tools.downloader]) await regular(tool, 512 * MiB);
  const stage = await mkdtemp(join(cache, 'effects-install-')),
    pins = join(stage, 'manifests'),
    home = join(stage, 'home'),
    temporary = join(stage, 'tmp'),
    conversion = join(stage, 'conversion'),
    packed = join(conversion, 'packed'),
    nativeHome = join(conversion, 'home'),
    nativeTmp = join(conversion, 'tmp');
  for (const path of [pins, home, temporary, conversion, packed, nativeHome, nativeTmp])
    await localDirectory(path, true);
  await writeFile(
    join(pins, 'manifest_2347770.txt'),
    `Content Manifest for Depot 2347770\n\nManifest ID / date     : ${options.manifest} / fixed effect textures\n`,
    { flag: 'wx', mode: 0o600 },
  );
  let sequence = 0,
    selected = 0,
    publishing;
  const run = (command, args, label, extra = {}) =>
    (adapters.run ?? runAssetProcess)(command, args, {
      cwd: stage,
      home,
      temporary,
      signal,
      timeoutMs: 120000,
      log: join(stage, `${++sequence}-${label}.log`),
      storageGuard: () => checkFreeReserve(cache, output),
      ...extra,
    });
  const steam = async (args, label) => {
    try {
      return await run(tools.downloader, args, label);
    } catch (error) {
      markSteamRateLimit(error);
      throw error;
    }
  };
  const download = async (records) => {
    records = checkedBatch(records);
    if (!records.length) return;
    selected += records.reduce((sum, x) => sum + x.bytes, 0);
    if (selected > 96 * MiB) throw Error('Fixed effect texture selection exceeds 96 MiB.');
    await checkStorage(cache, output, records.reduce((sum, x) => sum + x.bytes, 0) + 64 * MiB);
    await writeFile(
      join(stage, 'files.json'),
      JSON.stringify({ 2347770: records.map((x) => x.selector) }),
      { mode: 0o600 },
    );
    await steam(
      ['track', '730', '--anonymous', '--output', game, '--manifests', pins, '--save-manifest'],
      'effects-download',
    );
  };
  const confined = { home: nativeHome, temporary: nativeTmp, conversionWriteRoots: [conversion] };
  try {
    const name = 'game/csgo/pak01_dir.vpk',
      listing = await steam(
        ['ls', '730', `2347770:${options.manifest}`, '--anonymous', '--', name],
        'effects-index-list',
      );
    const plan = parseSteamListing(listing.stdout, [name]);
    if (plan.manifest !== options.manifest)
      throw Object.assign(Error('Effect source manifest mismatch.'), {
        code: 'SOURCE_MAP_MISMATCH',
      });
    await download(plan.files.map((x) => ({ selector: x.file, bytes: x.bytes })));
    for (const file of plan.files)
      if ((await fileHash(join(game, file.file), 'sha1', file.bytes)) !== file.sha1)
        throw Object.assign(Error('Effect source index hash mismatch.'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
    const index = await (adapters.index ?? readVpkDirectory)(join(game, name));
    const available = effectTextureIds.filter((id) => {
      const entry = index.entries.get(registry.items[id].source);
      return entry && entry.length + entry.preloadBytes <= limits.sourceBytes;
    });
    const unsupported = effectTextureIds
      .filter((id) => !available.includes(id))
      .map((id) => ({
        id,
        source: registry.items[id].source,
        reason: 'fixed-resource-unavailable-or-oversize',
      }));
    await download(
      available.map((id) => {
        const entry = index.entries.get(registry.items[id].source);
        return { selector: `${name}:${entry.resource}`, bytes: entry.length + entry.preloadBytes };
      }),
    );
    const resources = [];
    for (const id of available) {
      const resource = registry.items[id].source,
        bytes = await index.readEntry(resource);
      if (!bytes || bytes.length > limits.sourceBytes)
        throw Object.assign(Error('Native effect texture failed CRC or size bounds.'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
      resources.push({ id, resource, bytes: bytes.length, sha256: hash(bytes) });
      const decoded = join(conversion, id);
      await localDirectory(decoded, true);
      const input = join(conversion, `${id}.vtex_c`);
      await writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
      await run(
        options.networkDeny,
        [
          '--write-root',
          conversion,
          '--',
          tools.s2v,
          '-i',
          input,
          '--decompile',
          '--output',
          decoded,
          '--quiet',
        ],
        'effects-decode',
        confined,
      );
      await run(
        options.networkDeny,
        [
          '--write-root',
          conversion,
          '--',
          process.execPath,
          '--max-old-space-size=384',
          script,
          '--pack',
          decoded,
          '--id',
          id,
          '--output',
          packed,
        ],
        'effects-pack',
        { ...confined, timeoutMs: 60000 },
      );
    }
    const parent = bankRoot;
    publishing = await mkdtemp(join(parent, '.effects-'));
    let total = 0;
    const prepared = [];
    for (const id of available) {
      const atlas = await boundedRead(join(packed, `${id}.png`), limits.atlasBytes),
        sheet = JSON.parse((await boundedRead(join(packed, `${id}.json`), 64 * 1024)).toString());
      if (
        !validSheet(sheet, id) ||
        atlas.readUInt32BE(16) !== sheet.width ||
        atlas.readUInt32BE(20) !== sheet.height
      )
        throw Error('Packed effect texture failed its bounds.');
      total += atlas.length;
      if (total > limits.bankBytes) throw Error('Effect texture bank exceeds its byte bound.');
      const item = join(publishing, id);
      await mkdir(item, { mode: 0o755 });
      await writeFile(join(item, 'atlas.png'), atlas, { flag: 'wx', mode: 0o644 });
      const manifest = { schemaVersion: 1, ...sheet, sha256: hash(atlas), bytes: atlas.length };
      await writeFile(join(item, 'manifest.json'), JSON.stringify(manifest) + '\n', {
        flag: 'wx',
        mode: 0o644,
      });
      prepared.push({ id, sha256: manifest.sha256, bytes: atlas.length });
    }
    await writeFile(
      join(publishing, 'provenance.json'),
      JSON.stringify({
        schemaVersion: 1,
        source: {
          appId: 730,
          depotId: 2347770,
          manifest: options.manifest,
          index: plan.files,
          resources,
        },
        unsupported,
        prepared,
        transformation:
          'Fixed native particle textures decoded offline and packed into square-cell atlases. Rights remain with Valve; not included in Git or images.',
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await options.beforePublish?.();
    signal.throwIfAborted();
    await chmod(publishing, 0o755);
    const publication = spawnSync(
      options.networkDeny,
      ['--publish-effects', publishing, join(parent, 'effects')],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 },
    );
    if (publication.error || publication.status !== 0)
      throw Error('Atomic effect texture publication failed without replacement.');
    publishing = undefined;
    return { status: 'prepared', items: prepared.length, unsupported: unsupported.length };
  } finally {
    if (publishing) await rm(publishing, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      pack: { type: 'string' },
      id: { type: 'string' },
      output: { type: 'string' },
      cache: { type: 'string' },
      manifest: { type: 'string' },
      s2v: { type: 'string' },
      downloader: { type: 'string' },
      'network-deny': { type: 'string' },
    },
  });
  const result = values.pack
    ? await packEffectTexture({ input: values.pack, id: values.id, output: values.output })
    : await installEffectTextures({ ...values, networkDeny: values['network-deny'] });
  console.log(JSON.stringify(result));
}
