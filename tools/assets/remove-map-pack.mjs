/** Network-free administrator removal of exact worker-owned immutable packs.
 * Caller holds the same single-worker lock as map acquisition/publication. */
import { constants } from 'node:fs';
import { open, opendir, rmdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mapGradeFile } from '../../shared/map-grade.mjs';
import { regular } from './asset-storage.mjs';
import {
  mapQueueIds,
  readMapRemoval,
  readMapRemovalResult,
  writeMapRemovalResult,
  inspectManagedPack,
  managedPackId,
} from '../../backend/dist/map-removals.js';
import { readMapRequest, readMapResult, writeMapJobResult } from '../../backend/dist/map-jobs.js';
import { withDirectory, regularFile, bytesFrom } from '../../backend/dist/map-asset-files.js';
const defaultNetworkDeny = fileURLToPath(new URL('./bin/asset-network-deny', import.meta.url));

export function managedMapPaths(map) {
  const files = new Set(['pack.json', '.preparation.json', `maps/${map}/installation.json`]);
  for (const tier of ['desktop', 'mobile'])
    for (const name of ['scene.glb', 'manifest.json', 'texture-plan.json', 'visual-audit.json'])
      files.add(`maps/${map}/${tier}/${name}`);
  for (const name of ['scene.glb', 'manifest.json']) files.add(`maps/${map}/compact/${name}`);
  for (const name of ['overview.png', 'overview.json', 'provenance.json'])
    files.add(`maps/overviews/${map}/${name}`);
  for (const name of [
    'environment.json',
    mapGradeFile,
    'provenance.json',
    'px.png',
    'nx.png',
    'py.png',
    'ny.png',
    'pz.png',
    'nz.png',
  ])
    files.add(`maps/environments/${map}/${name}`);
  const directories = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index++)
      directories.add(parts.slice(0, index).join('/'));
  }
  return { files, directories };
}
/** Every recursion is descriptor-relative; neither preflight nor deletion follows
 * a child link. Foreign entries, hardlinks and special files fail closed. */
async function walk(
  directory,
  allowed,
  remove,
  prefix = '',
  state = { count: 0, bytes: 0 },
  signal,
  last = 'pack.json',
) {
  signal?.throwIfAborted();
  const info = await directory.stat();
  if (info.uid !== process.getuid() || !(info.mode & 0o200) || info.mode & 0o022)
    throw Object.assign(Error('Unsafe owned pack directory'), { removalCode: 'files_changed' });
  const entries = await opendir(`/proc/self/fd/${directory.fd}`);
  const names = [];
  for await (const entry of entries) {
    if (++state.count > 128)
      throw Object.assign(Error('Owned pack entry limit'), { removalCode: 'files_changed' });
    names.push(entry.name);
  }
  // Keep the immutable authorization marker until every other owned file is gone.
  names.sort((a, b) => (a === last ? 1 : b === last ? -1 : a.localeCompare(b)));
  for (const name of names) {
    signal?.throwIfAborted();
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = `/proc/self/fd/${directory.fd}/${name}`;
    if (allowed.directories.has(relative)) {
      const child = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await walk(child, allowed, remove, relative, state, signal, last);
      } finally {
        await child.close();
      }
      if (remove) {
        signal?.throwIfAborted();
        await rmdir(path);
      }
    } else if (allowed.files.has(relative)) {
      const file = await regularFile(
        directory,
        name,
        0,
        name === 'scene.glb' ? 2 * 1024 ** 3 : 8 * 1024 ** 2,
      );
      if (!file)
        throw Object.assign(Error('Unsafe owned pack file'), { removalCode: 'files_changed' });
      try {
        const fileInfo = await file.stat();
        if (
          fileInfo.uid !== process.getuid() ||
          fileInfo.mode & 0o022 ||
          (state.bytes += fileInfo.size) > 5 * 1024 ** 3
        )
          throw Object.assign(Error('Unsafe owned pack contents'), {
            removalCode: 'files_changed',
          });
      } finally {
        await file.close();
      }
      if (remove) {
        signal?.throwIfAborted();
        await unlink(path);
      }
    } else throw Object.assign(Error('Foreign pack entry'), { removalCode: 'files_changed' });
  }
}
async function markerMatches(directory, expected, allowEmpty) {
  try {
    const marker = await regularFile(directory, 'pack.json', 2, 16384);
    if (!marker) return false;
    try {
      const bytes = await bytesFrom(marker, (await marker.stat()).size, 16384);
      return createHash('sha256').update(bytes).digest('hex') === expected;
    } finally {
      await marker.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowEmpty) return false;
    const entries = await opendir(`/proc/self/fd/${directory.fd}`);
    for await (const _entry of entries) return false;
    return true;
  }
}
const changed = () =>
  Object.assign(Error('Map removal identity changed'), { removalCode: 'request_changed' });

/** Repair uses the same bounded allowlist and no-replace retirement as admin removal. */
export async function retireInvalidMapPack(options, request, packId, signal, ownedMarker) {
  const map =
    request.kind === 'latest-official' ? request.selection.map : request.approval.identity.map;
  const quarantine = `.removing-${packId}-${request.generation}`;
  if (!/^[a-f0-9]{64}$/.test(packId)) throw Error('Invalid repair identity.');
  let failure;
  const retired = await withDirectory(options.assets, ['packs'], async (packs) => {
    const parent = `/proc/self/fd/${packs.fd}`;
    const openDirectory = (name) =>
      open(
        `${parent}/${name}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    const verifyOwnership = async (directory, recovery = false) => {
      let file;
      try {
        file = await regularFile(directory, '.preparation.json', 2, 512);
        if (
          !file ||
          (await file.stat()).uid !== process.getuid() ||
          (await bytesFrom(file, (await file.stat()).size, 512)).toString() !== ownedMarker
        )
          throw Error('Map repair ownership differs.');
      } catch (error) {
        if (error.code !== 'ENOENT' || !recovery) throw error;
        for await (const _ of await opendir(`/proc/self/fd/${directory.fd}`)) throw error;
      } finally {
        await file?.close();
      }
    };
    let target, staged;
    try {
      target = await openDirectory(packId);
      if (target) {
        await verifyOwnership(target);
        await walk(target, managedMapPaths(map), false, '', { count: 0, bytes: 0 }, signal);
        signal.throwIfAborted();
        const boundary = options.networkDeny || defaultNetworkDeny;
        await regular(boundary, 1024 * 1024);
        const moved = spawnSync(
          boundary,
          [
            '--retire-map-pack',
            join(options.assets, 'packs', packId),
            join(options.assets, 'packs', quarantine),
          ],
          { stdio: 'ignore', timeout: 10000 },
        );
        if (moved.error || moved.status !== 0)
          throw Error('Exclusive map repair retirement failed.');
        await packs.sync();
      }
      staged = await openDirectory(quarantine);
      if (staged) {
        await verifyOwnership(staged, true);
        await walk(staged, managedMapPaths(map), false, '', { count: 0, bytes: 0 }, signal);
        await walk(
          staged,
          managedMapPaths(map),
          true,
          '',
          { count: 0, bytes: 0 },
          signal,
          '.preparation.json',
        );
        await rmdir(`${parent}/${quarantine}`);
        await packs.sync();
      }
      return true;
    } catch (error) {
      failure = error;
    } finally {
      await target?.close();
      await staged?.close();
    }
  });
  if (!retired) throw failure || Error('Map repair storage unavailable.');
}

export async function processOneMapRemoval(options) {
  for (const id of await mapQueueIds(options.jobs, 'removals')) {
    const removal = await readMapRemoval(options.jobs, id),
      previous = await readMapRemovalResult(options.jobs, id);
    if (!removal || previous?.removalId === removal.removalId) continue;
    if (options.signal?.aborted) return false;
    const timeout = AbortSignal.timeout(30000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const request = await readMapRequest(options.jobs, removal.requestId),
        result = await readMapResult(options.jobs, removal.requestId);
      if (
        !request ||
        !result ||
        request.generation !== removal.generation ||
        managedPackId(request, result) !== removal.packId ||
        !(
          result.status === 'ready' ||
          (result.status === 'failed' && result.code === 'removed_by_admin')
        )
      )
        throw changed();
      const quarantineName = `.removing-${removal.packId}-${removal.removalId}`;
      let failure;
      const handled = await withDirectory(options.assets, ['packs'], async (packs) => {
        const parent = `/proc/self/fd/${packs.fd}`;
        let target, quarantined;
        try {
          target = await open(
            `${parent}/${removal.packId}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ).catch((error) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          if (target) {
            if (result.status !== 'ready') throw changed();
            const pack = await inspectManagedPack(options.assets, request, result);
            if (
              !pack ||
              pack.version !== removal.markerSha256 ||
              pack.map !== removal.map ||
              pack.manifest !== removal.manifest
            )
              throw changed();
            await walk(
              target,
              managedMapPaths(removal.map),
              false,
              '',
              { count: 0, bytes: 0 },
              signal,
            );
            if (!(await markerMatches(target, removal.markerSha256, false))) throw changed();
            signal.throwIfAborted();
            // One no-replace syscall retires the pack. There is no mkdir/journal
            // crash gap, and every existing empty/nonempty/link target is preserved.
            const boundary = options.networkDeny || defaultNetworkDeny;
            await regular(boundary, 1024 * 1024);
            const retired = spawnSync(
              boundary,
              [
                '--retire-map-pack',
                join(options.assets, 'packs', removal.packId),
                join(options.assets, 'packs', quarantineName),
              ],
              {
                stdio: 'ignore',
                timeout: 10000,
                env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
              },
            );
            if (retired.error || retired.status !== 0)
              throw Error('Exclusive map retirement failed');
            await packs.sync();
          }
          quarantined = await open(
            `${parent}/${quarantineName}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ).catch((error) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          // A crash after removing the final empty directory is recoverable only
          // when the durable removed result already belongs to this generation.
          if (!quarantined) {
            if (result.code !== 'removed_by_admin') throw changed();
            return true;
          }
          if (
            !(await markerMatches(
              quarantined,
              removal.markerSha256,
              result.code === 'removed_by_admin',
            ))
          )
            throw changed();
          await walk(
            quarantined,
            managedMapPaths(removal.map),
            false,
            '',
            { count: 0, bytes: 0 },
            signal,
          );
          options.log?.({ event: 'map.removing', packId: removal.packId });
          signal.throwIfAborted();
          // Revoke future delivery/reacquisition before erasing the private tree.
          // Keeping a failed result requires an explicit normal owner retry later.
          await writeMapJobResult(options.jobs, {
            ...result,
            status: 'failed',
            code: 'removed_by_admin',
            updatedAt: Math.floor(Date.now() / 1000),
          });
          await walk(
            quarantined,
            managedMapPaths(removal.map),
            true,
            '',
            { count: 0, bytes: 0 },
            signal,
          );
          await rmdir(`${parent}/${quarantineName}`);
          await packs.sync();
          return true;
        } catch (error) {
          failure = error;
          return false;
        } finally {
          await target?.close();
          await quarantined?.close();
        }
      });
      if (failure) throw failure;
      if (!handled) throw Error('Map removal storage unavailable');
      await writeMapRemovalResult(options.jobs, {
        schemaVersion: 1,
        packId: removal.packId,
        removalId: removal.removalId,
        status: 'removed',
        updatedAt: Math.floor(Date.now() / 1000),
      });
      options.log?.({ event: 'map.removed', packId: removal.packId });
    } catch (error) {
      if (options.signal?.aborted) {
        options.log?.({ event: 'map.removal_interrupted', packId: removal.packId });
        return true;
      }
      const code = ['ELOOP', 'ENOTDIR'].includes(error.code)
        ? 'files_changed'
        : ['files_changed', 'request_changed'].includes(error.removalCode)
          ? error.removalCode
          : 'removal_failed';
      await writeMapRemovalResult(options.jobs, {
        schemaVersion: 1,
        packId: removal.packId,
        removalId: removal.removalId,
        status: 'failed',
        code,
        updatedAt: Math.floor(Date.now() / 1000),
      });
      options.log?.({ event: 'map.removal_failed', packId: removal.packId, code });
    }
    return true;
  }
  return false;
}
