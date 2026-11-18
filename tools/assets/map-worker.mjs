#!/usr/bin/env node
/** Optional official-asset worker. Mount jobs, catalog, assets and disposable
 * cache only. This process never receives application data or credentials. */
import { constants } from 'node:fs';
import {
  open,
  opendir,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalMapApproval,
  mapPackId,
  readMapCatalog,
  resolveMap,
} from '../../backend/dist/map-catalog.js';
import {
  mapJobLimits,
  mapJobTemporaryName,
  prepareMapJobs,
  readMapRequest,
  readMapResult,
  writeMapJobResult,
  writeMapWorkerStatus,
} from '../../backend/dist/map-jobs.js';
import {
  withDirectory,
  regularFile,
  bytesFrom,
  fileVersion,
} from '../../backend/dist/map-asset-files.js';
import { localDirectory } from './toolchain-security.mjs';
import {
  allocatedStorage,
  checkFreeReserve,
  exists,
  readableDirectory,
  regular,
} from './asset-storage.mjs';
import {
  installSteamAssets,
  runAssetProcess,
  validatePreparedMap,
} from './install-steam-assets.mjs';
import { prepareToolchain } from './prepare-toolchain.mjs';
import { selectedSteamManifest } from './steam-assets-plan.mjs';

export const mapWorkerLimits = Object.freeze({
  deadlineMs: 45 * 60 * 1000,
  cacheBytes: 16 * 1024 ** 3,
  assetBytes: 32 * 1024 ** 3,
  keepSources: 2,
  attempts: 3,
});
const sourceMarker = '.cswatch-official-source.json';
const defaultNetworkDeny = fileURLToPath(new URL('./bin/asset-network-deny', import.meta.url));
const now = () => Math.floor(Date.now() / 1000);

export function mapWorkerOptions(env = process.env) {
  const options = {
    jobs: resolve(env.MAP_JOBS_DIR || '/map-jobs'),
    assets: resolve(env.MAP_ASSETS_DIR || '/map-assets'),
    catalog: resolve(env.MAP_CATALOG_FILE || '/map-catalog/catalog.json'),
    cache: resolve(env.MAP_CACHE_DIR || '/map-cache'),
    networkDeny: resolve(env.CSWATCH_ASSET_NETWORK_DENY || defaultNetworkDeny),
  };
  const roots = [options.jobs, options.assets, options.cache];
  if (
    roots.includes('/') ||
    roots.some((root) => options.catalog === root || options.catalog.startsWith(root + '/'))
  )
    throw Error('Map storage roots and the readonly approval catalog must remain separate.');
  if (
    roots.some((root, index) =>
      roots.some(
        (other, otherIndex) =>
          index !== otherIndex && (root === other || root.startsWith(other + '/')),
      ),
    )
  )
    throw Error('Map jobs, assets and disposable cache require separate directories.');
  return options;
}

/** Linux flock locks the inherited open-file description. Parent ownership
 * keeps the lock alive after the tiny flock child exits, and crashes release it. */
export async function lockMapWorker(jobs) {
  await prepareMapJobs(jobs);
  return withDirectory(jobs, ['locks'], async (directory) => {
    const file = await open(
      `/proc/self/fd/${directory.fd}/worker.lock`,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    let keep = false;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || stat.mode & 0o022)
        throw Error('Unsafe asset-worker lock.');
      const result = spawnSync('flock', ['-n', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
        timeout: 5000,
      });
      if (result.error || result.status !== 0) return;
      keep = true;
      return () => file.close();
    } finally {
      if (!keep) await file.close();
    }
  });
}

async function requests(jobs) {
  return (
    (await withDirectory(jobs, ['requests'], async (directory) => {
      const folder = await opendir(`/proc/self/fd/${directory.fd}`),
        ids = [];
      let scanned = 0;
      for await (const entry of folder) {
        if (++scanned > mapJobLimits.scanned) throw Error('Map queue scan limit reached.');
        if (entry.isFile() && mapJobTemporaryName.test(entry.name)) continue;
        if (
          ids.length >= mapJobLimits.retained ||
          !entry.isFile() ||
          !/^[a-f0-9]{64}\.json$/.test(entry.name)
        )
          throw Error('Unexpected map queue entry.');
        ids.push(entry.name.slice(0, -5));
      }
      return ids.sort();
    })) || []
  );
}
async function approved(catalogFile, request) {
  const catalog = await readMapCatalog(catalogFile);
  const resolution = resolveMap(request.approval.identity, catalog);
  return (
    resolution.status === 'approved' &&
    resolution.packId === request.packId &&
    canonicalMapApproval(resolution.approval) === canonicalMapApproval(request.approval)
  );
}

async function reserveAttempt(jobs, request) {
  const generation = request.generation || 'initial';
  const reserved = await withDirectory(jobs, ['locks'], async (directory) => {
    const name = `${request.packId}.attempts.json`;
    let count = 0;
    try {
      const file = await regularFile(directory, name, 2, 2048);
      if (!file) throw Error('Invalid map attempt ledger.');
      try {
        const before = await fileVersion(file);
        const data = JSON.parse(
          (await bytesFrom(file, (await file.stat()).size, 2048)).toString('utf8'),
        );
        if (
          before !== (await fileVersion(file)) ||
          data.schemaVersion !== 1 ||
          data.packId !== request.packId ||
          !/^(?:initial|[a-f0-9]{32})$/.test(data.generation) ||
          !Number.isInteger(data.attempts) ||
          data.attempts < 1 ||
          data.attempts > mapWorkerLimits.attempts
        )
          throw Error('Invalid map attempt ledger.');
        if (data.generation === generation) count = data.attempts;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (count >= mapWorkerLimits.attempts) return false;
    const temporary = `.${request.packId}-${randomBytes(12).toString('hex')}.tmp`;
    const path = `/proc/self/fd/${directory.fd}/${temporary}`;
    let file;
    try {
      file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          packId: request.packId,
          generation,
          attempts: count + 1,
        }),
      );
      await file.sync();
      await file.close();
      file = undefined;
      await rename(path, `/proc/self/fd/${directory.fd}/${name}`);
      await directory.sync();
      return true;
    } finally {
      await file?.close();
      await rm(path, { force: true });
    }
  });
  return reserved === true;
}

/** Only folders carrying our exact marker may be reclaimed. Published packs
 * and arbitrary operator directories are never cache-cleanup candidates. */
export async function sourceCache(options, manifest) {
  selectedSteamManifest(manifest);
  const sources = join(options.cache, 'sources');
  await localDirectory(sources, true);
  const current = join(sources, `steam-${manifest}`);
  const candidates = [];
  const folder = await opendir(sources);
  for await (const entry of folder) {
    if (!entry.isDirectory() || !/^steam-[1-9][0-9]{0,19}$/.test(entry.name)) continue;
    const directory = join(sources, entry.name);
    const marker = join(directory, sourceMarker);
    try {
      await localDirectory(directory);
      await regular(marker, 256);
      const content = await readFile(marker, 'utf8');
      const data = JSON.parse(content);
      if (
        data.schemaVersion !== 1 ||
        data.manifest !== entry.name.slice(6) ||
        data.appId !== 730 ||
        data.depotId !== 2347770
      )
        continue;
      selectedSteamManifest(data.manifest);
      if (
        content !==
        JSON.stringify({ schemaVersion: 1, appId: 730, depotId: 2347770, manifest: data.manifest })
      )
        continue;
      candidates.push({ directory, modified: (await lstat(marker)).mtimeMs });
    } catch {
      /* An unrecognized operator folder is never deleted. */
    }
  }
  const other = candidates
    .filter((item) => item.directory !== current)
    .sort((a, b) => b.modified - a.modified);
  const cacheSize = (await allocatedStorage(options.cache)).physicalBytes;
  const keep = cacheSize > mapWorkerLimits.cacheBytes / 2 ? 0 : mapWorkerLimits.keepSources - 1;
  for (const item of other.slice(keep)) await rm(item.directory, { recursive: true, force: true });
  const alreadyPresent = await exists(current);
  if (alreadyPresent && !(await exists(join(current, sourceMarker))))
    throw Error('Existing source cache is not owned by this worker.');
  await localDirectory(current, true);
  const marker = join(current, sourceMarker),
    data = JSON.stringify({ schemaVersion: 1, appId: 730, depotId: 2347770, manifest });
  try {
    await writeFile(marker, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await regular(marker, 256);
    if ((await readFile(marker, 'utf8')) !== data) throw Error('Source cache provenance mismatch.');
  }
  return current;
}

const preparationMarker = (packId) =>
  JSON.stringify({ schemaVersion: 1, packId, kind: 'cswatch-official-map-preparation' });

/** Call only while holding the worker flock, after confined converters have
 * exited. Exact markers distinguish our interrupted scratch from operator data. */
export async function cleanMapPreparations(options) {
  const packs = join(options.assets, 'packs');
  if (!(await exists(packs))) return;
  await localDirectory(packs);
  const directory = await opendir(packs);
  let inspected = 0;
  for await (const entry of directory) {
    if (++inspected > 1024) throw Error('Prepared map directory count limit reached.');
    const match = /^\.preparing-([a-f0-9]{64})-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const path = join(packs, entry.name),
      marker = join(path, '.preparation.json');
    try {
      await localDirectory(path);
      await regular(marker, 256);
      if ((await readFile(marker, 'utf8')) !== preparationMarker(match[1])) continue;
    } catch {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
}

async function budgets(options) {
  const [cache, assets] = await Promise.all([
    allocatedStorage(options.cache),
    allocatedStorage(options.assets),
  ]);
  if (
    cache.physicalBytes > mapWorkerLimits.cacheBytes ||
    assets.physicalBytes > mapWorkerLimits.assetBytes
  )
    throw Object.assign(Error('Official map storage limit reached.'), {
      code: 'ASSET_STORAGE_LIMIT',
    });
  await checkFreeReserve(options.cache, options.assets);
}
export function mapFailureCode(error, signal) {
  if (signal?.aborted) return 'worker_interrupted';
  if (error?.code === 'SOURCE_MAP_MISMATCH') return 'source_mismatch';
  if (error?.code === 'ASSET_ATTEMPTS_EXHAUSTED') return 'worker_interrupted';
  if (error?.code === 'STEAM_SOURCE_UNAVAILABLE') return 'source_unavailable';
  if (error?.code === 'APPROVAL_REMOVED') return 'approval_removed';
  if (
    error?.code === 'ASSET_STORAGE_LIMIT' ||
    /free disk space|storage limit|disk quota|ENOSPC/i.test(error?.message || '')
  )
    return 'storage_limit';
  if (
    /manifest request code|selected map.*absent|Steam.*unavailable|selected Steam file.*hash/i.test(
      error?.message || '',
    )
  )
    return 'source_unavailable';
  return 'preparation_failed';
}

async function validatePack(root, request, validate) {
  const marker = join(root, 'pack.json');
  await regular(marker, 16384);
  const data = JSON.parse(await readFile(marker, 'utf8'));
  if (
    data.schemaVersion !== 1 ||
    data.packId !== request.packId ||
    data.approval !== canonicalMapApproval(request.approval)
  )
    throw Error('Prepared pack approval differs.');
  const version =
    request.approval.assetVersion || `steam-2347770-${request.approval.source.manifest}`;
  await validate(join(root, 'maps'), request.approval.identity.map, version);
}

/** Caller holds the single-worker lock. Test adapters replace conversion, never
 * request validation, current catalog approval or publication ownership. */
export async function processOneMapRequest(options, adapters = {}) {
  const validate = adapters.validate || validatePreparedMap;
  for (const packId of await requests(options.jobs)) {
    const request = await readMapRequest(options.jobs, packId);
    if (!request) continue;
    const previous = await readMapResult(options.jobs, packId);
    if (previous && previous.status !== 'processing') continue;
    let staging;
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(mapWorkerLimits.deadlineMs)])
      : AbortSignal.timeout(mapWorkerLimits.deadlineMs);
    const result = (status, code) =>
      writeMapJobResult(options.jobs, {
        schemaVersion: 1,
        packId,
        status,
        updatedAt: now(),
        ...(code ? { code } : {}),
      });
    try {
      if (!(await approved(options.catalog, request)))
        throw Object.assign(Error('Approval removed.'), { code: 'APPROVAL_REMOVED' });
      signal.throwIfAborted();
      await result('processing');
      await writeMapWorkerStatus(options.jobs, {
        schemaVersion: 1,
        status: 'processing',
        updatedAt: now(),
      });
      const packs = join(options.assets, 'packs'),
        target = join(packs, packId);
      await readableDirectory(packs);
      await localDirectory(packs);
      if (await exists(target)) {
        await localDirectory(target);
        await validatePack(target, request, validate);
      } else {
        if (!(await reserveAttempt(options.jobs, request)))
          throw Object.assign(Error('Map preparation restart budget exhausted.'), {
            code: 'ASSET_ATTEMPTS_EXHAUSTED',
          });
        const cache = await sourceCache(options, request.approval.source.manifest);
        await budgets(options);
        staging = await mkdtemp(join(packs, `.preparing-${packId}-`));
        await writeFile(join(staging, '.preparation.json'), preparationMarker(packId), {
          flag: 'wx',
          mode: 0o600,
        });
        const prepare = adapters.prepare || installSteamAssets;
        const approval = request.approval;
        let tools;
        await prepare(
          {
            maps: [approval.identity.map],
            manifest: approval.source.manifest,
            assetVersion: approval.assetVersion,
            expectedMapHashes: { [approval.identity.map]: approval.source.mapSha256 },
            output: join(staging, 'maps'),
            cache,
            signal,
          },
          {
            prepareToolchain: async ({ signal, onProgress }) => {
              tools = await prepareToolchain({
                cache: join(options.cache, 'tools'),
                signal,
                onProgress,
              });
              return tools;
            },
            run: async (command, args, context) => {
              if (!(await approved(options.catalog, request)))
                throw Object.assign(Error('Approval removed.'), { code: 'APPROVAL_REMOVED' });
              await budgets(options);
              let executable = command,
                arguments_ = args;
              if (command === tools?.s2v || command === process.execPath) {
                executable = options.networkDeny || defaultNetworkDeny;
                await regular(executable, 1024 * 1024);
                if (
                  !Array.isArray(context.conversionWriteRoots) ||
                  !context.conversionWriteRoots.length ||
                  context.conversionWriteRoots.length > 3
                )
                  throw Error('Conversion stage has no confined writable roots.');
                arguments_ = [
                  ...context.conversionWriteRoots.flatMap((root) => ['--write-root', root]),
                  '--',
                  command,
                  ...args,
                ];
              } else if (command !== tools?.downloader)
                throw Error('Unrecognized asset preparation command.');
              try {
                return await runAssetProcess(executable, arguments_, {
                  ...context,
                  storageGuard: async () => {
                    await context.storageGuard?.();
                    await checkFreeReserve(options.cache, options.assets);
                  },
                });
              } catch (error) {
                if (command === tools?.downloader && context.log) {
                  try {
                    await regular(context.log, 4 * 1024 ** 2);
                    const log = await readFile(context.log, 'utf8');
                    if (
                      /manifest request code|failed to (?:get|download).*manifest|manifest.*(?:unavailable|not available|access denied)/i.test(
                        log,
                      )
                    )
                      error.code = 'STEAM_SOURCE_UNAVAILABLE';
                  } catch {
                    /* Public results never include private native diagnostics. */
                  }
                }
                throw error;
              }
            },
          },
        );
        signal.throwIfAborted();
        const version = approval.assetVersion || `steam-2347770-${approval.source.manifest}`;
        await validate(join(staging, 'maps'), approval.identity.map, version);
        await writeFile(
          join(staging, 'pack.json'),
          JSON.stringify({
            schemaVersion: 1,
            packId,
            approval: canonicalMapApproval(approval),
            preparedAt: now(),
          }) + '\n',
          { flag: 'wx', mode: 0o644 },
        );
        await chmod(staging, 0o755);
        await validatePack(staging, request, validate);
        if (!(await approved(options.catalog, request)))
          throw Object.assign(Error('Approval removed.'), { code: 'APPROVAL_REMOVED' });
        await budgets(options);
        const publication = spawnSync(
          options.networkDeny || defaultNetworkDeny,
          ['--publish', staging, target],
          { stdio: 'ignore', timeout: 10000 },
        );
        if (publication.error || publication.status !== 0)
          throw Error('Exclusive prepared map publication failed.');
        staging = undefined;
      }
      if (!(await approved(options.catalog, request)))
        throw Object.assign(Error('Approval removed.'), { code: 'APPROVAL_REMOVED' });
      signal.throwIfAborted();
      await result('ready');
      options.log?.({ event: 'map.ready', packId });
    } catch (error) {
      const code = mapFailureCode(error, signal);
      await result('failed', code);
      options.log?.({ event: 'map.failed', packId, code });
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
      await writeMapWorkerStatus(options.jobs, {
        schemaVersion: 1,
        status: 'idle',
        updatedAt: now(),
      });
    }
    return true;
  }
  return false;
}

export async function runMapWorker(options) {
  await localDirectory(options.jobs, true);
  await readableDirectory(options.assets);
  await localDirectory(options.assets);
  await localDirectory(options.cache, true);
  const networkDeny = options.networkDeny || defaultNetworkDeny;
  await regular(networkDeny, 1024 * 1024);
  const probeRoot = await mkdtemp(join(options.cache, '.confinement-probe-'));
  const probe = spawnSync(
    networkDeny,
    ['--write-root', probeRoot, '--', process.execPath, '-e', 'process.exit(0)'],
    {
      stdio: 'ignore',
      timeout: 10000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
    },
  );
  await rm(probeRoot, { recursive: true, force: true });
  if (probe.error || probe.status !== 0)
    throw Error('Required conversion network confinement is unavailable.');
  const release = await lockMapWorker(options.jobs);
  if (!release) throw Error('Another official-map worker owns this queue or flock is unavailable.');
  let busy = false,
    beat;
  const heartbeat = () => {
    if (beat) return beat;
    beat = writeMapWorkerStatus(options.jobs, {
      schemaVersion: 1,
      status: busy ? 'processing' : 'idle',
      updatedAt: now(),
    }).finally(() => {
      beat = undefined;
    });
    return beat;
  };
  const timer = setInterval(() => {
    heartbeat().catch(() => options.log?.({ event: 'map.heartbeat_failed' }));
  }, 15000);
  try {
    await cleanMapPreparations(options);
    await heartbeat();
    while (!options.signal?.aborted) {
      busy = true;
      const worked = await processOneMapRequest(options);
      busy = false;
      await heartbeat();
      if (!worked) await delay(2000, undefined, { signal: options.signal }).catch(() => undefined);
    }
  } finally {
    clearInterval(timer);
    try {
      await beat?.catch(() => undefined);
      await writeMapWorkerStatus(options.jobs, { schemaVersion: 1, status: 'idle', updatedAt: 0 });
    } finally {
      await release();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  runMapWorker({
    ...mapWorkerOptions(),
    signal: controller.signal,
    log: (event) => console.log(JSON.stringify(event)),
  }).catch(() => {
    console.error('Official map worker stopped. Check catalog, mounts and resource limits.');
    process.exitCode = 1;
  });
}
