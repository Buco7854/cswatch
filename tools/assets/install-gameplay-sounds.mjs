#!/usr/bin/env node
/** Optional asset-service/operator-only bounded native audio acquisition. Never runs in HTTP/parser. */
import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runAssetProcess } from './install-steam-assets.mjs';
import { readVpkDirectory } from './source2-dependencies.mjs';
import { parseSteamListing, checkedBatch } from './steam-assets-plan.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { regular, fileHash, checkStorage, checkFreeReserve, exists } from './asset-storage.mjs';
import { managedSoundDirectory } from '../../shared/gameplay-sound-bank.mjs';
import { prepareToolchain } from './prepare-toolchain.mjs';
import { markSteamRateLimit } from './official-map-inventory.mjs';
import {
  prepareGameplaySoundBank,
  gameplaySoundRegistry,
  soundRegistryIds,
} from './prepare-gameplay-sounds.mjs';
const MiB = 1024 ** 2;
export async function installGameplaySounds(options, adapters = {}) {
  if (
    !options.cache ||
    !options.output ||
    !/^[1-9]\d{0,19}$/.test(options.manifest ?? '') ||
    BigInt(options.manifest) > 18446744073709551615n ||
    Boolean(options.s2v) !== Boolean(options.downloader)
  )
    throw Error('Explicit cache/output/manifest and both tools or neither are required.');
  const ids = options.items ?? soundRegistryIds;
  if (
    (options.managed && options.items !== undefined) ||
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > soundRegistryIds.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !soundRegistryIds.includes(id))
  )
    throw Error('Unknown fixed native sound selection.');
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60 * 1000)])
    : AbortSignal.timeout(15 * 60 * 1000);
  const cache = resolve(options.cache),
    output = resolve(options.output);
  if (cache === output || cache.startsWith(output + '/') || output.startsWith(cache + '/'))
    throw Error('Keep private sound cache separate from runtime assets.');
  await localDirectory(cache, true);
  await localDirectory(output);
  const game = join(cache, 'steam');
  await localDirectory(game, true);
  if (!options.networkDeny) throw Error('Required sound conversion confinement is unavailable.');
  await regular(options.networkDeny, 1024 * 1024);
  const probe = spawnSync(options.networkDeny, ['--check'], {
    stdio: 'pipe',
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (probe.error || probe.status !== 0)
    throw Error('Required sound conversion confinement is unavailable.');
  let bankRoot = output;
  if (options.managed) {
    bankRoot = join(output, managedSoundDirectory);
    // A different web-service UID must be able to traverse the final bank.
    try {
      await mkdir(bankRoot, { mode: 0o755 });
      await chmod(bankRoot, 0o755);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await localDirectory(bankRoot);
  }
  if (await exists(join(bankRoot, 'sounds'))) {
    await localDirectory(join(bankRoot, 'sounds'));
    return { status: 'installed' };
  }
  const tools = options.s2v
    ? { s2v: resolve(options.s2v), downloader: resolve(options.downloader) }
    : await (adapters.prepareToolchain ?? prepareToolchain)({
        cache: options.toolchainCache ? resolve(options.toolchainCache) : join(cache, 'tools'),
        signal,
      });
  for (const tool of [tools.s2v, tools.downloader, options.networkDeny])
    if (!tool) throw Error('Required sound conversion confinement is unavailable.');
    else await regular(tool, 512 * MiB);
  const stage = await mkdtemp(join(cache, 'sound-install-')),
    pins = join(stage, 'manifests'),
    home = join(stage, 'home'),
    temporary = join(stage, 'tmp'),
    conversion = join(stage, 'conversion'),
    converted = join(conversion, 'decoded'),
    nativeHome = join(conversion, 'home'),
    nativeTmp = join(conversion, 'tmp');
  for (const path of [game, pins, home, temporary, conversion, converted, nativeHome, nativeTmp])
    await localDirectory(path, true);
  await writeFile(
    join(pins, 'manifest_2347770.txt'),
    `Content Manifest for Depot 2347770\n\nManifest ID / date     : ${options.manifest} / fixed gameplay audio\n`,
    { flag: 'wx', mode: 0o600 },
  );
  let sequence = 0,
    selected = 0;
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
    if (selected > 64 * MiB) throw Error('Fixed gameplay audio selection exceeds64MiB.');
    await checkStorage(cache, output, records.reduce((sum, x) => sum + x.bytes, 0) + 64 * MiB);
    await writeFile(
      join(stage, 'files.json'),
      JSON.stringify({ 2347770: records.map((x) => x.selector) }),
      { mode: 0o600 },
    );
    await steam(
      ['track', '730', '--anonymous', '--output', game, '--manifests', pins, '--save-manifest'],
      'sound-download',
    );
  };
  try {
    const name = 'game/csgo/pak01_dir.vpk',
      listing = await steam(
        ['ls', '730', `2347770:${options.manifest}`, '--anonymous', '--', name],
        'sound-index-list',
      );
    const plan = parseSteamListing(listing.stdout, [name]);
    if (plan.manifest !== options.manifest)
      throw Object.assign(Error('Sound source manifest mismatch.'), {
        code: 'SOURCE_MAP_MISMATCH',
      });
    await download(plan.files.map((x) => ({ selector: x.file, bytes: x.bytes })));
    for (const file of plan.files)
      if ((await fileHash(join(game, file.file), 'sha1', file.bytes)) !== file.sha1)
        throw Object.assign(Error('Sound source index hash mismatch.'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
    const index = await (adapters.index ?? readVpkDirectory)(join(game, name));
    const availableIds = ids.filter((id) => {
      const entry = index.entries.get(gameplaySoundRegistry.items[id].source);
      return entry && entry.length + entry.preloadBytes <= 2 * MiB;
    });
    const unsupportedResources = ids
      .filter((id) => !availableIds.includes(id))
      .map((id) => ({
        id,
        source: gameplaySoundRegistry.items[id].source,
        reason: 'fixed-resource-unavailable-or-oversize',
      }));
    await download(
      availableIds.map((id) => {
        const entry = index.entries.get(gameplaySoundRegistry.items[id].source);
        return { selector: `${name}:${entry.resource}`, bytes: entry.length + entry.preloadBytes };
      }),
    );
    const resources = [];
    for (const id of availableIds) {
      const resource = gameplaySoundRegistry.items[id].source,
        bytes = await index.readEntry(resource);
      if (!bytes || bytes.length > 2 * MiB)
        throw Object.assign(Error('Native sound resource failed CRC or size bounds.'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
      const input = join(conversion, `${id}.vsnd_c`);
      await writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
      const resourceReport = {
        id,
        resource,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      resources.push(resourceReport);
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
          converted,
          '--quiet',
        ],
        'sound-convert',
        { home: nativeHome, temporary: nativeTmp, conversionWriteRoots: [conversion] },
      );
      if (
        (await exists(join(converted, `${id}.mp3`))) &&
        !(await exists(join(converted, `${id}.wav`)))
      ) {
        resourceReport.exportedMpegSha256 = await fileHash(
          join(converted, `${id}.mp3`),
          'sha256',
          2 * MiB,
        );
        const normalized = await run(
          options.networkDeny,
          [
            '--write-root',
            conversion,
            '--',
            process.execPath,
            '--max-old-space-size=128',
            fileURLToPath(new URL('./normalize-gameplay-sound.mjs', import.meta.url)),
            '--input',
            join(converted, `${id}.mp3`),
            '--output',
            join(converted, `${id}.wav`),
          ],
          'sound-pcm-normalize',
          {
            home: nativeHome,
            temporary: nativeTmp,
            conversionWriteRoots: [conversion],
            allowFailure: true,
            timeoutMs: 30000,
          },
        );
        resourceReport.normalization =
          normalized.code === 0 ? 'bounded-offline-mpg123-to-pcm16' : 'unsupported-codec';
      }
    }
    return await prepareGameplaySoundBank({
      input: converted,
      output: bankRoot,
      items: ids,
      networkDeny: options.networkDeny,
      beforePublish: options.beforePublish,
      source: {
        appId: 730,
        depotId: 2347770,
        manifest: options.manifest,
        index: plan.files,
        resources,
        unsupportedResources,
      },
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string' },
      output: { type: 'string' },
      manifest: { type: 'string' },
      s2v: { type: 'string' },
      downloader: { type: 'string' },
      'network-deny': { type: 'string' },
    },
  });
  console.log(
    JSON.stringify(await installGameplaySounds({ ...values, networkDeny: values['network-deny'] })),
  );
}
