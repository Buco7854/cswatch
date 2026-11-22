/** Fixed, bounded worker-owned shared artwork status. No paths or native output. */
import { constants } from 'node:fs';
import { open, rename, unlink, opendir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { bytesFrom, regularFile, withDirectory, fileVersion } from './map-asset-files.js';
import type {
  PresentationStatus,
  PresentationKind,
  PresentationRetry,
} from '../../shared/presentation-assets.js';

export const presentationKinds = ['agents', 'equipment', 'equipment-models'] as const;
const category = z
  .object({
    manifest: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((value) => BigInt(value) <= 18446744073709551615n),
    generation: z.string().regex(/^[a-f0-9]{24}$/),
    status: z.enum(['preparing', 'ready', 'preserved', 'failed']),
    attempts: z.number().int().min(0).max(3),
    updatedAt: z.number().int().min(0).max(253402300799),
    retryAt: z.number().int().min(0).max(253402300799).optional(),
    stage: z.enum(['acquiring', 'converting', 'publishing']).optional(),
    item: z
      .string()
      .regex(/^[a-z0-9]{1,40}$/)
      .optional(),
    counts: z
      .object({
        ready: z.number().int().min(0).max(128),
        unavailable: z.number().int().min(0).max(128),
        total: z.number().int().min(0).max(128),
      })
      .strict()
      .optional(),
    unsupported: z
      .array(z.string().regex(/^[a-z0-9]{1,40}$/))
      .max(128)
      .optional(),
    code: z
      .enum([
        'interrupted',
        'timeout',
        'storage_limit',
        'source_mismatch',
        'steam_rate_limited',
        'preparation_failed',
      ])
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.counts ||
      (value.counts.ready + value.counts.unavailable <= value.counts.total &&
        (value.status !== 'ready' ||
          value.counts.ready + value.counts.unavailable === value.counts.total)),
  )
  .refine(
    (value) => !value.unsupported || new Set(value.unsupported).size === value.unsupported.length,
  )
  .refine(
    (value) =>
      !value.counts || !value.unsupported || value.counts.unavailable === value.unsupported.length,
  );
export const presentationStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    categories: z
      .object({
        agents: category.optional(),
        equipment: category.optional(),
        'equipment-models': category.optional(),
      })
      .strict(),
  })
  .strict();
export async function readPresentationStatus(
  jobs: string,
  strict = false,
): Promise<PresentationStatus | undefined> {
  let missing = false;
  const result = await withDirectory(jobs, [], async (directory) => {
    let file;
    try {
      file = await regularFile(directory, 'presentation-status.json', 2, 32768);
      if (!file) return;
      return presentationStatusSchema.parse(
        JSON.parse((await bytesFrom(file, (await file.stat()).size, 32768)).toString('utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
      return;
    } finally {
      await file?.close();
    }
  });
  if (strict && !result && !missing) throw Error('Private native presentation status is invalid.');
  return result;
}

const retrySchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.enum(presentationKinds),
    expectedGeneration: z.string().regex(/^[a-f0-9]{24}$/),
    expectedFailure: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
let retryQueue: Promise<unknown> = Promise.resolve();
type PresentationCategory = NonNullable<PresentationStatus['categories'][PresentationKind]>;
function canRetry(category: PresentationCategory | undefined): category is PresentationCategory {
  return Boolean(
    category &&
    category.status === 'failed' &&
    category.code !== 'source_mismatch' &&
    (category.retryAt || 0) <= Math.floor(Date.now() / 1000),
  );
}
/** Fixed-order authority fields prevent same-second/new-attempt failure collisions. */
function failureSnapshot(category: PresentationCategory) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        manifest: category.manifest,
        generation: category.generation,
        status: category.status,
        attempts: category.attempts,
        updatedAt: category.updatedAt,
        code: category.code ?? null,
        retryAt: category.retryAt ?? null,
        item: category.item ?? null,
        stage: category.stage ?? null,
        counts: category.counts
          ? {
              ready: category.counts.ready,
              unavailable: category.counts.unavailable,
              total: category.counts.total,
            }
          : null,
        unsupported: category.unsupported ?? null,
      }),
    )
    .digest('hex');
}
/** Single-web serialized enqueue. The intent captures worker generation, never a client source. */
export function enqueuePresentationRetry(
  jobs: string,
  kind: PresentationKind,
  authorize: () => void = () => {},
  { beforeRevalidate }: { beforeRevalidate?: () => Promise<void> } = {},
) {
  const operation = retryQueue.then(async (): Promise<'queued' | 'pending' | 'stale'> => {
    if (!presentationKinds.includes(kind)) return 'stale';
    const category = (await readPresentationStatus(jobs))?.categories[kind];
    if (!canRetry(category)) return 'stale';
    const expectedFailure = failureSnapshot(category);
    let failure: unknown;
    const result = await withDirectory(jobs, [], async (directory) => {
      const filename = `presentation-retry-${kind}.json`,
        target = `/proc/self/fd/${directory.fd}/${filename}`;
      let temporary: string | undefined, file;
      try {
        try {
          const pending = await regularFile(directory, filename, 2, 512);
          if (!pending) throw Error('Invalid presentation retry intent.');
          try {
            const checked = retrySchema.parse(
              JSON.parse(
                (await bytesFrom(pending, (await pending.stat()).size, 512)).toString('utf8'),
              ),
            );
            if (
              checked.kind !== kind ||
              checked.expectedGeneration !== category.generation ||
              checked.expectedFailure !== expectedFailure
            )
              return 'stale' as const;
          } finally {
            await pending.close();
          }
          return 'pending' as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        temporary = `/proc/self/fd/${directory.fd}/.presentation-retry-${randomBytes(12).toString('hex')}.tmp`;
        file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await file.writeFile(
          JSON.stringify({
            schemaVersion: 2,
            kind,
            expectedGeneration: category.generation,
            expectedFailure,
          }),
        );
        await file.sync();
        await file.close();
        file = undefined;
        await beforeRevalidate?.();
        const current = (await readPresentationStatus(jobs))?.categories[kind];
        if (
          !canRetry(current) ||
          current.generation !== category.generation ||
          failureSnapshot(current) !== expectedFailure
        )
          return 'stale' as const;
        authorize();
        await rename(temporary, target);
        temporary = undefined;
        await directory.sync();
        return 'queued' as const;
      } catch (error) {
        failure = error;
      } finally {
        await file?.close();
        if (temporary) await unlink(temporary).catch(() => undefined);
      }
    });
    if (failure) throw failure;
    if (!result) throw Error('Presentation retry could not be queued.');
    return result;
  });
  retryQueue = operation.catch(() => undefined);
  return operation;
}
/** Asset-worker only, under the same flock as conversion/publication. */
export async function consumePresentationRetries(jobs: string): Promise<PresentationRetry[]> {
  const resumed: PresentationRetry[] = [];
  for (const kind of presentationKinds)
    await withDirectory(jobs, [], async (directory) => {
      const name = `presentation-retry-${kind}.json`;
      let file;
      try {
        file = await regularFile(directory, name, 2, 512);
        if (!file) return;
        const request = retrySchema.parse(
          JSON.parse((await bytesFrom(file, (await file.stat()).size, 512)).toString('utf8')),
        );
        if (request.kind !== kind) return;
        const status = await readPresentationStatus(jobs),
          category = status?.categories[kind];
        if (
          status &&
          canRetry(category) &&
          category.generation === request.expectedGeneration &&
          failureSnapshot(category) === request.expectedFailure
        ) {
          status.categories[kind] = {
            ...category,
            attempts: 0,
            generation: randomBytes(12).toString('hex'),
            status: 'preparing',
            stage: 'acquiring',
            updatedAt: Math.floor(Date.now() / 1000),
          };
          delete status.categories[kind]!.code;
          await writePresentationStatus(jobs, status);
          resumed.push({
            kind,
            manifest: category.manifest,
            generation: status.categories[kind]!.generation,
          });
        }
        await unlink(`/proc/self/fd/${directory.fd}/${name}`);
        await directory.sync();
      } catch {
        /* Invalid/unsafe intent is never followed or removed. */
      } finally {
        await file?.close();
      }
    });
  return resumed;
}
export async function writePresentationStatus(jobs: string, status: PresentationStatus) {
  const bytes = Buffer.from(JSON.stringify(presentationStatusSchema.parse(status)) + '\n');
  if (bytes.length > 32768) throw Error('Presentation status exceeds its bound.');
  const saved = await withDirectory(jobs, [], async (directory) => {
    const temporary = `/proc/self/fd/${directory.fd}/.presentation-${randomBytes(12).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, `/proc/self/fd/${directory.fd}/presentation-status.json`);
      await directory.sync();
      return true;
    } finally {
      await file?.close();
      await unlink(temporary).catch(() => undefined);
    }
  });
  if (!saved) throw Error('Presentation status could not be saved.');
}

/** Coarse readiness only. Detailed failure/generation fields stay administrator-only. */
export async function presentationCatalogComplete(
  jobs: string | undefined,
  kind: PresentationKind,
  loaded: number,
): Promise<boolean | undefined> {
  if (!jobs) return;
  const category = (await readPresentationStatus(jobs))?.categories[kind];
  if (!category) return;
  if (category.status === 'preserved') return true;
  return category.status === 'ready' && (!category.counts || category.counts.ready === loaded);
}
/** Single-web startup only, before HTTP admission. Workers never remove web temporaries. */
export async function cleanupPresentationRetryTemps(jobs: string): Promise<number> {
  return (
    (await withDirectory(jobs, [], async (directory) => {
      const folder = await opendir(`/proc/self/fd/${directory.fd}`);
      let scanned = 0,
        removed = 0;
      for await (const entry of folder) {
        if (++scanned > 1024) throw Error('Presentation retry startup scan exceeds its bound.');
        if (!entry.isFile() || !/^\.presentation-retry-[a-f0-9]{24}\.tmp$/.test(entry.name))
          continue;
        let file;
        try {
          file = await regularFile(directory, entry.name, 0, 512);
          if (!file) continue;
          const info = await file.stat();
          if (info.uid !== process.getuid?.() || info.mode & 0o077) continue;
          const version = await fileVersion(file);
          if (version !== (await fileVersion(file))) continue;
          await unlink(`/proc/self/fd/${directory.fd}/${entry.name}`);
          removed++;
        } catch {
          /* Unknown or unsafe operator files remain untouched. */
        } finally {
          await file?.close();
        }
      }
      if (removed) await directory.sync();
      return removed;
    })) || 0
  );
}
