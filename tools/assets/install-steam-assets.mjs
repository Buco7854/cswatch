#!/usr/bin/env node
/** Explicit operator action only. Anonymous fixed-depot downloads, never an app route. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareOverview } from './prepare-overview.mjs';
import { readVpkDirectory, scanSource2Dependencies } from './source2-dependencies.mjs';
import {
  STEAM_APP,
  STEAM_DEPOT,
  steamAssetLimits,
  selectedMaps,
  selectedSteamManifest,
  initialSteamFiles,
  overviewResources,
  parseSteamListing,
  checkedBatch,
} from './steam-assets-plan.mjs';

import {
  exists,
  fileHash,
  readableDirectory,
  regular,
  checkStorage,
  checkFreeReserve,
} from './asset-storage.mjs';
import { publishPreparedMap } from './prepared-map-publication.mjs';
import { resolveMapResources, exportMapGltf } from './install-map-resources.mjs';
import { inspectInstalledEnvironment } from './install-map-environment.mjs';
import { prepareInstalledAtmosphere } from './install-map-atmosphere.mjs';
import { localDirectory } from './toolchain-security.mjs';
export { publishPreparedMap, validatePreparedMap } from './prepared-map-publication.mjs';

const prepareMapScript = fileURLToPath(new URL('./prepare-map.mjs', import.meta.url));
/** Trusted local executables only. Bounded diagnostics remain in private cache logs.
 * Output callbacks are trusted, cooperative work: onOutputAbort must cancel their
 * pending mutations. A deadline requests cancellation; safe cleanup still awaits
 * their drain rather than allowing a late callback to write into removed scratch.
 */
export async function runAssetProcess(
  command,
  args,
  {
    cwd,
    home,
    temporary,
    signal,
    log,
    storageGuard,
    onOutputLine,
    onOutputAbort,
    allowFailure = false,
    timeoutMs = 30 * 60 * 1000,
  },
) {
  signal?.throwIfAborted();
  await storageGuard?.();
  signal?.throwIfAborted();
  return await new Promise((resolveJob, rejectJob) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: home,
        TMPDIR: temporary,
        LANG: 'C.UTF-8',
        TZ: 'UTC',
        NO_COLOR: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
        DOTNET_EnableDiagnostics: '0',
        // Bound managed heap growth while leaving room for native texture work.
        // .NET environment numeric settings use hexadecimal: 0x100000000 = 4 GiB.
        // This is not a total RSS limit; operators still need host memory limits.
        DOTNET_GCHeapHardLimit: '100000000',
        DOTNET_GCConserveMemory: '9',
      },
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure,
      ended = false,
      guardPending;
    const lineBuffers = { stdout: '', stderr: '' },
      outputPending = new Set();
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const stop = () => {
      failure ||= new Error('Operator asset installation was cancelled.');
      onOutputAbort?.();
      if (!ended) kill();
    };
    const timer = setTimeout(() => {
      failure ||= new Error('Operator asset stage timed out.');
      onOutputAbort?.();
      if (!ended) kill();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const guardTimer = storageGuard
      ? setInterval(() => {
          if (guardPending || ended) return;
          guardPending = Promise.resolve()
            .then(storageGuard)
            .catch((error) => {
              failure ||=
                error instanceof Error ? error : new Error('Operator asset storage guard failed.');
              onOutputAbort?.();
              if (!ended) kill();
            })
            .finally(() => {
              guardPending = undefined;
            });
        }, 250)
      : undefined;
    const dispatchLine = (line, kind) => {
      if (!onOutputLine || failure) return;
      try {
        const work = onOutputLine(line, kind);
        if (work && typeof work.then === 'function') {
          const tracked = Promise.resolve(work)
            .catch((error) => {
              failure ||=
                error instanceof Error ? error : new Error('Operator output processing failed.');
              onOutputAbort?.();
              if (!ended) kill();
            })
            .finally(() => outputPending.delete(tracked));
          outputPending.add(tracked);
        }
      } catch (error) {
        failure ||=
          error instanceof Error ? error : new Error('Operator output processing failed.');
        onOutputAbort?.();
        if (!ended) kill();
      }
    };
    const appendDecoded = (kind, decoded) => {
      if (kind === 'stdout') stdout += decoded;
      else stderr += decoded;
      if (onOutputLine) {
        lineBuffers[kind] += decoded;
        let newline;
        while ((newline = lineBuffers[kind].indexOf('\n')) !== -1) {
          dispatchLine(lineBuffers[kind].slice(0, newline).replace(/\r$/, ''), kind);
          lineBuffers[kind] = lineBuffers[kind].slice(newline + 1);
        }
      }
    };
    const append = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > steamAssetLimits.logBytes) {
        failure ||= new Error('Operator asset diagnostics exceeded the output limit.');
        onOutputAbort?.();
        kill();
        return;
      }
      appendDecoded(kind, decoders[kind].write(chunk));
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => {
      failure ||= error;
    });
    child.once('close', async (code, exitSignal) => {
      ended = true;
      clearInterval(guardTimer);
      kill();
      try {
        // Finish the one in-flight check before deciding whether this stage can
        // succeed. No late guard can mutate the result or kill another stage.
        await guardPending;
        for (const kind of ['stdout', 'stderr']) {
          appendDecoded(kind, decoders[kind].end());
          if (lineBuffers[kind]) dispatchLine(lineBuffers[kind], kind);
        }
        await Promise.all([...outputPending]);
        if (log)
          await writeFile(
            log,
            stdout +
              stderr +
              `\nOperator process exit: ${code ?? 'none'}, signal: ${exitSignal ?? 'none'}\n`,
            { mode: 0o600, flag: 'wx' },
          );
        if (failure) throw failure;
        if (code !== 0 && !allowFailure)
          throw new Error(
            `Operator asset stage failed with exit ${code ?? 'none'}, signal ${exitSignal ?? 'none'}. See ${log || 'the private cache log'}.`,
          );
        resolveJob({ code, signal: exitSignal, stdout, stderr });
      } catch (error) {
        rejectJob(error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    });
    if (signal?.aborted) stop();
  });
}

export async function installSteamAssets(options, adapters = {}) {
  const maps = selectedMaps(options.maps);
  const manifest =
    options.manifest === undefined ? undefined : selectedSteamManifest(options.manifest);
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
    selectedBytes = 0;
  const selections = new Map(),
    permittedPrefabs = new Set(),
    downloads = [],
    installed = [];
  const execute = (command, args, stage, extra = {}) => {
    progress(stage);
    return run(command, args, {
      cwd: runRoot,
      home,
      temporary,
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
    await writeFile(
      join(runRoot, 'files.json'),
      JSON.stringify({ [STEAM_DEPOT]: records.map((record) => record.selector) }, null, 2),
      { mode: 0o600 },
    );
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
      assetVersion = `steam-${STEAM_DEPOT}-${plan.manifest}`;
    if (manifest && plan.manifest !== manifest)
      throw new Error('Selected Steam depot manifest does not match the requested version.');
    await writeFile(
      join(pins, `manifest_${STEAM_DEPOT}.txt`),
      `Content Manifest for Depot ${STEAM_DEPOT}\n\nManifest ID / date     : ${plan.manifest} / pinned by selective preflight\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await download(
      plan.files.map((file) => ({ selector: file.file, bytes: file.bytes })),
      'initial-selected-files',
    );
    for (const file of plan.files)
      if ((await fileHash(join(game, file.file), 'sha1', file.bytes)) !== file.sha1)
        throw new Error('A selected Steam file failed its manifest hash check.');
    const shaderIndexes = await Promise.all(
      ['csgo', 'core'].map(async (group) => [
        group,
        await index(join(game, 'game', group, 'shaders_vulkan_dir.vpk')),
      ]),
    );
    for (const map of maps) {
      const stage = await mkdtemp(join(runRoot, `${map}-`));
      try {
        const packageFile = `game/csgo/maps/${map}.vpk`;
        const shaderPreflights = [];
        const onShaderPreflight = (report) => shaderPreflights.push(report);
        const sourceImages = [];
        const onSourceImages = async ({ part, attempt, report }) => {
          const data = Buffer.from(JSON.stringify(report));
          if (data.length > 4 * 1024 ** 2)
            throw new Error('Source image provenance exceeds its bound.');
          const file = `${part}-source-images-${attempt}.json`;
          await checkFreeReserve(cache, output, data.length);
          await writeFile(join(runRoot, file), data, { flag: 'wx', mode: 0o600 });
          sourceImages.push({
            part,
            attempt,
            file,
            sha256: createHash('sha256').update(data).digest('hex'),
            maxEdge: report.maxEdge,
            images: report.images.length,
            inputBytes: report.inputBytes,
            outputBytes: report.outputBytes,
            readBytes: report.readBytes,
          });
        };
        const sourceDescription = `Valve CS2 app ${STEAM_APP}, depot ${STEAM_DEPOT}, manifest ${plan.manifest}, operator-local S2V export`;
        const environment = await (adapters.inspectEnvironment || inspectInstalledEnvironment)({
          map,
          game,
          stage,
          assetVersion,
          manifest: plan.manifest,
          source: sourceDescription,
          s2v: tools.s2v,
          downloader: tools.downloader,
          execute,
          download,
          index,
          scan,
          shaderIndexes,
          progress,
          onShaderPreflight,
          onSourceImages,
          storage: (needed) => checkStorage(cache, output, needed),
          permitPrefab: (file) => {
            if (!file.startsWith(`game/csgo/maps/prefabs/${map}/`))
              throw new Error('Sky prefab is outside the selected map.');
            checkedBatch([{ selector: file, bytes: 0 }], { prefabs: [file] });
            permittedPrefabs.add(file);
          },
        });
        const closure = await resolveMapResources({
          map,
          packageFile,
          game,
          required: [...overviewResources(map), ...environment.required],
          skyMap: environment.skyMap,
          scan,
          download,
          progress,
          label: map,
        });
        let source = await exportMapGltf({
          map,
          packageFile,
          resource: `maps/${map}.vmap_c`,
          game,
          stage,
          label: map,
          closure,
          s2v: tools.s2v,
          execute,
          download,
          shaderIndexes,
          index,
          onShaderPreflight,
          onSourceImages,
          storage: (needed) => checkStorage(cache, output, needed),
        });
        const overviewExport = join(stage, 'overview-source');
        await mkdir(overviewExport);
        await execute(
          tools.s2v,
          [
            '-i',
            join(game, 'game/csgo/pak01_dir.vpk'),
            '-f',
            overviewResources(map).join(','),
            '--vpk_decompile',
            '-o',
            overviewExport + '/',
          ],
          `${map}-overview`,
        );
        const prepared = join(stage, 'prepared');
        await prepareOverview({
          image: join(overviewExport, 'panorama/images/overheadmaps', `${map}_radar_psd.png`),
          overview: join(overviewExport, 'resource/overviews', `${map}.txt`),
          output: prepared,
          map,
          version: assetVersion,
          source: sourceDescription,
        });
        const preparedEnvironment = await environment.prepare(source, prepared);
        source = preparedEnvironment.mergedInput;
        const atmosphere = await (adapters.prepareAtmosphere || prepareInstalledAtmosphere)({
          map,
          input: source,
          stage,
          prepared,
          assetVersion,
          game,
          s2v: tools.s2v,
          index,
          download,
          execute,
          packageFiles: [
            packageFile,
            preparedEnvironment.report.selectedPrefab,
            'game/csgo/pak01_dir.vpk',
            'game/core/pak01_dir.vpk',
          ],
        });
        source = atmosphere.path;
        // The packer checks each actual encoded tier plus the reserve immediately
        // before its exclusive write. Source PNG sizes do not predict GLB bytes.
        await checkStorage(cache, output);
        await execute(
          process.execPath,
          [
            prepareMapScript,
            '--input',
            source,
            '--output',
            prepared,
            '--map',
            map,
            '--asset-version',
            assetVersion,
          ],
          `${map}-pack`,
        );
        const provenance = {
          schemaVersion: 1,
          app: STEAM_APP,
          depot: STEAM_DEPOT,
          manifest: plan.manifest,
          map,
          assetVersion,
          tools: tools.provenance,
          sourceVpks: closure.sources,
          unknownNonRenderingResources: closure.unknown.filter(
            (resource) => resource !== `${environment.skyMap}_c`,
          ),
          resolvedExternalSky: environment.skyMap,
          shaderPreflights,
          sourceImagePreparation: sourceImages,
          resourceCoverage: {
            complete:
              closure.unknown.filter((resource) => resource !== `${environment.skyMap}_c`)
                .length === 0 &&
              preparedEnvironment.report.unknownNonRenderingResources.length === 0,
            remainingUnsupported: [
              ...new Set([
                ...closure.unknown.filter((resource) => resource !== `${environment.skyMap}_c`),
                ...preparedEnvironment.report.unknownNonRenderingResources,
              ]),
            ],
          },
          environment: preparedEnvironment.report,
          atmosphere: atmosphere.report,
          caveats: [
            'Sky landscape is merged offline and the prepared sky uses recorded settings; lighting, HDR range, game scripts and material blending still differ from Source 2.',
            'Operator must verify coordinate alignment and browser performance for this map version.',
          ],
          downloads,
          selectedBytes,
          preparedAt: new Date().toISOString(),
        };
        progress('publish', { map });
        installed.push(await publishPreparedMap(prepared, output, map, assetVersion, provenance));
        await writeFile(
          join(runRoot, 'installation.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              app: STEAM_APP,
              depot: STEAM_DEPOT,
              manifest: plan.manifest,
              installed,
              downloads,
              selectedBytes,
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
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
