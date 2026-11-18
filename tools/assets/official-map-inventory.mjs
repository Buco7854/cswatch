/** Fixed official Steam metadata discovery. The wildcard is a worker-owned
 * listing selector only. It is never passed to download or supplied by a caller. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  officialMapInventorySchema,
  officialMapInventoryLimits,
} from '../../backend/dist/map-catalog.js';
import { writeOfficialMapInventory } from '../../backend/dist/map-jobs.js';
import { prepareToolchain } from './prepare-toolchain.mjs';
import { runAssetProcess } from './install-steam-assets.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { checkStorage, checkFreeReserve } from './asset-storage.mjs';
import {
  selectedSteamManifest,
  steamAssetLimits,
  STEAM_APP,
  STEAM_DEPOT,
} from './steam-assets-plan.mjs';

/** Apply only to the trusted Steam downloader, never a converter's exit code. */
export function markSteamRateLimit(error) {
  if (error?.exitCode === 4) {
    error.code = 'STEAM_RATE_LIMIT';
    return true;
  }
  return error?.code === 'STEAM_RATE_LIMIT';
}

export function parseOfficialMapInventory(text, at = Math.floor(Date.now() / 1000)) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > officialMapInventoryLimits.bytes)
    throw Error('Official map metadata exceeds its bound.');
  let manifest;
  const maps = [],
    seen = new Set();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length > 2048) throw Error('Official map listing entry bound exceeded.');
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 5 || fields[0] !== STEAM_DEPOT || !/^[a-f0-9]{40}$/i.test(fields[2]))
      throw Error('Invalid official map listing.');
    const version = selectedSteamManifest(fields[1]);
    if (manifest !== undefined && version !== manifest)
      throw Error('Mixed official map source versions.');
    manifest = version;
    if (!/^[1-9]\d{0,15}$/.test(fields[3])) throw Error('Invalid official map source size.');
    const bytes = Number(fields[3]);
    if (!Number.isSafeInteger(bytes) || bytes > steamAssetLimits.selectedBytes)
      throw Error('Official map source exceeds its bound.');
    const direct = /^game\/csgo\/maps\/([a-z][a-z0-9_]{1,79})\.vpk$/.exec(fields[4]);
    if (!direct) {
      // Some pinned listing implementations match descendants. They may be
      // observed, but only bare official map VPKs become public membership.
      if (!/^game\/csgo\/maps\/(?:[a-z0-9_]{1,100}\/){1,8}[a-z0-9_]{1,100}\.vpk$/.test(fields[4]))
        throw Error('Unexpected official map resource.');
      continue;
    }
    if (seen.has(direct[1]) || maps.length >= officialMapInventoryLimits.maps)
      throw Error('Duplicate or excessive official map membership.');
    seen.add(direct[1]);
    maps.push({ map: direct[1], sha1: fields[2].toLowerCase(), bytes });
  }
  if (!manifest || !maps.length)
    throw Error('Official map source contains no supported map names.');
  maps.sort((a, b) => (a.map < b.map ? -1 : a.map > b.map ? 1 : 0));
  return officialMapInventorySchema.parse({
    schemaVersion: 1,
    appId: 730,
    depotId: 2347770,
    manifest,
    updatedAt: at,
    maps,
  });
}

export async function refreshOfficialMapInventory(options, adapters = {}) {
  await localDirectory(options.cache, true);
  await checkStorage(options.cache, options.assets);
  const root = await mkdtemp(join(options.cache, '.official-inventory-'));
  const home = join(root, 'home'),
    temporary = join(root, 'tmp');
  for (const path of [home, temporary]) await mkdir(path, { mode: 0o700 });
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    const tools = await (adapters.prepareToolchain || prepareToolchain)({
      cache: join(options.cache, 'tools'),
      signal,
    });
    let result;
    try {
      result = await (adapters.run || runAssetProcess)(
        tools.downloader,
        ['ls', STEAM_APP, STEAM_DEPOT, '--anonymous', '--', 'game/csgo/maps/*.vpk'],
        {
          cwd: root,
          home,
          temporary,
          signal,
          timeoutMs: 120000,
          log: join(root, 'listing.log'),
          storageGuard: () => checkFreeReserve(options.cache, options.assets),
        },
      );
    } catch (error) {
      markSteamRateLimit(error);
      throw error;
    }
    if (result.code === 4)
      throw Object.assign(Error('Steam login rate limit.'), {
        code: 'STEAM_RATE_LIMIT',
        exitCode: 4,
      });
    if (result.code !== 0) throw Error('Official map inventory is unavailable.');
    const inventory = parseOfficialMapInventory(result.stdout);
    await writeOfficialMapInventory(options.jobs, inventory);
    return inventory;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
