/** Official agent models recorded by ready demos, published for the asset worker. The request
 * holds only catalogue handles: no demo, owner or path ever reaches the worker. */
import { constants, fsyncSync, renameSync } from 'node:fs';
import { open, opendir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { bytesFrom, fileVersion, regularFile, withDirectory } from './map-asset-files.js';
import type { Store } from './db.js';

const shared = (await import(
  import.meta.url.endsWith('.ts') ? '../../shared/agent-models.mjs' : './agent-models.mjs'
)) as typeof import('../../shared/agent-models.mjs');
export const { officialAgentModels, agentModelLimits, agentModelHandle } = shared;

const requestName = 'agent-model-requests.json';
const temporaryName = /^\.agent-model-requests-[a-f0-9]{24}\.tmp$/;
const requestSchema = z
  .object({
    schemaVersion: z.literal(1),
    handles: z
      .array(z.string().refine((handle) => officialAgentModels.has(handle)))
      .max(agentModelLimits.catalogue),
  })
  .strict()
  .refine(({ handles }) => new Set(handles).size === handles.length);

type RecordedPlayer = { alive?: boolean; agentModel?: string };
/** Distinct recorded model handles of living players, in first-seen order. */
export function recordedAgentModels(frames: Iterable<{ players: RecordedPlayer[] }>) {
  const seen = new Set<string>();
  for (const frame of frames)
    for (const player of frame.players)
      if (player.agentModel && agentModelHandle(player.agentModel)) {
        seen.add(player.agentModel);
        if (seen.size >= agentModelLimits.perDemo) return [...seen];
      }
  return [...seen];
}

/** Catalogue agents recorded by any ready demo, sorted. Team defaults are never listed. */
export function requestedAgentModels(db: Store): string[] {
  const rows = db.all(
    `SELECT DISTINCT j.value AS handle FROM demos d, json_each(d.metadata,'$.agentModels') j
     WHERE d.status='ready' AND json_valid(d.metadata) AND json_type(d.metadata,'$.agentModels')='array'
     LIMIT 8192`,
  );
  return [
    ...new Set(
      rows
        .map((row) => String(row.handle))
        .filter((handle) => agentModelHandle(handle) && officialAgentModels.has(handle)),
    ),
  ].sort();
}

export async function readAgentModelRequests(jobs: string): Promise<string[]> {
  return (
    (await withDirectory(jobs, [], async (directory) => {
      let file;
      try {
        file = await regularFile(directory, requestName, 2, agentModelLimits.requestBytes);
        if (!file) return [];
        const info = await file.stat();
        if (info.mode & 0o022 || info.uid !== process.getuid?.()) return [];
        const version = await fileVersion(file),
          data = await bytesFrom(file, info.size, agentModelLimits.requestBytes);
        if (version !== (await fileVersion(file))) return [];
        return requestSchema.parse(JSON.parse(data.toString('utf8'))).handles;
      } catch {
        return [];
      } finally {
        await file?.close();
      }
    })) ?? []
  );
}

let writeQueue: Promise<unknown> = Promise.resolve();
/** Single-web serialized publication; unchanged requests are not rewritten. */
export function writeAgentModelRequests(jobs: string, handles: string[]) {
  const operation = writeQueue.then(async () => {
    const value = requestSchema.parse({ schemaVersion: 1, handles: [...handles].sort() });
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > agentModelLimits.requestBytes)
      throw Error('Agent model request exceeds its bound.');
    if (JSON.stringify(await readAgentModelRequests(jobs)) === JSON.stringify(value.handles))
      return false;
    const written = await withDirectory(jobs, [], async (directory) => {
      const temporary = `/proc/self/fd/${directory.fd}/.agent-model-requests-${randomBytes(12).toString('hex')}.tmp`;
      let file, staged: string | undefined;
      try {
        file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o640,
        );
        staged = temporary;
        await file.writeFile(data);
        await file.sync();
        await file.close();
        file = undefined;
        renameSync(temporary, `/proc/self/fd/${directory.fd}/${requestName}`);
        staged = undefined;
        fsyncSync(directory.fd);
        return true;
      } finally {
        await file?.close();
        if (staged) await unlink(staged).catch(() => undefined);
      }
    });
    if (!written) throw Error('Agent model request could not be published.');
    return true;
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

/** Startup only, before any live write: reclaim this module's orphan temporary files. */
export async function cleanupAgentModelRequestTemps(jobs: string): Promise<number> {
  return (
    (await withDirectory(jobs, [], async (directory) => {
      const folder = await opendir(`/proc/self/fd/${directory.fd}`);
      let scanned = 0,
        removed = 0;
      for await (const entry of folder) {
        if (++scanned > 1024) throw Error('Agent model request startup scan exceeds its bound.');
        if (!entry.isFile() || !temporaryName.test(entry.name)) continue;
        let file;
        try {
          file = await regularFile(directory, entry.name, 0, agentModelLimits.requestBytes);
          if (!file) continue;
          const info = await file.stat();
          if (info.uid !== process.getuid?.() || info.mode & 0o022) continue;
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

/** Keep the published request equal to what ready demos record. */
export function syncAgentModelRequests(
  db: Store,
  jobs: string,
  log: (error: unknown) => void,
  everyMs = 60000,
) {
  const sync = () =>
    writeAgentModelRequests(jobs, requestedAgentModels(db)).catch((error) => log(error));
  void sync();
  const timer = setInterval(sync, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
