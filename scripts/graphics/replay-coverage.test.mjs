import assert from 'node:assert/strict';
import test from 'node:test';
import { replayCoverage } from './replay-coverage.mjs';

test('the official list owns coverage rows and only the same generation and tier digest match', () => {
  const packId = 'a'.repeat(64),
    modelSha256 = 'b'.repeat(64);
  const inventory = {
    kind: 'cswatch-official-graphics-inventory',
    manifest: '123456',
    status: 'stale',
    maps: [{ map: 'de_test', packId, tiers: { mobile: { modelSha256 } } }, { map: 'de_new' }],
  };
  const frame = {
    kind: 'cswatch-replay-frame',
    schemaVersion: 1,
    hudFree: true,
    map: 'de_test',
    modelSha256,
    packId,
    status: { mapTier: 'mobile' },
    replaySha256: 'c'.repeat(64),
    viewerBuildSha256: 'd'.repeat(64),
    tick: 123,
    comparison: { status: 'no-reference' },
    verdict: 'not-evaluated',
    doors: { status: 'partial', matched: 1, missing: 2, stageMatched: 1 },
  };
  const result = replayCoverage(inventory, [
    frame,
    { ...frame, modelSha256: 'e'.repeat(64) },
    { ...frame, map: 'de_old' },
  ]);
  assert.deepEqual(result.maps[1].captures, []);
  assert.deepEqual(
    result.maps[0].captures.map((c) => c.matchesInventoryPack),
    [true, false],
  );
  assert.equal(result.maps[0].captures[0].playback, null);
  assert.deepEqual(result.maps[0].captures[0].doors, frame.doors);
  assert.equal(result.outsideInventory.length, 1);
  assert.deepEqual(result.coverage, {
    listedMaps: 2,
    mapsWithReplay: 1,
    mapsWithInventoryPackReplay: 1,
    mapsWithExternalFrame: 0,
    mapsMeetingDisplayAndTimeBudget: 0,
  });
  const timed = { ...frame, playbackTiming: { budgetVerdict: 'pass', maxP95Ms: 33 } };
  const sharp = { ...frame, playbackTiming: { budgetVerdict: 'pass', minDisplayScale: 0.7 } };
  assert.equal(
    replayCoverage(inventory, [timed, sharp]).coverage.mapsMeetingDisplayAndTimeBudget,
    0,
  );
  assert.equal(
    replayCoverage(inventory, [
      {
        ...timed,
        playbackTiming: {
          ...timed.playbackTiming,
          minDisplayScale: 0.7,
        },
      },
    ]).coverage.mapsMeetingDisplayAndTimeBudget,
    1,
  );
  assert.equal(result.inventoryStatus, 'stale');
});
