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
  latestMapPackId,
  latestMapPackMarkerSchema,
  readMapCatalog,
  resolveMap,
  officialMapInventoryLimits,
} from '../../backend/dist/map-catalog.js';
import {
  mapJobLimits,
  mapJobTemporaryName,
  prepareMapJobs,
  readMapRequest,
  readMapResult,
  readOfficialMapInventory,
  latestMapResultMatches,
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
import {
  refreshOfficialMapInventory,
  markSteamRateLimit,
  officialInventoryFailure,
} from './official-map-inventory.mjs';
import { installMapPreview, officialPreview } from './install-map-preview.mjs';
import { installGameplaySounds } from './install-gameplay-sounds.mjs';
import { installPresentationAssets } from './install-presentation-assets.mjs';
import { presentationDirectory, preparerRevision } from '../../backend/dist/asset-preparer.js';
import {
  presentationKinds,
  consumePresentationRetries,
  readPresentationStatus,
} from '../../backend/dist/presentation-assets.js';
import { cleanPresentationStages } from './presentation-stages.mjs';
import { managedMapPaths, processOneMapRemoval, retireInvalidMapPack } from './remove-map-pack.mjs';

export const mapWorkerLimits = Object.freeze({
  deadlineMs: 45 * 60 * 1000,
  cacheBytes: 16 * 1024 ** 3,
  assetBytes: 32 * 1024 ** 3,
  keepSources: 2,
  attempts: 3,
  steamCooldownSeconds: 15 * 60,
  packRecheckMs: 60 * 60 * 1000,
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
        current = [];
      let scanned = 0;
      for await (const entry of folder) {
        if (++scanned > mapJobLimits.scanned) throw Error('Map queue scan limit reached.');
        if (entry.isFile() && mapJobTemporaryName.test(entry.name)) continue;
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
          throw Error('Unexpected map queue entry.');
        const request = await readMapRequest(jobs, entry.name.slice(0, -5));
        if (!request) continue;
        if (current.length >= mapJobLimits.retained) throw Error('Map queue limit reached.');
        current.push(request);
      }
      return current.sort((a, b) => a.packId.localeCompare(b.packId));
    })) || []
  );
}
async function approved(options, request) {
  if (request.kind === 'latest-official') {
    // The request was admitted against fresh worker-observed membership. A
    // later inventory refresh must not rewrite its immutable source selection.
    const inventory = await readOfficialMapInventory(options.jobs, now(), { allowStale: true });
    return Boolean(inventory?.maps.some((entry) => entry.map === request.selection.map));
  }
  const catalog = await readMapCatalog(options.catalog);
  const resolution = resolveMap(request.approval.identity, catalog);
  return (
    resolution.status === 'approved' &&
    resolution.packId === request.packId &&
    canonicalMapApproval(resolution.approval) === canonicalMapApproval(request.approval)
  );
}

async function reserveAttempt(jobs, request) {
  const generation = request.generation;
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
          !/^[a-f0-9]{32}$/.test(data.generation) ||
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

const preparationMarker = (packId, requestId) =>
  JSON.stringify({
    schemaVersion: preparerRevision,
    packId,
    kind: 'cswatch-official-map-preparation',
    ...(requestId ? { requestId } : {}),
  });

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
      const text = await readFile(marker, 'utf8');
      if (text !== preparationMarker(match[1])) {
        const data = JSON.parse(text);
        if (
          !/^[a-f0-9]{64}$/.test(data.packId || '') ||
          !/^[a-f0-9]{64}$/.test(data.requestId || '') ||
          ![data.packId, data.requestId].includes(match[1]) ||
          text !== preparationMarker(data.packId, data.requestId)
        )
          continue;
      }
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
function mapFailureCode(error, signal) {
  if (signal?.aborted) return 'worker_interrupted';
  if (error?.code === 'STEAM_RATE_LIMIT') return 'preparation_failed';
  if (error?.code === 'SOURCE_MAP_MISMATCH') return 'source_mismatch';
  if (error?.code === 'ASSET_ATTEMPTS_EXHAUSTED') return 'worker_interrupted';
  if (error?.code === 'STEAM_SOURCE_UNAVAILABLE') return 'source_unavailable';
  if (error?.code === 'APPROVAL_REMOVED') return 'approval_removed';
  if (
    error?.code === 'ASSET_STORAGE_LIMIT' ||
    /free disk space|storage limit|disk quota|ENOSPC/i.test(error?.message || '')
  )
    return 'storage_limit';
  if (/manifest request code|selected map.*absent|Steam.*unavailable/i.test(error?.message || ''))
    return 'source_unavailable';
  return 'preparation_failed';
}

async function validatePack(root, request, validate, proof) {
  const marker = join(root, 'pack.json');
  await regular(marker, 16384);
  const data = JSON.parse(await readFile(marker, 'utf8'));
  if (request.kind === 'latest-official') {
    const marker = latestMapPackMarkerSchema.parse(data);
    if (
      !proof ||
      !latestMapResultMatches(request, proof) ||
      marker.requestId !== request.packId ||
      marker.packId !== proof.assetPackId ||
      JSON.stringify(marker.selection) !== JSON.stringify(request.selection) ||
      marker.source.mapSha256 !== proof.source.mapSha256 ||
      marker.source.manifest !== proof.source.manifest
    )
      throw Error('Prepared latest pack source differs.');
    return validate(
      join(root, 'maps'),
      request.selection.map,
      `steam-2347770-${request.selection.manifest}`,
    );
  }
  if (
    data.schemaVersion !== preparerRevision ||
    data.packId !== request.packId ||
    data.approval !== canonicalMapApproval(request.approval)
  )
    throw Error('Prepared pack approval differs.');
  const version =
    request.approval.assetVersion || `steam-2347770-${request.approval.source.manifest}`;
  return validate(join(root, 'maps'), request.approval.identity.map, version);
}

async function packStamp(root, paths) {
  const stamps = [];
  for (const path of paths) {
    const stat = await lstat(join(root, path), { bigint: true }).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat?.isSymbolicLink()) throw Error('Unexpected prepared map symlink.');
    stamps.push(stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.ctimeNs}:${stat.mtimeNs}` : '');
  }
  return stamps.join('|');
}
async function checkPublishedMap(root, request, validate, proof, cached) {
  const name =
    request.kind === 'latest-official' ? request.selection.map : request.approval.identity.map;
  const allowed = managedMapPaths(name);
  const paths = ['', ...allowed.directories, ...allowed.files];
  const stamp = await packStamp(root, paths);
  const prior = cached?.get(root);
  if (
    prior?.generation === request.generation &&
    prior.stamp === stamp &&
    prior.recheckAt > performance.now()
  )
    return;
  await localDirectory(root);
  await validatePack(root, request, validate, proof);
  if (stamp !== (await packStamp(root, paths)))
    throw Error('Prepared map files changed during validation.');
  if (cached) {
    cached.set(root, {
      stamp,
      generation: request.generation,
      recheckAt: performance.now() + mapWorkerLimits.packRecheckMs,
    });
    if (cached.size > mapJobLimits.retained) cached.delete(cached.keys().next().value);
  }
}
/** Caller holds the single-worker lock. Test adapters replace conversion, never
 * request validation, current catalog approval or publication ownership. */
export async function processOneMapRequest(options, adapters = {}) {
  const validate = adapters.validate || validatePreparedMap;
  const cached = options.validatedPacks;
  for (const request of await requests(options.jobs)) {
    const { packId } = request;
    const previous = await readMapResult(options.jobs, packId);
    if (previous?.status === 'failed') continue;
    let staging,
      repairing = previous?.repairing === true;
    let proof =
      request.kind === 'latest-official' && previous && latestMapResultMatches(request, previous)
        ? {
            assetPackId: previous.assetPackId,
            source: previous.source,
            sourceCheckedAt: previous.sourceCheckedAt,
          }
        : undefined;
    const latest = request.kind === 'latest-official';
    const packs = join(options.assets, 'packs');
    let assetPackId = proof?.assetPackId || packId;
    let target = join(packs, assetPackId);
    if (previous?.status === 'ready') {
      try {
        if (latest && !proof) throw Error('Ready snapshot lacks source proof.');
        await checkPublishedMap(target, request, validate, previous, cached);
        continue;
      } catch {
        repairing = true;
        cached?.delete(target);
      }
    }
    const retire = () =>
      retireInvalidMapPack(
        options,
        request,
        assetPackId,
        signal,
        preparationMarker(assetPackId, latest ? packId : undefined),
      );
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(mapWorkerLimits.deadlineMs)])
      : AbortSignal.timeout(mapWorkerLimits.deadlineMs);
    const result = (status, code) =>
      writeMapJobResult(options.jobs, {
        schemaVersion: preparerRevision,
        packId,
        status,
        updatedAt: now(),
        ...proof,
        ...(repairing && status === 'processing' ? { repairing: true } : {}),
        ...(code ? { code } : {}),
      });
    try {
      if (!(await approved(options, request)))
        throw Object.assign(Error('Approval removed.'), { code: 'APPROVAL_REMOVED' });
      signal.throwIfAborted();
      await result('processing');
      await writeMapWorkerStatus(options.jobs, {
        schemaVersion: 1,
        status: 'processing',
        updatedAt: now(),
      });
      await readableDirectory(packs);
      await localDirectory(packs);
      let recoverable = false;
      if (!latest || proof) {
        if (await exists(target)) {
          try {
            await checkPublishedMap(target, request, validate, { packId, ...proof }, cached);
            recoverable = true;
          } catch {
            repairing = true;
            await result('processing');
          }
        }
        if (!recoverable && repairing) await retire();
      }
      if (!recoverable) {
        if (!(await reserveAttempt(options.jobs, request)))
          throw Object.assign(Error('Map preparation restart budget exhausted.'), {
            code: 'ASSET_ATTEMPTS_EXHAUSTED',
          });
        const map = latest ? request.selection.map : request.approval.identity.map,
          manifest = latest ? request.selection.manifest : request.approval.source.manifest;
        const cache = await sourceCache(options, manifest);
        await budgets(options);
        staging = await mkdtemp(join(packs, `.preparing-${packId}-`));
        await writeFile(join(staging, '.preparation.json'), preparationMarker(packId), {
          flag: 'wx',
          mode: 0o600,
        });
        const prepare = adapters.prepare || installSteamAssets;
        let tools;
        await prepare(
          {
            maps: [map],
            manifest,
            ...(latest
              ? {
                  expectedMapFiles: {
                    [map]: { sha1: request.selection.sha1, bytes: request.selection.bytes },
                  },
                  onSourceVerified: async (source) => {
                    if (
                      source.map !== map ||
                      source.manifest !== manifest ||
                      source.sha1 !== request.selection.sha1 ||
                      source.bytes !== request.selection.bytes ||
                      !/^[a-f0-9]{64}$/.test(source.mapSha256 || '')
                    )
                      throw Object.assign(Error('Official source changed.'), {
                        code: 'SOURCE_MAP_MISMATCH',
                      });
                    const verified = {
                      appId: 730,
                      depotId: 2347770,
                      manifest,
                      mapSha256: source.mapSha256,
                    };
                    assetPackId = latestMapPackId(map, verified);
                    target = join(packs, assetPackId);
                    proof = { assetPackId, source: verified, sourceCheckedAt: now() };
                    // Persist before conversion/publication so a crash after rename
                    // can recover exactly this content without another download.
                    await result('processing');
                  },
                }
              : {
                  assetVersion: request.approval.assetVersion,
                  expectedMapHashes: { [map]: request.approval.source.mapSha256 },
                }),
            output: join(staging, 'maps'),
            cache,
            signal,
          },
          {
            prepareToolchain: async ({ signal, onProgress }) => {
              tools = await (adapters.prepareToolchain || prepareToolchain)({
                cache: join(options.cache, 'tools'),
                signal,
                onProgress,
              });
              return tools;
            },
            run: async (command, args, context) => {
              if (!(await approved(options, request)))
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
                const outcome = await runAssetProcess(executable, arguments_, {
                  ...context,
                  storageGuard: async () => {
                    await context.storageGuard?.();
                    await checkFreeReserve(options.cache, options.assets);
                  },
                });
                if (command === tools?.downloader && outcome.code === 4)
                  throw Object.assign(Error('Steam login rate limit.'), {
                    code: 'STEAM_RATE_LIMIT',
                    exitCode: 4,
                  });
                return outcome;
              } catch (error) {
                if (command === tools?.downloader && markSteamRateLimit(error)) throw error;
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
        if (latest && !proof) throw Error('Official source proof was not produced.');
        const version = (!latest && request.approval.assetVersion) || `steam-2347770-${manifest}`;
        await validate(join(staging, 'maps'), map, version);
        if (latest) {
          // The native converter has exited. Publication requires the content
          // ID in the private stage name, rather than the queue selection ID.
          const destination = await mkdtemp(join(packs, `.preparing-${assetPackId}-`));
          await rm(destination, { recursive: true });
          // Both pre/post-rename names recognize this exact marker after a crash.
          await writeFile(
            join(staging, '.preparation.json'),
            preparationMarker(assetPackId, packId),
          );
          await rename(staging, destination);
          staging = destination;
        }
        await writeFile(
          join(staging, 'pack.json'),
          JSON.stringify(
            latest
              ? latestMapPackMarkerSchema.parse({
                  schemaVersion: preparerRevision,
                  kind: 'latest-official',
                  packId: assetPackId,
                  requestId: packId,
                  selection: request.selection,
                  source: proof.source,
                  preparedAt: now(),
                })
              : {
                  schemaVersion: preparerRevision,
                  packId,
                  approval: canonicalMapApproval(request.approval),
                  preparedAt: now(),
                },
          ) + '\n',
          { flag: 'wx', mode: 0o644 },
        );
        await chmod(staging, 0o755);
        await validatePack(staging, request, validate, { packId, ...proof });
        if (!(await approved(options, request)))
          throw Object.assign(Error('Approval removed.'), { code: 'APPROVAL_REMOVED' });
        await budgets(options);
        let alreadyPublished = false;
        if (await exists(target)) {
          try {
            await checkPublishedMap(target, request, validate, { packId, ...proof }, cached);
            alreadyPublished = true;
          } catch {
            repairing = true;
            await result('processing');
            await retire();
          }
        }
        if (alreadyPublished) {
          await rm(staging, { recursive: true });
          staging = undefined;
        } else {
          const publication = spawnSync(
            options.networkDeny || defaultNetworkDeny,
            ['--publish', staging, target],
            { stdio: 'ignore', timeout: 10000 },
          );
          if (publication.error || publication.status !== 0)
            throw Error('Exclusive prepared map publication failed.');
          staging = undefined;
        }
      }
      if (!(await approved(options, request)))
        throw Object.assign(Error('Approval removed.'), { code: 'APPROVAL_REMOVED' });
      signal.throwIfAborted();
      await result('ready');
      options.log?.({ event: 'map.ready', packId });
    } catch (error) {
      if (error?.code === 'STEAM_RATE_LIMIT') options.onSteamRateLimit?.();
      const code = mapFailureCode(error, signal);
      await result(
        repairing && options.signal?.aborted ? 'processing' : 'failed',
        repairing && options.signal?.aborted ? undefined : code,
      );
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

export async function runMapWorker(options, adapters = {}) {
  // Test adapters replace scheduling time and remote work, never confinement,
  // worker locking, heartbeat storage or publication ownership.
  const clock = adapters.now || now,
    sleep = adapters.delay || delay,
    refreshInventory = adapters.refreshInventory || refreshWorkerInventory,
    processRequest = adapters.processRequest || processOneMapRequest,
    prepareSounds = adapters.prepareSounds || prepareIdleGameplaySounds,
    preparePreview = adapters.preparePreview || prepareIdleMapPreview,
    preparePresentation = adapters.preparePresentation || prepareIdlePresentation,
    processRemoval = adapters.processRemoval || processOneMapRemoval;
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
    beat,
    inventoryFailure;
  let blockedUntil = 0;
  const nextPresentation = new Map();
  const onSteamRateLimit = () => {
    blockedUntil = Math.max(blockedUntil, clock() + mapWorkerLimits.steamCooldownSeconds);
    options.log?.({ event: 'map.steam_rate_limited', retryAt: blockedUntil });
    options.onSteamRateLimit?.();
  };
  const workOptions = {
    ...options,
    onSteamRateLimit,
    validatedPacks: new Map(),
    pinnedIndexes: new Map(),
  };
  const pause = async (milliseconds) => {
    try {
      await sleep(milliseconds, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal?.aborted) throw error;
    }
  };
  const heartbeat = () => {
    if (beat) return beat;
    beat = writeMapWorkerStatus(options.jobs, {
      schemaVersion: 1,
      status: busy ? 'processing' : 'idle',
      updatedAt: clock(),
      ...(inventoryFailure ? { inventoryFailure } : {}),
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
    try {
      await cleanPresentationStages({
        ...options,
        assets: join(options.assets, presentationDirectory),
      });
    } catch {
      options.log?.({ event: 'presentation.recovery_failed', code: 'preparation_failed' });
    }
    const previousPresentation = Object.values(
      (await readPresentationStatus(options.jobs))?.categories || {},
    );

    blockedUntil = Math.max(
      blockedUntil,
      ...previousPresentation
        .filter((entry) => entry.code === 'steam_rate_limited')
        .map((entry) => entry.retryAt || 0),
    );
    await heartbeat();
    let refreshAt = 0,
      refreshFailures = 0,
      audioManifest,
      audioAttempts = 0,
      previewManifest,
      previewAttempts = 0,
      presentationManifest,
      presentationCheckedAt,
      presentationScanAt = 0,
      pendingPresentation = [];
    while (!options.signal?.aborted) {
      busy = true;
      const removed = await processRemoval(workOptions);
      busy = false;
      if (removed) {
        await heartbeat();
        continue;
      }
      for (const retry of await consumePresentationRetries(options.jobs)) {
        nextPresentation.delete(retry.kind);
        if (!pendingPresentation.includes(retry.kind)) pendingPresentation.push(retry.kind);
      }
      if (clock() < blockedUntil) {
        await heartbeat();
        await pause(Math.min(15000, (blockedUntil - clock()) * 1000));
        continue;
      }
      if (clock() >= refreshAt) {
        busy = true;
        try {
          const inventory = await refreshInventory(workOptions);
          inventoryFailure = undefined;
          refreshFailures = 0;
          refreshAt = clock() + 3600;
          if (audioAttempts < 3) audioManifest = inventory.manifest;
          if (previewAttempts < 3) previewManifest = inventory.manifest;
          presentationManifest = inventory.manifest;
          presentationCheckedAt = clock();
          pendingPresentation = [...presentationKinds];
          presentationScanAt = clock() + 60;
          options.log?.({
            event: 'map.inventory_ready',
            manifest: inventory.manifest,
            maps: inventory.maps.length,
          });
        } catch (error) {
          if (error?.code === 'STEAM_RATE_LIMIT') onSteamRateLimit();
          refreshFailures++;
          // Discovery backoff and the shared explicit-rate cooldown are separate.
          // Both respect Steam's advised fifteen-minute login-rate pause.
          refreshAt = clock() + Math.min(3600, 900 * 2 ** Math.min(refreshFailures - 1, 2));
          inventoryFailure = {
            ...officialInventoryFailure(error, 'storage', options.signal),
            at: clock(),
            retryAt: Math.max(refreshAt, blockedUntil),
          };
          options.log?.({ event: 'map.inventory_unavailable', ...inventoryFailure });
        }
        busy = false;
        await heartbeat();
      }
      if (options.signal?.aborted) break;
      if (clock() < blockedUntil) continue;
      busy = true;
      const worked = await processRequest(workOptions);
      busy = false;
      await heartbeat();
      const inventoryIsFresh =
        presentationCheckedAt !== undefined &&
        clock() >= presentationCheckedAt &&
        clock() - presentationCheckedAt <= officialMapInventoryLimits.maxAgeSeconds;
      if (
        inventoryIsFresh &&
        presentationManifest &&
        !pendingPresentation.length &&
        clock() >= presentationScanAt
      ) {
        pendingPresentation = [...presentationKinds];
        presentationScanAt = clock() + 60;
      }
      if (
        !worked &&
        inventoryIsFresh &&
        presentationManifest &&
        pendingPresentation.length &&
        !options.signal?.aborted
      ) {
        // One publication at a time. Ready banks do not delay or count as work.
        let published = false;
        while (pendingPresentation.length && !options.signal?.aborted && clock() >= blockedUntil) {
          const eligible = pendingPresentation.findIndex(
            (kind) => clock() >= (nextPresentation.get(kind) || 0),
          );
          if (eligible < 0) break;
          const [kind] = pendingPresentation.splice(eligible, 1);
          busy = true;
          try {
            const retained = (await readPresentationStatus(options.jobs))?.categories[kind];
            const sourceManifest = retained?.manifest || presentationManifest;
            const result = await preparePresentation(workOptions, sourceManifest, kind);
            if (result?.remaining || result?.status === 'backoff') pendingPresentation.push(kind);
            if (result?.status === 'backoff') nextPresentation.set(kind, result.retryAt);
            published = result?.status === 'prepared' || result?.status === 'checked';
          } catch (error) {
            if (error?.code === 'STEAM_RATE_LIMIT') onSteamRateLimit();
            const retained = (await readPresentationStatus(options.jobs))?.categories[kind];
            if (retained?.code !== 'source_mismatch' && retained?.item) {
              pendingPresentation.push(kind);
            } else if (retained?.attempts !== 3 && retained?.code !== 'source_mismatch') {
              nextPresentation.set(kind, retained?.retryAt || clock() + 300);
              pendingPresentation.push(kind);
            }
            options.log?.({
              event: 'presentation.failed',
              kind,
              code: mapFailureCode(error, options.signal),
            });
            // Recheck the queue after an acquisition attempt, successful or otherwise.
            published = true;
          } finally {
            busy = false;
            await heartbeat();
          }
          if (published) break;
        }
        if (published || clock() < blockedUntil) continue;
      }
      if (!worked && inventoryIsFresh && previewManifest && !options.signal?.aborted) {
        const selected = previewManifest;
        previewManifest = undefined;
        previewAttempts++;
        busy = true;
        try {
          await preparePreview(workOptions, selected);
          options.log?.({ event: 'preview.ready', manifest: selected });
          previewAttempts = 3;
        } catch (error) {
          if (error?.code === 'STEAM_RATE_LIMIT') onSteamRateLimit();
          if (error?.code === 'SOURCE_MAP_MISMATCH') previewAttempts = 3;
          options.log?.({ event: 'preview.failed', code: mapFailureCode(error, options.signal) });
        } finally {
          busy = false;
          await heartbeat();
        }
        // Recheck queued maps and the shared Steam cooldown before starting a large bank.
        continue;
      }
      if (!worked && inventoryIsFresh && audioManifest && !options.signal?.aborted) {
        const selected = audioManifest;
        audioManifest = undefined;
        audioAttempts++;
        busy = true;
        try {
          await prepareSounds(workOptions, selected);
          options.log?.({ event: 'sound.ready', manifest: selected });
          audioAttempts = 3;
        } catch (error) {
          if (error?.code === 'STEAM_RATE_LIMIT') onSteamRateLimit();
          if (error?.code === 'SOURCE_MAP_MISMATCH') audioAttempts = 3;
          options.log?.({ event: 'sound.failed', code: mapFailureCode(error, options.signal) });
        } finally {
          busy = false;
          await heartbeat();
        }
      }
      if (!worked) await pause(2000);
    }
  } finally {
    clearInterval(timer);
    try {
      await beat?.catch(() => undefined);
      await writeMapWorkerStatus(options.jobs, {
        schemaVersion: 1,
        status: 'idle',
        updatedAt: 0,
        ...(inventoryFailure ? { inventoryFailure } : {}),
      });
    } finally {
      await release();
    }
  }
}

/** Production acquisition admission stays inside the real remote stage. Pure
 * scheduling adapters replace that entire stage, never any converter boundary. */
async function refreshWorkerInventory(options) {
  await budgets(options);
  return refreshOfficialMapInventory(options);
}

/** Fixed native agents/icons/models share official metadata and cooldown, never recordings. */
async function prepareIdlePresentation(options, manifest, kind, adapters = {}) {
  selectedSteamManifest(manifest);
  const cache = join(options.cache, 'sources', `steam-${manifest}`);
  return (adapters.install || installPresentationAssets)(
    {
      ...options,
      cache,
      toolchainCache: join(options.cache, 'tools'),
      cacheRoot: options.cache,
      prepareSource: async (selectedManifest, selectedCache) => {
        await budgets(options);
        if ((await sourceCache(options, selectedManifest)) !== selectedCache)
          throw Error('Native presentation source changed.');
      },
      networkDeny: options.networkDeny || defaultNetworkDeny,
      beforePublish: () => budgets(options),
    },
    manifest,
    kind,
    {
      ...adapters.installAdapters,
      run: async (command, args, context) => {
        await budgets(options);
        return runAssetProcess(command, args, {
          ...context,
          storageGuard: async () => {
            await context.storageGuard?.();
            await checkFreeReserve(options.cache, options.assets);
          },
        });
      },
    },
  );
}

/** Decorative official artwork shares only source storage and supervisor limits, never demos. */
export function mapPreviewInstallOptions(options, manifest, signal) {
  selectedSteamManifest(manifest);
  return {
    cache: join(options.cache, 'sources', `steam-${manifest}`),
    output: options.assets,
    toolchainCache: join(options.cache, 'tools'),
    manifest,
    networkDeny: options.networkDeny || defaultNetworkDeny,
    signal,
    beforePublish: () => budgets(options),
  };
}
export async function prepareIdleMapPreview(options, manifest, adapters = {}) {
  selectedSteamManifest(manifest);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(officialPreview.deadlineMs)])
    : AbortSignal.timeout(officialPreview.deadlineMs);
  await budgets(options);
  const cache = await sourceCache(options, manifest);
  const installation = mapPreviewInstallOptions(options, manifest, signal);
  if (installation.cache !== cache) throw Error('Official preview source changed.');
  return (adapters.install || installMapPreview)(installation, {
    run: async (command, args, context) => {
      await budgets(options);
      return runAssetProcess(command, args, {
        ...context,
        storageGuard: async () => {
          await context.storageGuard?.();
          await checkFreeReserve(options.cache, options.assets);
        },
      });
    },
  });
}

/** Idle-only fixed audio preparation never changes map/replay results. */
export async function prepareIdleGameplaySounds(options, manifest, adapters = {}) {
  selectedSteamManifest(manifest);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60 * 1000)])
    : AbortSignal.timeout(15 * 60 * 1000);
  await budgets(options);
  const cache = await sourceCache(options, manifest);
  return (adapters.install || installGameplaySounds)(
    {
      cache,
      output: options.assets,
      toolchainCache: join(options.cache, 'tools'),
      manifest,
      networkDeny: options.networkDeny || defaultNetworkDeny,
      signal,
      beforePublish: () => budgets(options),
    },
    {
      run: async (command, args, context) => {
        await budgets(options);
        return runAssetProcess(command, args, {
          ...context,
          storageGuard: async () => {
            await context.storageGuard?.();
            await checkFreeReserve(options.cache, options.assets);
          },
        });
      },
    },
  );
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
