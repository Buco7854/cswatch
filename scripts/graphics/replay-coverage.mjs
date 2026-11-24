// Offline join of local QA reports. The observed Steam inventory supplies every row.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { boundedFile } from './capture-report.mjs';

export function replayCoverage(inventory, frames) {
  assert(
    inventory.kind === 'cswatch-official-graphics-inventory' && Array.isArray(inventory.maps),
    'A readable official graphics inventory is required',
  );
  const maps = inventory.maps.map(({ map, packId, tiers }) => ({
    map,
    packId: packId ?? null,
    tiers,
    captures: [],
  }));
  const byMap = new Map(maps.map((row) => [row.map, row]));
  const outsideInventory = [];
  for (const frame of frames) {
    assert(
      frame.kind === 'cswatch-replay-frame' &&
        frame.schemaVersion === 1 &&
        frame.hudFree === true &&
        [frame.modelSha256, frame.replaySha256, frame.viewerBuildSha256].every((hash) =>
          /^[0-9a-f]{64}$/.test(hash),
        ) &&
        Number.isSafeInteger(frame.tick),
      'Expected a production replay capture report',
    );
    const row = byMap.get(frame.map);
    const tier = frame.status.mapTier;
    const timing = frame.playbackTiming;
    const matchesPack = Boolean(
      row?.packId &&
      row.packId === frame.packId &&
      row.tiers?.[tier]?.modelSha256 === frame.modelSha256,
    );
    const capture = {
      map: frame.map,
      tick: frame.tick,
      player: frame.player,
      replaySha256: frame.replaySha256,
      viewerBuildSha256: frame.viewerBuildSha256,
      modelSha256: frame.modelSha256,
      tier,
      matchesInventoryPack: matchesPack,
      mapVerification: frame.mapVerification,
      gpu: frame.gpu,
      viewport: frame.viewport,
      deviceScale: frame.deviceScale ?? 1,
      drawingBuffer: frame.buffer,
      displayedImage: frame.imageSize ?? frame.buffer,
      visualReference: frame.comparison.status,
      visualBudget: frame.verdict,
      breakables: frame.breakables ?? null,
      doors: frame.doors ?? null,
      playback: timing
        ? {
            camera: timing.cameraMode,
            status: timing.status,
            frames: timing.submittedFrames,
            assetsVerified: timing.assetsVerified,
            p95Ms: timing.p95Ms,
            timeWeightedP95Ms: timing.timeWeightedP95Ms,
            lowestDisplayScale: timing.lowestDisplayScale ?? null,
            lowestWorldScale: timing.lowestWorldScale ?? null,
            lowestPresentationScale: timing.lowestPresentationScale ?? null,
            minDisplayScale: timing.minDisplayScale ?? null,
            maxP95Ms: timing.maxP95Ms,
            budgetVerdict: timing.budgetVerdict,
          }
        : null,
    };
    (row?.captures ?? outsideInventory).push(capture);
  }
  return {
    manifest: inventory.manifest,
    inventoryStatus: inventory.status,
    coverage: {
      listedMaps: maps.length,
      mapsWithReplay: maps.filter((row) => row.captures.length).length,
      mapsWithInventoryPackReplay: maps.filter((row) =>
        row.captures.some((c) => c.matchesInventoryPack),
      ).length,
      mapsWithExternalFrame: maps.filter((row) =>
        row.captures.some((c) => c.visualReference === 'matched-external'),
      ).length,
      mapsMeetingDisplayAndTimeBudget: maps.filter((row) =>
        row.captures.some(
          (c) =>
            c.playback?.budgetVerdict === 'pass' &&
            c.playback.minDisplayScale != null &&
            c.playback.maxP95Ms != null,
        ),
      ).length,
    },
    maps: maps.map(({ map, packId, captures }) => ({ map, packId, captures })),
    outsideInventory,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      inventory: { type: 'string' },
      frame: { type: 'string', multiple: true, default: [] },
    },
  });
  assert(
    values.inventory && values.frame.length <= 4096,
    'Use --inventory FILE and one --frame FILE per capture',
  );
  const inventory = JSON.parse(await boundedFile(values.inventory, 32 * 1024 ** 2));
  const frames = [];
  for (const file of values.frame) frames.push(JSON.parse(await boundedFile(file, 128 * 1024)));
  console.log(JSON.stringify(replayCoverage(inventory, frames), null, 2));
}
