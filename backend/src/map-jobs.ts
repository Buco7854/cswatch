/** Filesystem-only map acquisition contract. This module never imports the app,
 * database, accounts, native parser, network or operator conversion tools. */
import { constants } from 'node:fs';
import { open, mkdir, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  MapJobRequest,
  MapJobResult,
  ApprovedMapEntry,
} from '../../shared/map-acquisition.js';
import { approvedMapEntrySchema, mapPackId } from './map-catalog.js';
import { bytesFrom, fileVersion, regularFile, withDirectory } from './map-asset-files.js';
export const mapJobLimits = { bytes: 8192, jobs: 32, retained: 512, scanned: 1024 } as const;
export const mapJobTemporaryName = /^\.[a-f0-9]{64}-[a-f0-9]{24}\.tmp$/;
export const packIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const mapJobRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    packId: packIdSchema,
    generation: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    approval: approvedMapEntrySchema,
  })
  .strict()
  .refine((value) => value.packId === mapPackId(value.approval));
export const mapJobResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    packId: packIdSchema,
    status: z.enum(['processing', 'ready', 'failed']),
    updatedAt: z.number().int().min(0).max(8640000000000),
    code: z
      .enum([
        'source_unavailable',
        'source_mismatch',
        'storage_limit',
        'preparation_failed',
        'approval_removed',
        'worker_interrupted',
      ])
      .optional(),
  })
  .strict()
  .refine((value) =>
    value.status === 'failed' ? value.code !== undefined : value.code === undefined,
  );
export const mapWorkerStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.number().int().min(0),
    status: z.enum(['idle', 'processing']),
  })
  .strict();

export async function readMapJob<T>(
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
  readMapJob(root, 'requests', packId, mapJobRequestSchema);
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
    for (const name of ['requests', 'results', 'locks']) {
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
/** Single-web startup only, before HTTP admission. The worker must merely
 * ignore these files: it can observe a live web writer's temporary request. */
export async function cleanupMapRequestTemps(root: string): Promise<number> {
  let queue: FileHandle | undefined, directory: FileHandle | undefined;
  try {
    queue = await openQueueRoot(root, false);
    directory = await open(
      `/proc/self/fd/${queue.fd}/requests`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const entries = await opendir(`/proc/self/fd/${directory.fd}`);
    let scanned = 0,
      removed = 0;
    for await (const entry of entries) {
      if (++scanned > mapJobLimits.scanned) throw new Error('Map queue startup scan limit');
      if (!entry.isFile() || !mapJobTemporaryName.test(entry.name)) continue;
      const file = await regularFile(directory, entry.name, 0, mapJobLimits.bytes);
      if (!file) continue;
      try {
        const info = await file.stat();
        if ((process.getuid && info.uid !== process.getuid()) || info.mode & 0o022) continue;
        await unlink(`/proc/self/fd/${directory.fd}/${entry.name}`);
        removed++;
      } finally {
        await file.close();
      }
    }
    if (removed) await directory.sync();
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
      await rename(target, `/proc/self/fd/${directory.fd}/${packId}.json`);
      await directory.sync();
      return true;
    } finally {
      await file?.close();
      await unlink(target).catch(() => undefined);
    }
  });
  if (!success) throw new Error('Map job storage unavailable');
}
export const mapJobRetrySeconds = 300;
export function canRetryMapResult(result: MapJobResult, at = Math.floor(Date.now() / 1000)) {
  return (
    result.status === 'failed' &&
    ['source_unavailable', 'storage_limit', 'preparation_failed', 'worker_interrupted'].includes(
      result.code || '',
    ) &&
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
      if (++retained > mapJobLimits.retained || (newRequest && retained >= mapJobLimits.retained))
        return false;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) return false;
      const result = await readMapResult(root, entry.name.slice(0, -5));
      if (!result || result.status === 'processing') pending++;
      if (pending >= mapJobLimits.jobs) return false;
    }
    return true;
  });
}
let enqueueQueue: Promise<unknown> = Promise.resolve();
export function enqueueMapRequest(
  root: string,
  approval: ApprovedMapEntry,
): Promise<'queued' | 'existing' | 'full'> {
  const operation = enqueueQueue.then(async () => {
    const packId = mapPackId(approval);
    await prepareMapJobs(root);
    if (await readMapRequest(root, packId)) return 'existing' as const;
    if (!(await queueHasRoom(root, true))) return 'full' as const;
    await atomicMapJobWrite(root, 'requests', packId, {
      schemaVersion: 1,
      packId,
      generation: randomBytes(16).toString('hex'),
      approval,
    });
    return 'queued' as const;
  });
  enqueueQueue = operation.catch(() => undefined);
  return operation;
}
/** Failed results are terminal for the worker. Only an explicitly authorized
 * HTTP request can remove an eligible terminal result after the cooldown.
 * Serializing with enqueues also preserves the global pending-job reservation. */
export function retryMapRequest(
  root: string,
  approval: ApprovedMapEntry,
  at = Math.floor(Date.now() / 1000),
  { removeResult = unlink }: { removeResult?: (path: string) => Promise<void> } = {},
): Promise<'queued' | 'ineligible' | 'full'> {
  const operation = enqueueQueue.then(async () => {
    const packId = mapPackId(approval),
      request = await readMapRequest(root, packId),
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
      await removeResult(`/proc/self/fd/${directory.fd}/${packId}.json`);
      await directory.sync();
      return true;
    });
    return removed ? ('queued' as const) : ('ineligible' as const);
  });
  enqueueQueue = operation.catch(() => undefined);
  return operation;
}
export async function mapWorkerAvailable(root: string, at = Math.floor(Date.now() / 1000)) {
  return (
    (await withDirectory(root, [], async (directory) => {
      const file = await regularFile(directory, 'worker-status.json', 2, 1024);
      if (!file) return false;
      try {
        const before = await fileVersion(file),
          data = await bytesFrom(file, (await file.stat()).size, 1024);
        const status = mapWorkerStatusSchema.parse(JSON.parse(data.toString('utf8')));
        return (
          before === (await fileVersion(file)) &&
          status.updatedAt <= at + 5 &&
          status.updatedAt >= at - 90
        );
      } finally {
        await file.close();
      }
    })) ?? false
  );
}
