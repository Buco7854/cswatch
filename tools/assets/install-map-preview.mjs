#!/usr/bin/env node
/** One fixed official native landing image. No public source selection or image upload. */
import { mkdtemp, writeFile, mkdir, rm, readFile, chmod } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runAssetProcess } from './install-steam-assets.mjs';
import { readVpkDirectory } from './source2-dependencies.mjs';
import { parseSteamListing, checkedBatch, selectedSteamManifest } from './steam-assets-plan.mjs';
import { prepareToolchain } from './prepare-toolchain.mjs';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import {
  regular,
  fileHash,
  checkStorage,
  checkFreeReserve,
  exists,
  readableDirectory,
} from './asset-storage.mjs';
import { markSteamRateLimit } from './official-map-inventory.mjs';
import { normalizeMapPreview, previewMaps } from './prepare-map-preview.mjs';
import { completePng } from './source-image-compactor.mjs';
const MiB = 1024 ** 2;
export const officialPreview = Object.freeze({
  map: 'de_mirage',
  resource: 'panorama/images/map_icons/screenshots/720p/de_mirage_png.vtex_c',
  bytes: 8 * MiB,
  deadlineMs: 5 * 60 * 1000,
});
const script = fileURLToPath(import.meta.url),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function boundedBytes(path, max) {
  const { handle, stat } = await regularFile(path, max);
  try {
    if (stat.size < 1) throw Error('Empty preview artifact.');
    const before = await handle.stat({ bigint: true });
    if (before.size !== BigInt(stat.size)) throw Error('Preview artifact changed.');
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const read = await handle.read(bytes, at, bytes.length - at, at);
      if (!read.bytesRead) throw Error('Incomplete preview artifact.');
      at += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(
        (key) => before[key] !== after[key],
      )
    )
      throw Error('Preview artifact changed.');
    return bytes;
  } finally {
    await handle.close();
  }
}
/** Sharp runs only through this explicit conversion-child entry point. */
export async function normalizeOfficialPreview({ input, output }) {
  const normalized = await normalizeMapPreview(input);
  output = resolve(output);
  await localDirectory(dirname(output));
  await writeFile(output, normalized.data, { flag: 'wx', mode: 0o644 });
  return {
    sha256: hash(normalized.data),
    bytes: normalized.data.length,
    width: normalized.width,
    height: normalized.height,
    sourceSha256: normalized.sourceSha256,
    sourceWidth: normalized.sourceWidth,
    sourceHeight: normalized.sourceHeight,
  };
}
export async function installMapPreview(options, adapters = {}) {
  const manifest = selectedSteamManifest(options.manifest);
  if (
    !options.cache ||
    !options.output ||
    !options.networkDeny ||
    Boolean(options.s2v) !== Boolean(options.downloader)
  )
    throw Error('Explicit source/cache/output and required preview confinement are needed.');
  const cache = resolve(options.cache),
    output = resolve(options.output);
  if (cache === output || cache.startsWith(output + '/') || output.startsWith(cache + '/'))
    throw Error('Keep preview sources separate from served assets.');
  await localDirectory(cache, true);
  await localDirectory(output);
  const parent = join(output, 'previews'),
    target = join(parent, officialPreview.map);
  if (await exists(parent)) await localDirectory(parent);
  for (const map of previewMaps) {
    const existing = join(parent, map);
    if (await exists(existing)) {
      await localDirectory(existing);
      return { status: 'installed', map };
    }
  }
  const game = join(cache, 'steam');
  for (const directory of [game, join(game, 'game'), join(game, 'game/csgo')])
    await localDirectory(directory, true);
  const indexPath = join(game, 'game/csgo/pak01_dir.vpk');
  if (await exists(indexPath)) await regular(indexPath, 32 * MiB);
  await regular(options.networkDeny, MiB);
  const probe = spawnSync(options.networkDeny, ['--check'], {
    stdio: 'pipe',
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (probe.error || probe.status !== 0)
    throw Error('Required preview conversion confinement is unavailable.');
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(officialPreview.deadlineMs)])
    : AbortSignal.timeout(officialPreview.deadlineMs);
  const storage = adapters.storage ?? checkStorage,
    reserve = adapters.reserve ?? checkFreeReserve;
  await storage(cache, output);
  const tools = options.s2v
    ? { s2v: resolve(options.s2v), downloader: resolve(options.downloader) }
    : await (adapters.prepareToolchain ?? prepareToolchain)({
        cache: options.toolchainCache ? resolve(options.toolchainCache) : join(cache, 'tools'),
        signal,
      });
  for (const tool of [tools.s2v, tools.downloader]) await regular(tool, 512 * MiB);
  const stage = await mkdtemp(join(cache, 'preview-install-')),
    home = join(stage, 'home'),
    temporary = join(stage, 'tmp'),
    pins = join(stage, 'manifests'),
    conversion = join(stage, 'conversion'),
    nativeHome = join(conversion, 'home'),
    nativeTmp = join(conversion, 'tmp');
  for (const path of [home, temporary, pins, conversion, nativeHome, nativeTmp])
    await localDirectory(path, true);
  let sequence = 0,
    publishing;
  const run = (command, args, label, extra = {}) =>
    (adapters.run ?? runAssetProcess)(command, args, {
      cwd: stage,
      home,
      temporary,
      signal,
      timeoutMs: 120000,
      log: join(stage, `${++sequence}-${label}.log`),
      storageGuard: () => reserve(cache, output),
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
    const bytes = records.reduce((sum, item) => sum + item.bytes, 0);
    if (bytes > 32 * MiB) throw Error('Fixed preview source selection exceeds 32 MiB.');
    await storage(cache, output, bytes + 64 * MiB);
    await writeFile(
      join(stage, 'files.json'),
      JSON.stringify({ 2347770: records.map((item) => item.selector) }),
      { mode: 0o600 },
    );
    await steam(
      ['track', '730', '--anonymous', '--output', game, '--manifests', pins, '--save-manifest'],
      'preview-download',
    );
  };
  try {
    await writeFile(
      join(pins, 'manifest_2347770.txt'),
      `Content Manifest for Depot 2347770\n\nManifest ID / date     : ${manifest} / fixed official landing preview\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const packageFile = 'game/csgo/pak01_dir.vpk',
      listing = await steam(
        ['ls', '730', `2347770:${manifest}`, '--anonymous', '--', packageFile],
        'preview-index-list',
      ),
      plan = parseSteamListing(listing.stdout, [packageFile]);
    if (plan.manifest !== manifest)
      throw Object.assign(Error('Preview source manifest differs.'), {
        code: 'SOURCE_MAP_MISMATCH',
      });
    const indexBytes = plan.files.reduce((sum, item) => sum + item.bytes, 0);
    if (indexBytes > 32 * MiB) throw Error('Fixed preview source selection exceeds 32 MiB.');
    const missingIndexes = [];
    for (const item of plan.files) {
      const path = join(game, item.file);
      // Verify the complete selected bytes afresh, rather than treating metadata or a
      // previous manifest as proof. Unsafe files remain errors, never download targets.
      const cached = (await exists(path)) ? await regular(path, 32 * MiB) : null;
      if (
        !cached ||
        cached.size !== item.bytes ||
        (await fileHash(path, 'sha1', item.bytes)) !== item.sha1
      )
        missingIndexes.push({ selector: item.file, bytes: item.bytes });
    }
    await download(missingIndexes);
    for (const item of plan.files)
      if ((await fileHash(join(game, item.file), 'sha1', item.bytes)) !== item.sha1)
        throw Object.assign(Error('Preview package index hash differs.'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
    const index = await (adapters.index ?? readVpkDirectory)(join(game, packageFile)),
      entry = index.entries.get(officialPreview.resource);
    if (!entry || entry.length + entry.preloadBytes > officialPreview.bytes)
      throw Error('Fixed native preview is absent or exceeds its source bound.');
    if (indexBytes + entry.length + entry.preloadBytes > 32 * MiB)
      throw Error('Fixed preview source selection exceeds 32 MiB.');
    if (entry.archivePath) {
      if (!entry.archivePath.startsWith(join(game, 'game/csgo') + '/'))
        throw Error('Native preview archive escapes its selected cache.');
      if (await exists(entry.archivePath)) await regular(entry.archivePath, 64 * 1024 ** 3);
    }
    if (!(await index.readEntry(officialPreview.resource)))
      await download([
        {
          selector: `${packageFile}:${officialPreview.resource}`,
          bytes: entry.length + entry.preloadBytes,
        },
      ]);
    const raw = await index.readEntry(officialPreview.resource);
    if (!raw || raw.length > officialPreview.bytes)
      throw Object.assign(Error('Native preview failed CRC.'), { code: 'SOURCE_MAP_MISMATCH' });
    // Two bounded PNGs and a source/auxiliary native copy coexist during conversion.
    // Reserve those writes independently of CDN chunk overhead; a fully verified
    // cache therefore needs no new downloader allocation allowance.
    await reserve(cache, output, raw.length * 2 + officialPreview.bytes * 2 + 64 * 1024);
    const input = join(conversion, 'source.vtex_c'),
      decoded = join(conversion, 'decoded'),
      processed = join(conversion, 'preview.png');
    await mkdir(decoded);
    await writeFile(input, raw, { flag: 'wx', mode: 0o600 });
    const nativeOptions = {
      home: nativeHome,
      temporary: nativeTmp,
      conversionWriteRoots: [conversion],
    };
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
      'preview-s2v',
      nativeOptions,
    );
    await run(
      options.networkDeny,
      [
        '--write-root',
        conversion,
        '--',
        process.execPath,
        '--max-old-space-size=256',
        script,
        '--prepare-image',
        join(decoded, 'source.png'),
        '--output',
        processed,
      ],
      'preview-sharp',
      { ...nativeOptions, timeoutMs: 30000 },
    );
    const bytes = await boundedBytes(processed, officialPreview.bytes);
    completePng(bytes);
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (
      width > 1600 ||
      height > 900 ||
      bytes[24] !== 8 ||
      ![2, 6].includes(bytes[25]) ||
      bytes[26] !== 0 ||
      bytes[27] !== 0 ||
      bytes[28] !== 0
    )
      throw Error('Prepared preview dimensions exceed their bound.');
    const assetVersion = `steam-2347770-${manifest}`,
      imageSha256 = hash(bytes);
    await reserve(cache, output, bytes.length + 16384);
    await readableDirectory(parent);
    await localDirectory(parent);
    publishing = await mkdtemp(join(parent, '.preview-'));
    await writeFile(join(publishing, 'preview.png'), bytes, { flag: 'wx', mode: 0o644 });
    await writeFile(
      join(publishing, 'preview.json'),
      JSON.stringify({ schemaVersion: 1, map: officialPreview.map, assetVersion, imageSha256 }) +
        '\n',
      { flag: 'wx', mode: 0o644 },
    );
    await writeFile(
      join(publishing, 'provenance.json'),
      JSON.stringify({
        schemaVersion: 1,
        map: officialPreview.map,
        assetVersion,
        source: {
          appId: 730,
          depotId: 2347770,
          manifest,
          resource: officialPreview.resource,
          sourceSha256: hash(raw),
          crc32: entry.crc32,
          index: plan.files,
        },
        imageSha256,
        width,
        height,
        transformation:
          'Fixed native Valve screenshot decoded and normalized offline. Decorative only, not replay calibration.',
      }) + '\n',
      { flag: 'wx', mode: 0o644 },
    );
    await options.beforePublish?.();
    signal.throwIfAborted();
    await chmod(publishing, 0o755);
    const publication = spawnSync(options.networkDeny, ['--publish-preview', publishing, target], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
    });
    if (publication.error || publication.status !== 0)
      throw Error('Atomic preview publication failed without replacement.');
    return {
      status: 'prepared',
      map: officialPreview.map,
      sha256: imageSha256,
      bytes: bytes.length,
    };
  } finally {
    if (publishing) await rm(publishing, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      'prepare-image': { type: 'string' },
      output: { type: 'string' },
      cache: { type: 'string' },
      manifest: { type: 'string' },
      s2v: { type: 'string' },
      downloader: { type: 'string' },
      'network-deny': { type: 'string' },
    },
  });
  const result = values['prepare-image']
    ? await normalizeOfficialPreview({ input: values['prepare-image'], output: values.output })
    : await installMapPreview({ ...values, networkDeny: values['network-deny'] });
  console.log(JSON.stringify(result));
}
