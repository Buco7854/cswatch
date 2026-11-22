/** Shared disk protocol for administrator-requested deletion. No app/database imports. */
import { constants } from 'node:fs';
import { open, opendir, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ManagedMap, MapJobRequest, MapJobResult } from '../../shared/map-acquisition.js';
import { officialMapName } from './map-identity.js';
import { canonicalMapApproval, latestMapPackMarkerSchema, mapPackId } from './map-catalog.js';
import {
  mapJobTemporaryName,
  packIdSchema,
  prepareMapJobs,
  readMapRequest,
  readMapResult,
  latestMapResultMatches,
} from './map-jobs.js';
import { withDirectory, regularFile, bytesFrom, fileVersion } from './map-asset-files.js';

export const mapRemovalLimits = { retained: 512, pending: 32, scanned: 1024, bytes: 2048 } as const;
export const mapRemovalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    packId: packIdSchema,
    requestId: packIdSchema,
    generation: z.string().regex(/^[a-f0-9]{32}$/),
    removalId: z.string().regex(/^[a-f0-9]{32}$/),
    map: officialMapName,
    manifest: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((value) => BigInt(value) <= 18446744073709551615n),
    preparedAt: z.number().int().min(0).max(8640000000000),
    markerSha256: packIdSchema,
    requestedAt: z.number().int().min(0).max(8640000000000),
  })
  .strict();
export type MapRemovalRequest = z.infer<typeof mapRemovalRequestSchema>;
export const mapRemovalResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    packId: packIdSchema,
    removalId: z.string().regex(/^[a-f0-9]{32}$/),
    status: z.enum(['removed', 'failed']),
    updatedAt: z.number().int().min(0).max(8640000000000),
    code: z.enum(['files_changed', 'request_changed', 'removal_failed']).optional(),
  })
  .strict()
  .refine((value) => (value.status === 'failed') === (value.code !== undefined));
export type MapRemovalResult = z.infer<typeof mapRemovalResultSchema>;

export async function mapQueueIds(jobs: string, folder: 'requests' | 'removals') {
  const result = await withDirectory(jobs, [folder], async (directory) => {
    try {
      const entries = await opendir(`/proc/self/fd/${directory.fd}`);
      const ids: string[] = [];
      let scanned = 0;
      for await (const entry of entries) {
        if (++scanned > mapRemovalLimits.scanned) throw Error('Map management scan limit');
        if (entry.isFile() && mapJobTemporaryName.test(entry.name)) continue;
        if (
          !entry.isFile() ||
          !/^[a-f0-9]{64}\.json$/.test(entry.name) ||
          ids.length >= mapRemovalLimits.retained
        )
          throw Error('Unexpected map management entry');
        ids.push(entry.name.slice(0, -5));
      }
      return { ids: ids.sort() };
    } catch {
      return { invalid: true as const };
    }
  });
  if (result && 'invalid' in result) throw Error('Map management queue is invalid');
  return result?.ids ?? [];
}
async function readRecord<T>(jobs: string, folder: string, packId: string, schema: z.ZodType<T>) {
  if (!packIdSchema.safeParse(packId).success) return;
  let invalid = false;
  const record = await withDirectory(jobs, [folder], async (directory) => {
    let file;
    try {
      file = await regularFile(directory, `${packId}.json`, 2, mapRemovalLimits.bytes);
      if (!file) throw Error('Unsafe map management record');
      const info = await file.stat();
      if (info.uid !== process.getuid?.() || info.mode & 0o022)
        throw Error('Unsafe map management owner');
      const before = await fileVersion(file);
      const data = await bytesFrom(file, info.size, mapRemovalLimits.bytes);
      if (before !== (await fileVersion(file))) throw Error('Changed map management record');
      const value = schema.parse(JSON.parse(data.toString('utf8')));
      if ((value as { packId: string }).packId !== packId)
        throw Error('Wrong map management identity');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = true;
    } finally {
      await file?.close();
    }
  });
  if (invalid) throw Error('Invalid map management record');
  return record;
}
export const readMapRemoval = (jobs: string, packId: string) =>
  readRecord(jobs, 'removals', packId, mapRemovalRequestSchema);
export const readMapRemovalResult = (jobs: string, packId: string) =>
  readRecord(jobs, 'removal-results', packId, mapRemovalResultSchema);
export async function pendingMapRemoval(jobs: string, packId: string) {
  const removal = await readMapRemoval(jobs, packId);
  if (!removal) return false;
  const result = await readMapRemovalResult(jobs, packId);
  return !result || result.removalId !== removal.removalId;
}
/** A failed cleanup still owns its quarantined bytes. Finish it before a new
 * acquisition generation can make its cleanup authority obsolete. */
export async function unsettledMapRemoval(jobs: string, packId: string) {
  const removal = await readMapRemoval(jobs, packId);
  if (!removal) return false;
  const result = await readMapRemovalResult(jobs, packId);
  return !result || result.removalId !== removal.removalId || result.status !== 'removed';
}
async function writeRecord(
  jobs: string,
  folder: string,
  value: MapRemovalRequest | MapRemovalResult,
) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > mapRemovalLimits.bytes) throw Error('Map management record limit');
  if (folder === 'removals') await readMapRemoval(jobs, value.packId);
  else await readMapRemovalResult(jobs, value.packId);
  const success = await withDirectory(jobs, [folder], async (directory) => {
    const temporary = `/proc/self/fd/${directory.fd}/.${value.packId}-${randomBytes(12).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o640,
      );
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, `/proc/self/fd/${directory.fd}/${value.packId}.json`);
      await directory.sync();
      return true;
    } finally {
      await file?.close();
      await unlink(temporary).catch(() => undefined);
    }
  });
  if (!success) throw Error('Map management queue unavailable');
}
export function writeMapRemovalResult(jobs: string, result: MapRemovalResult) {
  return writeRecord(jobs, 'removal-results', mapRemovalResultSchema.parse(result));
}
export function managedPackId(request: MapJobRequest, result: MapJobResult) {
  return request.kind === 'latest-official'
    ? latestMapResultMatches(request, result)
      ? result.assetPackId
      : undefined
    : request.packId === mapPackId(request.approval)
      ? request.packId
      : undefined;
}
export async function inspectManagedPack(
  assets: string,
  request: MapJobRequest,
  result: MapJobResult,
) {
  const packId = managedPackId(request, result);
  if (!packId) return;
  return withDirectory(assets, ['packs', packId], async (directory) => {
    const file = await regularFile(directory, 'pack.json', 2, 16384);
    if (!file) return;
    try {
      const before = await fileVersion(file);
      const bytes = await bytesFrom(file, (await file.stat()).size, 16384);
      if (before !== (await fileVersion(file))) return;
      const marker = JSON.parse(bytes.toString('utf8'));
      let map: string, manifest: string, preparedAt: number;
      if (request.kind === 'latest-official') {
        const latest = latestMapPackMarkerSchema.parse(marker);
        if (
          latest.packId !== packId ||
          latest.requestId !== request.packId ||
          JSON.stringify(latest.selection) !== JSON.stringify(request.selection) ||
          JSON.stringify(latest.source) !== JSON.stringify(result.source)
        )
          return;
        map = latest.selection.map;
        manifest = latest.source.manifest;
        preparedAt = latest.preparedAt;
      } else {
        if (
          !marker ||
          Object.keys(marker).sort().join(',') !== 'approval,packId,preparedAt,schemaVersion' ||
          marker.schemaVersion !== 1 ||
          marker.packId !== packId ||
          marker.approval !== canonicalMapApproval(request.approval) ||
          !Number.isSafeInteger(marker.preparedAt) ||
          marker.preparedAt < 0 ||
          marker.preparedAt > Date.now() / 1000 + 300
        )
          return;
        map = request.approval.identity.map;
        manifest = request.approval.source.manifest;
        preparedAt = marker.preparedAt;
      }
      return {
        packId,
        map,
        manifest,
        preparedAt,
        version: createHash('sha256').update(bytes).digest('hex'),
      };
    } finally {
      await file.close();
    }
  });
}
export async function listManagedMaps(assets: string, jobs: string): Promise<ManagedMap[]> {
  const maps: ManagedMap[] = [];
  for (const requestId of await mapQueueIds(jobs, 'requests')) {
    const request = await readMapRequest(jobs, requestId),
      result = await readMapResult(jobs, requestId);
    if (!request || result?.status !== 'ready') continue;
    const pack = await inspectManagedPack(assets, request, result);
    if (!pack) continue;
    const removal = await readMapRemoval(jobs, pack.packId),
      outcome = await readMapRemovalResult(jobs, pack.packId);
    const current =
      removal?.markerSha256 === pack.version && removal.generation === request.generation;
    maps.push({
      ...pack,
      removal: current
        ? outcome?.removalId === removal.removalId
          ? outcome.status === 'failed'
            ? 'failed'
            : 'none'
          : 'queued'
        : 'none',
    });
  }
  for (const id of await mapQueueIds(jobs, 'removals')) {
    if (maps.some((map) => map.packId === id)) continue;
    const removal = await readMapRemoval(jobs, id),
      outcome = await readMapRemovalResult(jobs, id);
    if (!removal || (outcome?.removalId === removal.removalId && outcome.status === 'removed'))
      continue;
    const request = await readMapRequest(jobs, removal.requestId);
    if (!request || request.generation !== removal.generation) continue;
    maps.push({
      packId: id,
      map: removal.map,
      manifest: removal.manifest,
      preparedAt: removal.preparedAt,
      version: removal.markerSha256,
      removal: outcome?.removalId === removal.removalId ? 'failed' : 'queued',
    });
  }
  return maps.sort((a, b) => a.map.localeCompare(b.map) || b.preparedAt - a.preparedAt);
}
let queue: Promise<unknown> = Promise.resolve();
export function enqueueMapRemoval(
  assets: string,
  jobs: string,
  packId: string,
  version: string,
  authorize: () => void = () => {},
) {
  const operation = queue.then(async () => {
    packIdSchema.parse(packId);
    packIdSchema.parse(version);
    await prepareMapJobs(jobs);
    const existing = await readMapRemoval(jobs, packId);
    if (existing?.markerSha256 === version && (await pendingMapRemoval(jobs, packId))) {
      const request = await readMapRequest(jobs, existing.requestId);
      if (!request || request.generation !== existing.generation) return 'changed' as const;
      authorize();
      return 'queued' as const;
    }
    const ids = await mapQueueIds(jobs, 'removals');
    if (!ids.includes(packId) && ids.length >= mapRemovalLimits.retained) return 'full' as const;
    let pending = 0;
    for (const id of ids) {
      if (!(await readMapRemoval(jobs, id))) throw Error('Invalid map deletion record');
      if (await pendingMapRemoval(jobs, id)) pending++;
    }
    if (pending >= mapRemovalLimits.pending) return 'full' as const;
    if (existing?.markerSha256 === version) {
      const outcome = await readMapRemovalResult(jobs, packId),
        request = await readMapRequest(jobs, existing.requestId),
        result = await readMapResult(jobs, existing.requestId);
      if (
        outcome?.removalId === existing.removalId &&
        outcome.status === 'failed' &&
        request &&
        request.generation === existing.generation &&
        (result?.status === 'ready' || result?.code === 'removed_by_admin')
      ) {
        authorize();
        const cleared = await withDirectory(jobs, ['removal-results'], async (directory) => {
          const file = await regularFile(directory, `${packId}.json`, 2, mapRemovalLimits.bytes);
          if (!file) return false;
          await file.close();
          await unlink(`/proc/self/fd/${directory.fd}/${packId}.json`);
          await directory.sync();
          return true;
        });
        return cleared ? ('queued' as const) : ('changed' as const);
      }
    }
    for (const requestId of await mapQueueIds(jobs, 'requests')) {
      const request = await readMapRequest(jobs, requestId),
        result = await readMapResult(jobs, requestId);
      if (!request || result?.status !== 'ready' || managedPackId(request, result) !== packId)
        continue;
      const pack = await inspectManagedPack(assets, request, result);
      if (!pack || pack.version !== version) return 'changed' as const;
      authorize();
      await writeRecord(
        jobs,
        'removals',
        mapRemovalRequestSchema.parse({
          schemaVersion: 1,
          packId,
          requestId,
          generation: request.generation,
          removalId: randomBytes(16).toString('hex'),
          map: pack.map,
          manifest: pack.manifest,
          preparedAt: pack.preparedAt,
          markerSha256: version,
          requestedAt: Math.floor(Date.now() / 1000),
        }),
      );
      return 'queued' as const;
    }
    return 'changed' as const;
  });
  queue = operation.catch(() => undefined);
  return operation;
}
