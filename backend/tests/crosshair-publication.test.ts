import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { sample } from '../../frontend/src/sample.js';
import {
  buildRecordedCrosshairTimeline,
  recordedCrosshairAt,
} from '../../frontend/src/recorded-crosshair.ts';
import { ReplayCache } from '../../frontend/src/replay-cache.js';
import type { PlaybackChunk } from '../../shared/playback.js';

const code = 'CSGO-ZEw8O-KGXNu-4TTUU-VyXbD-SBCtG';
test('crosshair changes remain global across streamed time slices and invalid publication fails closed', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-crosshair-metadata-'));
  try {
    const actor = sample.players[1].id;
    const crosshairs = {
      complete: true,
      samples: [
        { tick: 4, actor, code },
        { tick: 16, actor, code: null },
      ],
    };
    await writeReplay(folder, { ...sample, crosshairs });
    const { manifest } = validateReplayArtifacts(folder);
    assert.deepEqual(manifest.crosshairs, crosshairs);
    const cache = new ReplayCache(
      manifest,
      async (index) =>
        JSON.parse(
          gunzipSync(readFileSync(join(folder, 'chunks', `${index}.json.gz`))).toString(),
        ) as PlaybackChunk,
    );
    try {
      const late = await cache.at(manifest.lastTick);
      assert.deepEqual(late.crosshairs, crosshairs);
      assert.equal(
        recordedCrosshairAt(buildRecordedCrosshairTimeline(late), actor, manifest.lastTick),
        undefined,
      );
      const early = await cache.at(manifest.firstTick);
      assert.deepEqual(early.crosshairs, crosshairs);
      assert.equal(recordedCrosshairAt(buildRecordedCrosshairTimeline(early), actor, 4), code);
      assert.ok(
        early.frames.every((frame) =>
          frame.players.every((player) => !Object.hasOwn(player, 'crosshairCode')),
        ),
      );
    } finally {
      cache.close();
    }
    const path = join(folder, 'manifest.json.gz');
    for (const samples of [
      [{ tick: manifest.lastTick + 1, actor, code }],
      [
        { tick: 16, actor, code },
        { tick: 4, actor, code: null },
      ],
      [{ tick: 4, actor: '76561198000000001', code }],
      [{ tick: -1, actor, code }],
      [{ tick: 1.5, actor, code }],
      [{ tick: 4, actor, code: '' }],
      [{ tick: 4, actor, code: 'A'.repeat(65) }],
      [{ tick: 4, actor, code: null, name: 'Untrusted extra metadata' }],
      Array.from({ length: 10001 }, () => ({ tick: 4, actor, code })),
    ]) {
      writeFileSync(
        path,
        gzipSync(JSON.stringify({ ...manifest, crosshairs: { complete: true, samples } })),
      );
      assert.throws(() => validateReplayArtifacts(folder));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
