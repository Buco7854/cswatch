import { mapPreparerRevision } from './asset-preparer.js';
/** Filesystem-only map acquisition contract. This module never imports the app,
 * database, accounts, native parser, network or operator conversion tools. */
import { constants } from 'node:fs';
import {
  link,
  lstat,
  open,
  mkdir,
  opendir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  MapJobRequest,
  MapJobResult,
  ApprovedMapEntry,
  LatestOfficialSelection,
  OfficialMapInventory,
  MapInventoryFailure,
} from '../../shared/map-acquisition.js';
import {
  approvedMapEntrySchema,
  mapPackId,
  latestOfficialSelectionSchema,
  latestMapRequestId,
  officialMapSourceSchema,
  officialMapInventorySchema,
  officialMapInventoryLimits,
  latestMapPackId,
} from './map-catalog.js';
import { bytesFrom, fileVersion, regularFile, withDirectory } from './map-asset-files.js';
export const mapJobLimits = { bytes: 8192, jobs: 32, retained: 512, scanned: 1024 } as const;
export const mapJobTemporaryName = /^\.[a-f0-9]{64}-[a-f0-9]{24}\.tmp$/;
export const packIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const mapJobIdentity = {
  packId: packIdSchema,
  generation: z.string().regex(/^[a-f0-9]{32}$/),
};
export const mapJobRequestSchema = z.union([
  z
    .object({
      ...mapJobIdentity,
      schemaVersion: z.literal(mapPreparerRevision),
      approval: approvedMapEntrySchema,
    })
    .strict()
    .refine((value) => value.packId === mapPackId(value.approval)),
  z
    .object({
      ...mapJobIdentity,
      schemaVersion: z.literal(mapPreparerRevision),
      kind: z.literal('latest-official'),
      selection: latestOfficialSelectionSchema,
    })
    .strict()
    .refine((value) => value.packId === latestMapRequestId(value.selection)),
]);
export const mapJobResultSchema = z
  .object({
    schemaVersion: z.literal(mapPreparerRevision),
    packId: packIdSchema,
    status: z.enum(['processing', 'ready', 'failed']),
    updatedAt: z.number().int().min(0).max(8640000000000),
    assetPackId: packIdSchema.optional(),
    repairing: z.literal(true).optional(),
    source: officialMapSourceSchema.optional(),
    sourceCheckedAt: z.number().int().min(0).max(8640000000000).optional(),
    code: z
      .enum([
        'source_unavailable',
        'source_mismatch',
        'storage_limit',
        'preparation_failed',
        'approval_removed',
        'worker_interrupted',
        'removed_by_admin',
      ])
      .optional(),
  })
  .strict()
  .refine((value) =>
    value.status === 'failed' ? value.code !== undefined : value.code === undefined,
  )
  .refine((value) => !value.repairing || value.status === 'processing')
  .refine((value) => {
    const supplied = [value.assetPackId, value.source, value.sourceCheckedAt].filter(
      (v) => v !== undefined,
    ).length;
    return supplied === 0 || (supplied === 3 && value.sourceCheckedAt! <= value.updatedAt + 300);
  });

/** A crash after the exclusive link can leave its original temporary name.
 * Remove that name only when it already publishes the same owned inode. */
export async function finishLinkedMapRequest(directory: FileHandle, name: string) {
  if (!mapJobTemporaryName.test(name)) return;
  const folder = `/proc/self/fd/${directory.fd}/`;
  const target = `${folder}${name.slice(1, 65)}.json`;
  try {
    const stage = await lstat(folder + name, { bigint: true });
    if (
      !stage.isFile() ||
      stage.nlink !== 2n ||
      stage.uid !== BigInt(process.getuid?.() ?? -1) ||
      stage.mode & 0o022n
    )
      return;
    const final = await lstat(target, { bigint: true });
    if (!final.isFile() || final.nlink !== 2n || final.dev !== stage.dev || final.ino !== stage.ino)
      return;
    await unlink(folder + name);
    await directory.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function latestMapResultMatches(request: MapJobRequest, result: MapJobResult): boolean {
  return (
    request.kind === 'latest-official' &&
    result.packId === request.packId &&
    Boolean(
      result.source &&
      result.assetPackId &&
      result.sourceCheckedAt !== undefined &&
      result.source.manifest === request.selection.manifest &&
      result.assetPackId === latestMapPackId(request.selection.map, result.source),
    )
  );
}
export const mapInventoryFailureSchema: z.ZodType<MapInventoryFailure> = z
  .object({
    phase: z.enum(['storage', 'toolchain', 'downloader', 'metadata', 'publication']),
    code: z.enum([
      'storage_limit',
      'storage_unavailable',
      'access_denied',
      'network_unavailable',
      'toolchain_failed',
      'steam_rate_limited',
      'steam_unavailable',
      'metadata_invalid',
      'publication_failed',
      'timeout',
      'interrupted',
    ]),
    at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    retryAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    exitCode: z.number().int().min(0).max(255).optional(),
  })
  .strict()
  .refine((value) => value.retryAt >= value.at && value.retryAt <= value.at + 3600);
const mapWorkerStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.number().int().min(0),
    status: z.enum(['idle', 'processing']),
    inventoryFailure: mapInventoryFailureSchema.optional(),
  })
  .strict();

async function readMapJob<T>(
  root: string,
  folder: 'requests' | 'results',
  packId: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  if (!packIdSchema.safeParse(packId).success) return;
  return withDirectory(root, [folder], async (directory) => {
    const file = await regularFile(directory, `${packId}.json`, 2, mapJobLimits.bytes);
    if (!file) return;
    try {
      const version = await fileVersion(file),
        data = await bytesFrom(file, (await file.stat()).size, mapJobLimits.bytes);
      if (version !== (await fileVersion(file))) return;
      const value = schema.parse(JSON.parse(data.toString('utf8')));
      if ((value as { packId?: string }).packId !== packId) return;
      return value;
    } finally {
      await file.close();
    }
  });
}
export const readMapRequest = (root: string, packId: string) =>
  readMapJob<MapJobRequest>(root, 'requests', packId, mapJobRequestSchema);
export const readMapResult = (root: string, packId: string) =>
  readMapJob(root, 'results', packId, mapJobResultSchema);

/** Operator queue paths are real directories at every ancestor. */
async function openQueueRoot(root: string, create: boolean): Promise<FileHandle> {
  const absolute = resolve(root);
  if (absolute === '/') throw new Error('A dedicated map queue directory is required');
  let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of absolute.split('/').filter(Boolean)) {
      const path = `/proc/self/fd/${current.fd}/${part}`;
      if (create)
        await mkdir(path, { mode: 0o750 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const next = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}
/** Queue root is an explicit operator volume. Neither requests nor results can
 * supply a file path. Child directories/files are always descriptor anchored. */
export async function prepareMapJobs(root: string) {
  const directory = await openQueueRoot(root, true);
  try {
    for (const name of ['requests', 'results', 'locks', 'removals', 'removal-results']) {
      const path = `/proc/self/fd/${directory.fd}/${name}`;
      await mkdir(path, { mode: 0o750 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const child = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await child.close();
    }
  } finally {
    await directory.close();
  }
}

/** Fresh official inventory is generated only by the asset supervisor. Readers
 * never query Steam, follow a file link or accept caller-selected source paths. */
export async function readOfficialMapInventory(
  root: string,
  at = Math.floor(Date.now() / 1000),
  { allowStale = false }: { allowStale?: boolean } = {},
): Promise<OfficialMapInventory | undefined> {
  let directory: FileHandle | undefined, file: FileHandle | undefined;
  try {
    if (!Number.isSafeInteger(at) || at < 0) return;
    directory = await openQueueRoot(root, false);
    file = await regularFile(
      directory,
      'official-inventory.json',
      2,
      officialMapInventoryLimits.bytes,
    );
    if (!file) return;
    const info = await file.stat();
    if (info.mode & 0o022 || info.uid !== process.getuid?.()) return;
    const version = await fileVersion(file),
      data = await bytesFrom(file, info.size, officialMapInventoryLimits.bytes);
    if (version !== (await fileVersion(file))) return;
    const inventory = officialMapInventorySchema.parse(JSON.parse(data.toString('utf8')));
    if (
      inventory.updatedAt > at + 300 ||
      (!allowStale && inventory.updatedAt < at - officialMapInventoryLimits.maxAgeSeconds)
    )
      return;
    return inventory;
  } catch {
    return;
  } finally {
    await file?.close();
    await directory?.close();
  }
}

export async function writeOfficialMapInventory(root: string, value: OfficialMapInventory) {
  const inventory = officialMapInventorySchema.parse(value),
    data = Buffer.from(JSON.stringify(inventory));
  if (data.length > officialMapInventoryLimits.bytes)
    throw Error('Official map inventory byte limit');
  await prepareMapJobs(root);
  const directory = await openQueueRoot(root, false);
  let file: FileHandle | undefined, temporary: string | undefined;
  try {
    const info = await directory.stat();
    if (info.mode & 0o022 || info.uid !== process.getuid?.())
      throw Error('Official map inventory ownership');
    const targetVersion = async () => {
      let target: FileHandle | undefined;
      try {
        target = await regularFile(
          directory,
          'official-inventory.json',
          2,
          officialMapInventoryLimits.bytes,
        );
        if (!target) throw Error('Unsafe existing official inventory');
        const state = await target.stat();
        if (state.mode & 0o022 || state.uid !== process.getuid?.())
          throw Error('Unsafe official inventory owner');
        return await fileVersion(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      } finally {
        await target?.close();
      }
    };
    const previous = await targetVersion();
    temporary = `/proc/self/fd/${directory.fd}/.official-inventory-${randomBytes(12).toString('hex')}.tmp`;
    file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o640,
    );
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = undefined;
    if (previous !== (await targetVersion()))
      throw Error('Official inventory changed during publication');
    await rename(temporary, `/proc/self/fd/${directory.fd}/official-inventory.json`);
    temporary = undefined;
    await directory.sync();
  } finally {
    await file?.close();
    if (temporary) await unlink(temporary).catch(() => undefined);
    await directory.close();
  }
}
/** Single-web startup only, before HTTP admission. The worker must merely
 * ignore these files: it can observe a live web writer's temporary request. */
export async function cleanupMapRequestTemps(root: string): Promise<number> {
  let queue: FileHandle | undefined, directory: FileHandle | undefined;
  try {
    queue = await openQueueRoot(root, false);
    let removed = 0;
    // Both folders contain only web-authored intents. Never clean worker result
    // temporaries here: an independently running worker may still own them.
    for (const folder of ['requests', 'removals']) {
      directory = await open(
        `/proc/self/fd/${queue.fd}/${folder}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ).catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!directory) continue;
      const entries = await opendir(`/proc/self/fd/${directory.fd}`);
      let scanned = 0,
        folderRemoved = 0;
      for await (const entry of entries) {
        if (++scanned > mapJobLimits.scanned) throw new Error('Map queue startup scan limit');
        if (!entry.isFile() || !mapJobTemporaryName.test(entry.name)) continue;
        const file = await regularFile(directory, entry.name, 0, mapJobLimits.bytes);
        if (!file) continue;
        try {
          const info = await file.stat();
          if ((process.getuid && info.uid !== process.getuid?.()) || info.mode & 0o022) continue;
          await unlink(`/proc/self/fd/${directory.fd}/${entry.name}`);
          folderRemoved++;
        } finally {
          await file.close();
        }
      }
      if (folderRemoved) await directory.sync();
      removed += folderRemoved;
      await directory.close();
      directory = undefined;
    }
    return removed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  } finally {
    await directory?.close();
    await queue?.close();
  }
}
export async function writeMapWorkerStatus(
  root: string,
  value: z.infer<typeof mapWorkerStatusSchema>,
) {
  const checked = mapWorkerStatusSchema.parse(value);
  const data = Buffer.from(JSON.stringify(checked));
  const success = await withDirectory(root, [], async (directory) => {
    const name = `.worker-status-${randomBytes(12).toString('hex')}.tmp`,
      path = `/proc/self/fd/${directory.fd}/${name}`;
    let file;
    try {
      file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o640,
      );
      await file.writeFile(data);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(path, `/proc/self/fd/${directory.fd}/worker-status.json`);
      await directory.sync();
      return true;
    } finally {
      await file?.close();
      await unlink(path).catch(() => undefined);
    }
  });
  if (!success) throw new Error('Map worker heartbeat storage unavailable');
}
export async function writeMapJobResult(root: string, value: MapJobResult) {
  const result = mapJobResultSchema.parse(value);
  await atomicMapJobWrite(root, 'results', result.packId, result);
}
export async function atomicMapJobWrite(
  root: string,
  folder: 'requests' | 'results',
  packId: string,
  value: MapJobRequest | MapJobResult,
  createOnly = false,
) {
  packIdSchema.parse(packId);
  const checked =
    folder === 'requests' ? mapJobRequestSchema.parse(value) : mapJobResultSchema.parse(value);
  if (checked.packId !== packId) throw new Error('Invalid map job identity');
  const data = Buffer.from(JSON.stringify(checked));
  if (data.length > mapJobLimits.bytes) throw new Error('Map job limit');
  const success = await withDirectory(root, [folder], async (directory) => {
    const temporary = `.${packId}-${randomBytes(12).toString('hex')}.tmp`;
    const target = `/proc/self/fd/${directory.fd}/${temporary}`;
    let file;
    try {
      file = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o640,
      );
      await file.writeFile(data);
      await file.sync();
      await file.close();
      file = undefined;
      const final = `/proc/self/fd/${directory.fd}/${packId}.json`;
      if (createOnly) {
        try {
          await link(target, final);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw error;
        }
        await unlink(target).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      } else await rename(target, final);
      await directory.sync();
      return true;
    } finally {
      await file?.close();
      await unlink(target).catch(() => undefined);
    }
  });
  if (success === undefined) throw new Error('Map job storage unavailable');
  return success;
}
export const mapJobRetrySeconds = 300;
export function canRetryMapResult(result: MapJobResult, at = Math.floor(Date.now() / 1000)) {
  return (
    result.status === 'failed' &&
    [
      'source_unavailable',
      'storage_limit',
      'preparation_failed',
      'worker_interrupted',
      'removed_by_admin',
    ].includes(result.code || '') &&
    Number.isSafeInteger(at) &&
    at >= 0 &&
    result.updatedAt <= at - mapJobRetrySeconds
  );
}
async function queueHasRoom(root: string, newRequest: boolean) {
  return withDirectory(root, ['requests'], async (directory) => {
    const entries = await opendir(`/proc/self/fd/${directory.fd}`);
    let pending = 0,
      retained = 0,
      scanned = 0;
    for await (const entry of entries) {
      if (++scanned > mapJobLimits.scanned || (newRequest && scanned >= mapJobLimits.scanned))
        return false;
      if (entry.isFile() && mapJobTemporaryName.test(entry.name)) continue;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) return false;
      const id = entry.name.slice(0, -5);
      if (!(await readMapRequest(root, id))) continue;
      if (++retained > mapJobLimits.retained || (newRequest && retained >= mapJobLimits.retained))
        return false;
      const result = await readMapResult(root, id);
      if (!result || result.status === 'processing') pending++;
      if (pending >= mapJobLimits.jobs) return false;
    }
    return true;
  });
}
let enqueueQueue: Promise<unknown> = Promise.resolve();
function enqueueMapJob(
  root: string,
  value: MapJobRequest,
): Promise<'queued' | 'existing' | 'full'> {
  const request = mapJobRequestSchema.parse(value);
  const operation = enqueueQueue.then(async () => {
    const packId = request.packId;
    await prepareMapJobs(root);
    if (await readMapRequest(root, packId)) return 'existing' as const;
    if (!(await queueHasRoom(root, true))) return 'full' as const;
    return (await atomicMapJobWrite(root, 'requests', packId, request, true))
      ? ('queued' as const)
      : ('existing' as const);
  });
  enqueueQueue = operation.catch(() => undefined);
  return operation;
}
export function enqueueMapRequest(root: string, approval: ApprovedMapEntry) {
  return enqueueMapJob(root, {
    schemaVersion: mapPreparerRevision,
    packId: mapPackId(approval),
    approval,
    generation: randomBytes(16).toString('hex'),
  });
}
export function enqueueLatestMapRequest(root: string, selection: LatestOfficialSelection) {
  return enqueueMapJob(root, {
    schemaVersion: mapPreparerRevision,
    packId: latestMapRequestId(selection),
    generation: randomBytes(16).toString('hex'),
    kind: 'latest-official',
    selection,
  });
}
/** Failed results are terminal for the worker. Only an explicitly authorized
 * HTTP request can remove an eligible terminal result after the cooldown.
 * Serializing with enqueues also preserves the global pending-job reservation. */
function retryMapJob(
  root: string,
  packId: string,
  at: number,
  { removeResult = unlink }: { removeResult?: (path: string) => Promise<void> } = {},
): Promise<'queued' | 'ineligible' | 'full'> {
  const operation = enqueueQueue.then(async () => {
    const request = await readMapRequest(root, packId),
      result = await readMapResult(root, packId);
    if (!request || !result || !canRetryMapResult(result, at)) return 'ineligible' as const;
    if (!(await queueHasRoom(root, false))) return 'full' as const;
    const removed = await withDirectory(root, ['results'], async (directory) => {
      // Recheck after the bounded queue scan. The worker does not rewrite a
      // failed result; a concurrent retry in this process holds the same queue.
      const current = await readMapResult(root, packId);
      if (
        !current ||
        current.updatedAt !== result.updatedAt ||
        current.code !== result.code ||
        !canRetryMapResult(current, at)
      )
        return false;
      // A fresh generation unlocks a bounded worker attempt group. Publish it
      // before removing the failure so a worker never consumes the old group.
      await atomicMapJobWrite(root, 'requests', packId, {
        ...request,
        generation: randomBytes(16).toString('hex'),
      });
      if (request.kind === 'latest-official' && latestMapResultMatches(request, current)) {
        // Publication may have completed just before a failed final status
        // write or shutdown. Keep the verified content identity so the worker
        // can recover that immutable pack instead of downloading it again.
        await atomicMapJobWrite(root, 'results', packId, {
          schemaVersion: mapPreparerRevision,
          packId,
          status: 'processing',
          updatedAt: at,
          assetPackId: current.assetPackId,
          source: current.source,
          sourceCheckedAt: current.sourceCheckedAt,
        });
      } else await removeResult(`/proc/self/fd/${directory.fd}/${packId}.json`);
      await directory.sync();
      return true;
    });
    return removed ? ('queued' as const) : ('ineligible' as const);
  });
  enqueueQueue = operation.catch(() => undefined);
  return operation;
}
export function retryMapRequest(
  root: string,
  approval: ApprovedMapEntry,
  at = Math.floor(Date.now() / 1000),
  options?: { removeResult?: (path: string) => Promise<void> },
) {
  return retryMapJob(root, mapPackId(approval), at, options);
}
export function retryLatestMapRequest(
  root: string,
  selection: LatestOfficialSelection,
  at = Math.floor(Date.now() / 1000),
  options?: { removeResult?: (path: string) => Promise<void> },
) {
  return retryMapJob(root, latestMapRequestId(selection), at, options);
}
export async function readMapWorkerStatus(root: string) {
  return withDirectory(root, [], async (directory) => {
    const file = await regularFile(directory, 'worker-status.json', 2, 1024);
    if (!file) return;
    try {
      const before = await fileVersion(file),
        data = await bytesFrom(file, (await file.stat()).size, 1024);
      const status = mapWorkerStatusSchema.parse(JSON.parse(data.toString('utf8')));
      if (before === (await fileVersion(file))) return status;
    } finally {
      await file.close();
    }
  });
}
export async function mapWorkerAvailable(root: string, at = Math.floor(Date.now() / 1000)) {
  const status = await readMapWorkerStatus(root);
  return Boolean(status && status.updatedAt <= at + 5 && status.updatedAt >= at - 90);
}
