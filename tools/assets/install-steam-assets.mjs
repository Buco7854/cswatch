#!/usr/bin/env node
/** Explicit operator action only. Anonymous fixed-depot downloads, never an app route. */
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readVpkDirectory, scanSource2Dependencies } from './source2-dependencies.mjs';
import {
  STEAM_APP,
  STEAM_DEPOT,
  STEAM_ADDON_DEPOT,
  addonPackage,
  addonPrefabPackage,
  steamAssetLimits,
  selectedMaps,
  selectedSteamManifest,
  initialSteamFiles,
  overviewResources,
  dependencyBatch,
  skyPrefabPackage,
  parseSteamListing,
  checkedBatch,
} from './steam-assets-plan.mjs';

import {
  exists,
  fileHash,
  fileHashes,
  readableDirectory,
  regular,
  checkStorage,
  hasFreeReserve,
  checkFreeReserve,
} from './asset-storage.mjs';
import { installLocalWorld } from './native-world-pack.mjs';
import { localDirectory } from './toolchain-security.mjs';
export { validatePreparedMap } from './native-world-pack.mjs';
import { runAssetProcess } from './asset-process.mjs';
export { runAssetProcess } from './asset-process.mjs';
export async function installSteamAssets(options, adapters = {}) {
  const maps = selectedMaps(options.maps);
  const manifest =
    options.manifest === undefined ? undefined : selectedSteamManifest(options.manifest);
  if (
    options.assetVersion !== undefined &&
    (typeof options.assetVersion !== 'string' ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(options.assetVersion))
  )
    throw new Error('Prepared asset version must be a bounded local identifier.');
  if (
    options.expectedMapHashes !== undefined &&
    (!options.expectedMapHashes ||
      typeof options.expectedMapHashes !== 'object' ||
      Array.isArray(options.expectedMapHashes) ||
      Object.keys(options.expectedMapHashes).length !== maps.length ||
      maps.some(
        (map) =>
          typeof options.expectedMapHashes[map] !== 'string' ||
          !/^[a-f0-9]{64}$/.test(options.expectedMapHashes[map]),
      ) ||
      Object.keys(options.expectedMapHashes).some((map) => !maps.includes(map)))
  )
    throw new Error('Expected source hashes must cover exactly the selected maps.');
  if (
    options.expectedMapFiles !== undefined &&
    (!options.expectedMapFiles ||
      typeof options.expectedMapFiles !== 'object' ||
      Array.isArray(options.expectedMapFiles) ||
      Object.keys(options.expectedMapFiles).length !== maps.length ||
      Object.keys(options.expectedMapFiles).some((map) => !maps.includes(map)) ||
      maps.some(
        (map) =>
          !/^[a-f0-9]{40}$/.test(options.expectedMapFiles[map]?.sha1 || '') ||
          !Number.isSafeInteger(options.expectedMapFiles[map]?.bytes) ||
          options.expectedMapFiles[map].bytes < 1 ||
          options.expectedMapFiles[map].bytes > steamAssetLimits.selectedBytes,
      ))
  )
    throw new Error('Expected official source files must cover exactly the selected maps.');
  if (
    options.expectedAddonFiles !== undefined &&
    (!options.expectedAddonFiles ||
      typeof options.expectedAddonFiles !== 'object' ||
      Array.isArray(options.expectedAddonFiles) ||
      Object.keys(options.expectedAddonFiles).some((map) => !maps.includes(map)) ||
      Object.values(options.expectedAddonFiles).some(
        (addon) =>
          !/^[a-f0-9]{40}$/.test(addon?.sha1 || '') ||
          !Number.isSafeInteger(addon?.bytes) ||
          addon.bytes < 1 ||
          addon.bytes > steamAssetLimits.selectedBytes ||
          !/^[1-9]\d{0,19}$/.test(addon?.manifest || ''),
      ))
  )
    throw new Error('Expected official addon files must belong to the selected maps.');
  if (options.onSourceVerified !== undefined && typeof options.onSourceVerified !== 'function')
    throw new Error('Invalid trusted source verification callback.');
  if (!options.output || !options.cache || Boolean(options.s2v) !== Boolean(options.downloader))
    throw new Error(
      'Provide --output and --cache. Supply both --s2v and --downloader to override the verified bootstrap.',
    );
  const output = resolve(options.output),
    cache = resolve(options.cache),
    signal = options.signal;
  if (cache === output || cache.startsWith(output + '/') || output.startsWith(cache + '/'))
    throw new Error('Keep runtime assets and the private download cache in separate directories.');
  await readableDirectory(output);
  await localDirectory(output);
  await localDirectory(cache, true);
  for (const map of maps)
    if (
      (await exists(join(output, map))) ||
      (await exists(join(output, 'overviews', map))) ||
      (await exists(join(output, 'environments', map)))
    )
      throw new Error(
        `Map ${map} is already installed. Choose a new output directory instead of replacing live assets.`,
      );
  signal?.throwIfAborted();
  const progress = (stage, extra = {}) => options.onProgress?.({ stage, ...extra });
  await options.onPhase?.('tools');
  const tools = options.s2v
    ? {
        s2v: resolve(options.s2v),
        downloader: resolve(options.downloader),
        provenance: { format: 1, mode: 'operator-supplied executables' },
      }
    : await (
        adapters.prepareToolchain || (await import('./prepare-toolchain.mjs')).prepareToolchain
      )({ cache: join(cache, 'tools'), signal, onProgress: options.onProgress });
  for (const path of [tools.s2v, tools.downloader]) {
    await regular(path, 512 * 1024 ** 2);
    await access(path, constants.X_OK);
  }
  if (options.s2v)
    tools.provenance.executables = await Promise.all(
      [tools.s2v, tools.downloader].map(async (path) => ({
        file: path,
        sha256: await fileHash(path, 'sha256', 512 * 1024 ** 2),
      })),
    );
  const run = adapters.run || runAssetProcess,
    scan = adapters.scan || scanSource2Dependencies,
    index = adapters.index || readVpkDirectory;
  const runRoot = await mkdtemp(join(cache, 'install-')),
    home = join(runRoot, 'home'),
    temporary = join(runRoot, 'tmp'),
    game = join(cache, 'steam'),
    pins = join(runRoot, 'manifests');
  for (const path of [home, temporary, game, pins]) await localDirectory(path, true);
  let sequence = 0,
    selectedBytes = 0,
    conversionRoot;
  const selections = new Map(),
    permittedPrefabs = new Set(),
    downloads = [],
    installed = [];
  const execute = (command, args, stage, extra = {}) => {
    progress(stage);
    return run(command, args, {
      cwd: runRoot,
      home: command !== tools.downloader && conversionRoot ? join(conversionRoot, '.home') : home,
      temporary:
        command !== tools.downloader && conversionRoot ? join(conversionRoot, '.tmp') : temporary,
      conversionWriteRoots:
        command !== tools.downloader && conversionRoot ? [conversionRoot] : undefined,
      signal,
      log: join(runRoot, `${String(++sequence).padStart(3, '0')}-${stage}.log`),
      storageGuard: () => checkFreeReserve(cache, output),
      ...extra,
    });
  };
  const remember = (records) => {
    for (const record of checkedBatch(records, { prefabs: [...permittedPrefabs] }))
      selections.set(record.selector, Math.max(selections.get(record.selector) ?? 0, record.bytes));
    selectedBytes = [...selections.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (
      selections.size > steamAssetLimits.entries ||
      selectedBytes > steamAssetLimits.selectedBytes
    )
      throw new Error('Cumulative selective download budget exceeded.');
  };
  const download = async (records, stage) => {
    records = checkedBatch(records, { prefabs: [...permittedPrefabs] });
    if (!records.length) return;
    remember(records);
    await checkStorage(
      cache,
      output,
      records.reduce((sum, entry) => sum + entry.bytes, 0) + 64 * 1024 ** 2,
    );
    const byDepot = {};
    for (const record of records)
      (byDepot[record.depot ?? STEAM_DEPOT] ??= []).push(record.selector);
    await writeFile(join(runRoot, 'files.json'), JSON.stringify(byDepot, null, 2), {
      mode: 0o600,
    });
    const result = await execute(
      tools.downloader,
      ['track', STEAM_APP, '--anonymous', '--output', game, '--manifests', pins, '--save-manifest'],
      stage,
      { timeoutMs: 10 * 60 * 1000 },
    );
    const amounts = [
      ...(result.stdout + result.stderr).matchAll(
        /Downloaded (\d+) bytes \((\d+) bytes uncompressed\)/g,
      ),
    ].map((match) => ({ compressed: Number(match[1]), uncompressed: Number(match[2]) }));
    downloads.push({
      stage,
      entries: records.length,
      selectedBytes: records.reduce((sum, entry) => sum + entry.bytes, 0),
      reportedTransfers: amounts,
      storage: await checkStorage(cache, output),
    });
  };
  try {
    await options.onPhase?.('source');
    const initial = initialSteamFiles(maps);
    await checkStorage(cache, output);
    const listed = await execute(
      tools.downloader,
      [
        'ls',
        STEAM_APP,
        manifest ? `${STEAM_DEPOT}:${manifest}` : STEAM_DEPOT,
        '--anonymous',
        '--',
        ...initial,
      ],
      'manifest-preflight',
      { timeoutMs: 120000 },
    );
    const plan = parseSteamListing(listed.stdout, initial),
      assetVersion = options.assetVersion ?? `steam-${STEAM_DEPOT}-${plan.manifest}`;
    if (manifest && plan.manifest !== manifest)
      throw new Error('Selected Steam depot manifest does not match the requested version.');
    for (const map of maps) {
      const expected = options.expectedMapFiles?.[map],
        actual = plan.files.find((file) => file.file === `game/csgo/maps/${map}.vpk`);
      if (expected && (!actual || actual.sha1 !== expected.sha1 || actual.bytes !== expected.bytes))
        throw Object.assign(
          new Error('Official source differs from the selected inventory snapshot.'),
          { code: 'SOURCE_MAP_MISMATCH' },
        );
    }
    await writeFile(
      join(pins, `manifest_${STEAM_DEPOT}.txt`),
      `Content Manifest for Depot ${STEAM_DEPOT}\n\nManifest ID / date     : ${plan.manifest} / pinned by selective preflight\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const mapFiles = new Set(maps.map((map) => `game/csgo/maps/${map}.vpk`));
    const selected = plan.files.map(({ file, bytes }) => ({ selector: file, bytes }));
    // A manifest-scoped cache can already contain this entire batch. Only reuse
    // it after a fresh official listing and a full check of every listed file.
    async function verifySelection() {
      const mapHashes = new Map();
      for (const { file, bytes, sha1 } of plan.files) {
        const path = join(game, file);
        if (!(await exists(path))) return;
        const stat = await regular(path, Number.MAX_SAFE_INTEGER, 0);
        if (stat.size !== bytes) return;
        const needMapHash =
          mapFiles.has(file) && (options.expectedMapHashes || options.onSourceVerified);
        const verified = await fileHashes(path, needMapHash ? ['sha1', 'sha256'] : ['sha1'], bytes);
        if (verified.sha1 !== sha1) return;
        if (needMapHash) mapHashes.set(file, verified.sha256);
      }
      return mapHashes;
    }
    let mapHashes = await verifySelection();
    if (mapHashes) {
      remember(selected);
    } else {
      await download(selected, 'initial-selected-files');
      mapHashes = await verifySelection();
      if (!mapHashes)
        throw Object.assign(new Error('A selected Steam file failed its manifest hash check.'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
    }
    for (const map of maps) {
      const expected = options.expectedMapHashes?.[map];
      const actualHash = mapHashes.get(`game/csgo/maps/${map}.vpk`);
      if (expected && actualHash !== expected)
        throw Object.assign(
          new Error('Official map content does not match its approved source hash.'),
          { code: 'SOURCE_MAP_MISMATCH' },
        );
      if (options.onSourceVerified) {
        const file = plan.files.find((file) => file.file === `game/csgo/maps/${map}.vpk`);
        await options.onSourceVerified({
          map,
          manifest: plan.manifest,
          mapSha256: actualHash,
          sha1: file.sha1,
          bytes: file.bytes,
          ...(options.expectedAddonFiles?.[map] ? { addon: options.expectedAddonFiles[map] } : {}),
        });
        signal?.throwIfAborted();
      }
    }
    for (const map of maps) {
      const main = `game/csgo/maps/${map}.vpk`;
      // A map whose content ships as an official community addon fetches that exact VPK from
      // the platform depot at the manifest its inventory recorded.
      const addon = options.expectedAddonFiles?.[map];
      const addonFile = addon && addonPackage(map);
      if (addon) {
        const listing = await execute(
          tools.downloader,
          [
            'ls',
            STEAM_APP,
            `${STEAM_ADDON_DEPOT}:${addon.manifest}`,
            '--anonymous',
            '--',
            addonFile,
          ],
          'addon-preflight',
          { timeoutMs: 120000 },
        );
        const pinned = parseSteamListing(listing.stdout, [addonFile], STEAM_ADDON_DEPOT);
        const entry = pinned.files[0];
        if (
          pinned.manifest !== addon.manifest ||
          entry.sha1 !== addon.sha1 ||
          entry.bytes !== addon.bytes
        )
          throw Object.assign(
            new Error('Official addon differs from the selected inventory snapshot.'),
            {
              code: 'SOURCE_MAP_MISMATCH',
            },
          );
        const pin = join(pins, `manifest_${STEAM_ADDON_DEPOT}.txt`);
        if (!(await exists(pin)))
          await writeFile(
            pin,
            `Content Manifest for Depot ${STEAM_ADDON_DEPOT}\n\nManifest ID / date     : ${addon.manifest} / pinned by selective preflight\n`,
            { flag: 'wx', mode: 0o600 },
          );
        const local = join(game, addonFile);
        const current =
          (await exists(local)) && (await fileHash(local, 'sha1', steamAssetLimits.selectedBytes));
        if (current !== addon.sha1) {
          await download(
            [{ selector: addonFile, bytes: addon.bytes, depot: STEAM_ADDON_DEPOT }],
            'addon',
          );
          if ((await fileHash(local, 'sha1', addon.bytes)) !== addon.sha1)
            throw Object.assign(
              new Error('A selected Steam file failed its manifest hash check.'),
              {
                code: 'SOURCE_MAP_MISMATCH',
              },
            );
        } else remember([{ selector: addonFile, bytes: addon.bytes, depot: STEAM_ADDON_DEPOT }]);
      }
      const scanPackage = async (packageFile, required) => {
        for (let wave = 0; wave <= steamAssetLimits.waves; wave++) {
          const closure = await scan({
            mapVpk: join(game, packageFile),
            ...(addonFile ? { addonVpk: join(game, addonFile) } : {}),
            csgoVpk: join(game, 'game/csgo/pak01_dir.vpk'),
            coreVpk: join(game, 'game/core/pak01_dir.vpk'),
            looseRoots: [join(game, 'game/csgo'), join(game, 'game/core')],
            required,
          });
          const records = dependencyBatch(closure, map, { packageFile });
          if (!records.length) return closure;
          if (wave === steamAssetLimits.waves)
            throw Error('Native dependency scan exceeded its wave limit.');
          await download(records, `${map}-dependencies-${wave}`);
        }
      };
      const closure = await scanPackage(main, overviewResources(map));
      for (const resource of closure.unknown.filter(
        (name) =>
          (name.startsWith('maps/prefabs/') || /^maps\/[a-z0-9_]{1,100}\.vmap_c$/.test(name)) &&
          name.endsWith('.vmap_c'),
      )) {
        // Only prefabs inside the selected map's folder, or a top-level companion named after
        // the map, can be fetched; the exporter reports a 3D sky that names any other.
        let file;
        try {
          ({ file } = skyPrefabPackage(map, resource.slice(0, -2)));
        } catch {
          continue;
        }
        // An addon may embed the sky as a nested single-file VPK. Its CRC-checked bytes are
        // written beside the addon, where the exporter mounts it.
        if (addonFile) {
          const nested = addonPrefabPackage(map, resource.slice(0, -2));
          const index = await readVpkDirectory(join(game, addonFile));
          const entry = index.entries.get(nested.entry);
          if (entry) {
            await download(
              [
                {
                  selector: `${addonFile}:${nested.entry}`,
                  bytes: entry.length + entry.preloadBytes,
                  depot: STEAM_ADDON_DEPOT,
                },
              ],
              'addon-sky',
            );
            const bytes = await index.readEntry(nested.entry);
            if (!bytes) throw Error('Addon sky prefab digest differs.');
            await mkdir(join(game, nested.file, '..'), { recursive: true, mode: 0o700 });
            await writeFile(join(game, nested.file), bytes, { mode: 0o600 });
            await scanPackage(nested.file, []);
            continue;
          }
        }
        const listing = await execute(
          tools.downloader,
          ['ls', STEAM_APP, `${STEAM_DEPOT}:${plan.manifest}`, '--anonymous', '--', file],
          'prefab-preflight',
          { allowFailure: true },
        );
        // A referenced 3D sky that the pinned manifest lacks is exported without it.
        if (
          listing.code !== 0 &&
          (listing.stdout + listing.stderr).includes(
            `"${file}" matched nothing in ${STEAM_DEPOT}:${plan.manifest}.`,
          )
        )
          continue;
        if (listing.code !== 0) throw Error('Sky prefab listing failed.');
        permittedPrefabs.add(file);
        const pinned = parseSteamListing(listing.stdout, [file]);
        if (pinned.manifest !== plan.manifest) throw Error('Sky prefab manifest changed.');
        const entry = pinned.files[0];
        await download([{ selector: file, bytes: entry.bytes }], 'sky-prefab');
        if ((await fileHash(join(game, file), 'sha1', entry.bytes)) !== entry.sha1)
          throw Error('Sky prefab digest differs.');
        await scanPackage(file, []);
      }
      const actual = await fileHash(join(game, main), 'sha256', steamAssetLimits.selectedBytes);
      await installLocalWorld({
        ...options,
        maps: [map],
        manifest: plan.manifest,
        gameRoot: join(game, 'game'),
        expectedMapHashes: { [map]: actual },
        onSourceVerified: undefined,
        cache,
        output,
      });
      installed.push({ map, assetVersion });
    }
    progress('complete', { maps, selectedBytes });
    return {
      maps: installed,
      selectedBytes,
      report: join(runRoot, 'installation.json'),
      cache: game,
    };
  } catch (error) {
    await writeFile(
      join(runRoot, 'failure.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          stage: 'operator asset installation',
          detail: error.message,
          installed: installed.map((entry) => entry.map),
          logs: runRoot,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    const { values } = parseArgs({
      options: {
        maps: { type: 'string' },
        manifest: { type: 'string' },
        output: { type: 'string' },
        cache: { type: 'string' },
        s2v: { type: 'string' },
        downloader: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'Usage: npm --prefix tools/assets run install-steam -- --maps de_mirage,de_dust2 --output /data/maps --cache /operator/private-cache [--manifest PINNED_UINT64] [--s2v /path/Source2Viewer-CLI --downloader /path/SteamFileDownloader]',
      );
    else
      console.log(
        JSON.stringify(
          await installSteamAssets({
            ...values,
            signal: controller.signal,
            onProgress: ({ stage, map, wave }) =>
              console.error(
                [stage, map, wave === undefined ? '' : `wave ${wave}`].filter(Boolean).join(' '),
              ),
          }),
          null,
          2,
        ),
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
