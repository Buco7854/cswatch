#!/usr/bin/env node
/** Read-only planning for one fixed native first-person prototype. Never acquires or converts. */
import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readVpkDirectory, source2References } from './source2-dependencies.mjs';
import {
  selectedSteamManifest,
  STEAM_APP,
  STEAM_DEPOT,
  steamAssetLimits,
} from './steam-assets-plan.mjs';

// A small source-specific starting point, not a registry of supported runtime rigs.
export const viewmodelSourceSeeds = Object.freeze({
  arms: 'weapons/models/shared/arms/weapon_arms.vmdl_c',
  weapon: 'weapons/models/ak47/weapon_rif_ak47.vmdl_c',
  idle: 'animation/anims/viewmodel/rifle/rifle_ak/idle_ak.vnmclip_c',
  fire: 'animation/anims/viewmodel/rifle/rifle_ak/shoot1_ak.vnmclip_c',
  reload: 'animation/anims/viewmodel/rifle/rifle_ak/reload_ak.vnmclip_c',
});
export const viewmodelSources = Object.freeze({
  ak47: viewmodelSourceSeeds,
  m4a4: Object.freeze({
    arms: viewmodelSourceSeeds.arms,
    weapon: 'weapons/models/m4a4/weapon_rif_m4a4.vmdl_c',
    idle: 'animation/anims/viewmodel/rifle/rifle_m4a4/idle_m4a4.vnmclip_c',
    fire: 'animation/anims/viewmodel/rifle/rifle_m4a4/shoot1_m4a4.vnmclip_c',
    reload: 'animation/anims/viewmodel/rifle/rifle_m4a4/reload_m4a4.vnmclip_c',
  }),
  awp: Object.freeze({
    arms: viewmodelSourceSeeds.arms,
    weapon: 'weapons/models/awp/weapon_snip_awp.vmdl_c',
    idle: 'animation/anims/viewmodel/rifle/rifle_awp/idle_awp.vnmclip_c',
    fire: 'animation/anims/viewmodel/rifle/rifle_awp/shoot1_awp.vnmclip_c',
    reload: 'animation/anims/viewmodel/rifle/rifle_awp/reload_awp.vnmclip_c',
  }),
  glock: Object.freeze({
    arms: viewmodelSourceSeeds.arms,
    weapon: 'weapons/models/glock18/weapon_pist_glock18.vmdl_c',
    idle: 'animation/anims/viewmodel/pistol/pistol_glock18/idle_glock.vnmclip_c',
    fire: 'animation/anims/viewmodel/pistol/pistol_glock18/shoot1_glock.vnmclip_c',
    reload: 'animation/anims/viewmodel/pistol/pistol_glock18/reload_glock.vnmclip_c',
  }),
});
const limits = Object.freeze({
  resources: 512,
  resourceBytes: 32 * 1024 ** 2,
  readBytes: 128 * 1024 ** 2,
  selectedBytes: 512 * 1024 ** 2,
  outputBytes: 1024 ** 2,
});
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Payload floor only. Steam chunk transfer and converter scratch are not entry sizes. */
export function viewmodelSourceBudget({ missingSourceBytes, availableBytes }) {
  if (!integer(missingSourceBytes) || !integer(availableBytes))
    throw Error('Invalid source-cache disk observation.');
  const reserveBytes = steamAssetLimits.reserveBytes;
  if (!Number.isSafeInteger(reserveBytes + missingSourceBytes))
    throw Error('The source-cache budget exceeds its numeric bound.');
  return {
    reserveBytes,
    sourceCacheAvailableBytes: availableBytes,
    reserveSatisfied: availableBytes >= reserveBytes,
    minimumAdditionalSourceCacheBytes: Math.max(
      0,
      reserveBytes + missingSourceBytes - availableBytes,
    ),
    steamTransferBytes: null,
    conversionHeadroomBytes: null,
    isCompletePreparationEstimate: false,
  };
}

export async function inspectViewmodelSource({ game, manifest, weapon = 'ak47' }, adapters = {}) {
  if (typeof game !== 'string' || !game) throw Error('Provide an existing local source cache.');
  if (!Object.hasOwn(viewmodelSources, weapon)) throw Error('Unsupported fixed weapon source.');
  const selected = viewmodelSources[weapon];
  const seeds = Object.values(selected);
  manifest = selectedSteamManifest(manifest);
  game = resolve(game);
  const sources = [];
  for (const group of ['csgo', 'core']) {
    const index = await (adapters.index ?? readVpkDirectory)(
      join(game, `game/${group}/pak01_dir.vpk`),
    );
    if (
      !/^[0-9a-f]{64}$/.test(index.provenance?.sha256 ?? '') ||
      !integer(index.provenance.bytes) ||
      !integer(index.provenance.entries)
    )
      throw Error('Invalid bounded local index evidence.');
    sources.push({ group, index });
  }
  const queue = [...seeds],
    queued = new Set(queue),
    resources = [],
    missingFromIndex = [],
    excludedAnimationResources = [];
  let selectedBytes = 0,
    seedBytes = 0,
    verifiedBytes = 0,
    attemptedBytes = 0,
    missingBytes = 0,
    overLimitBytes = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const resource = queue[cursor];
    if (
      /\.(?:vnmgraph|vnmclip|vanim|vagrp|vseq|vgcxdata)_c$/.test(resource) &&
      !seeds.includes(resource)
    ) {
      excludedAnimationResources.push(resource);
      continue;
    }
    const source = sources.find(({ index }) => index.entries.has(resource));
    if (!source) {
      missingFromIndex.push(resource);
      continue;
    }
    const entry = source.index.entries.get(resource),
      bytes = entry.length + entry.preloadBytes;
    if (!integer(entry.length) || !integer(entry.preloadBytes) || !integer(bytes))
      throw Error('Invalid local resource byte count.');
    selectedBytes += bytes;
    if (seeds.includes(resource)) seedBytes += bytes;
    if (selectedBytes > limits.selectedBytes)
      throw Error('The fixed viewmodel planning payload exceeds 512 MiB.');
    const row = { group: source.group, resource, bytes };
    if (bytes > limits.resourceBytes) {
      resources.push({ ...row, status: 'uninspected_over_limit' });
      overLimitBytes += bytes;
      continue;
    }
    // Incomplete sparse entries still count toward the attempted-read budget.
    attemptedBytes += bytes;
    if (attemptedBytes > limits.readBytes)
      throw Error('The fixed viewmodel planning reads exceed 128 MiB.');
    const payload = await source.index.readEntry(resource);
    if (!payload) {
      resources.push({ ...row, status: 'missing_or_crc_invalid' });
      missingBytes += bytes;
      continue;
    }
    if (!Buffer.isBuffer(payload) || payload.length !== bytes)
      throw Error('Local resource verification returned contradictory bytes.');
    verifiedBytes += payload.length;
    resources.push({ ...row, status: 'crc_verified', sha256: hash(payload) });
    for (const dependency of source2References(payload, {
      limits: { resourceBytes: limits.resourceBytes, references: 1024 },
    })) {
      if (queued.has(dependency)) continue;
      if (queue.length >= limits.resources)
        throw Error('The fixed viewmodel planning graph exceeds 512 resources.');
      queued.add(dependency);
      queue.push(dependency);
    }
  }
  const disk = await (adapters.statfs ?? statfs)(game),
    availableBytes = disk.bavail * disk.bsize;
  const result = {
    schemaVersion: 1,
    scope: `fixed-${weapon}-first-person-source-plan`,
    source: {
      app: STEAM_APP,
      depot: STEAM_DEPOT,
      manifest,
      evidence: 'operator-selected-local-indexes',
      officialSourceRevalidated: false,
      indexes: sources.map(({ group, index: { provenance } }) => ({
        group,
        sha256: provenance.sha256,
        bytes: provenance.bytes,
        entries: provenance.entries,
      })),
    },
    seeds: selected,
    resources,
    missingFromIndex,
    excludedAnimationResources,
    sourceBytes: {
      indexedSeeds: seedBytes,
      indexedKnownClosure: selectedBytes,
      crcVerifiedCached: verifiedBytes,
      attemptedReads: attemptedBytes,
      missingOrCrcInvalid: missingBytes,
      uninspectedOverLimit: overLimitBytes,
      isLowerBound: missingBytes > 0 || missingFromIndex.length > 0 || overLimitBytes > 0,
    },
    boundedResourceClosureComplete:
      missingBytes === 0 && missingFromIndex.length === 0 && overLimitBytes === 0,
    shaderPreflightPerformed: false,
    budget: viewmodelSourceBudget({ missingSourceBytes: missingBytes, availableBytes }),
    limitations: [
      'Local directory names and a supplied manifest do not prove official source provenance',
      'Missing payloads can hide further model, skeleton, material and texture dependencies',
      'Entry bytes do not measure Steam chunks, filesystem allocation or conversion scratch',
      'Full animation graphs and unregistered clips are deliberately excluded',
      'No export, rig compatibility, preparation or runtime arms/actions are verified by this report',
    ],
  };
  if (Buffer.byteLength(JSON.stringify(result)) > limits.outputBytes)
    throw Error('The viewmodel planning report exceeds 1 MiB.');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        game: { type: 'string' },
        manifest: { type: 'string' },
        weapon: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help || !values.game || !values.manifest) {
      console.log(
        'Usage: node inspect-viewmodel-source.mjs --game PRIVATE_STEAM_CACHE --manifest EXACT_MANIFEST [--weapon ak47|m4a4|awp|glock]\nRead-only fixed arms, idle, fire and reload source evidence and payload lower bound. No downloads or conversion.',
      );
      process.exitCode = values.help ? 0 : 1;
    } else console.log(JSON.stringify(await inspectViewmodelSource(values), null, 2));
  } catch {
    console.error('Viewmodel source inspection failed. No assets were changed.');
    process.exitCode = 1;
  }
}
