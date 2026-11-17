import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { sample } from '../../frontend/src/sample.js';
import { ReplayCache } from '../../frontend/src/replay-cache.js';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';

async function fixture(folder: string) {
  await writeReplay(folder, {
    ...sample,
    events: [{ type: 'grenade_thrown', tick: 256, user_steamid: '0', weapon: 'smokegrenade' }],
    eventAvailability: { player_death: true, player_hurt: false },
    matchState: {
      complete: true,
      samples: [
        {
          tick: 0,
          ctScore: 0,
          tScore: 0,
          phase: 'freeze',
          clock: { kind: 'freeze', endTick: 128 },
        },
        {
          tick: 128,
          ctScore: 0,
          tScore: 0,
          phase: 'live',
          clock: { kind: 'round', startTick: 128, endTick: 7488 },
        },
      ],
    },
    throwInputs: [
      {
        eventIndex: 0,
        tick: 256,
        actorId: '0',
        provenance: 'event-network',
        sampleTick: 256,
        input: {
          source: 'network',
          buttons: '9223372036854777867',
          attack: true,
          attack2: true,
          jump: true,
        },
      },
    ],
  });
}

test('global score, event coverage and throw input indexes survive chunk eviction and arbitrary back-seeks', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-review-metadata-'));
  try {
    await fixture(folder);
    const { manifest } = validateReplayArtifacts(folder);
    const cache = new ReplayCache(manifest, async (index) =>
      JSON.parse(gunzipSync(readFileSync(join(folder, 'chunks', index + '.json.gz'))).toString()),
    );
    for (const tick of [manifest.firstTick, manifest.lastTick, 256, manifest.lastTick]) {
      const slice = await cache.at(tick);
      assert.deepEqual(slice.matchState, manifest.matchState);
      assert.deepEqual(slice.eventAvailability, { player_death: true, player_hurt: false });
      assert.equal(slice.throwInputs?.[0].eventIndex, 0);
      assert.equal(slice.throwInputs?.[0].input?.buttons, '9223372036854777867');
      assert.ok(
        slice.frames.length < sample.frames.length,
        'frames remain chunk bounded while metadata is global',
      );
    }
    cache.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('untrusted score clocks and throw snapshots enforce bounds, known event/actor identities and honest provenance', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-review-metadata-invalid-'));
  try {
    await fixture(folder);
    const path = join(folder, 'manifest.json.gz');
    const original = JSON.parse(gunzipSync(readFileSync(path)).toString());
    const changes: ((value: any) => void)[] = [
      (value) => {
        value.matchState.samples[0].ctScore = -1;
      },
      (value) => {
        value.matchState.samples[0].ctScore = 10001;
      },
      (value) => {
        value.matchState.samples[0].roundNumber = 0;
      },
      (value) => {
        value.matchState.samples[0].tick = value.lastTick + 1;
      },
      (value) => {
        value.matchState.samples.reverse();
      },
      (value) => {
        value.matchState.samples[0].clock.url = 'https://example.com';
      },
      (value) => {
        value.matchState.samples[0].clock.startTick = 129;
      },
      (value) => {
        value.matchState.samples[0].clock.pausedAtTick = 1;
      },
      (value) => {
        value.matchState.samples = Array.from({ length: 10001 }, () => value.matchState.samples[0]);
      },
      (value) => {
        value.eventAvailability.player_hurt = 'false';
      },
      (value) => {
        value.throwInputs[0].eventIndex = 1;
      },
      (value) => {
        value.throwInputs[0].actorId = '76561198000000099';
      },
      (value) => {
        value.throwInputs[0].tick = 255;
      },
      (value) => {
        value.throwInputs[0].sampleTick = 255;
      },
      (value) => {
        value.throwInputs[0].input.source = 'usercmd';
      },
      (value) => {
        value.throwInputs[0].input.buttons = '18446744073709551616';
      },
      (value) => {
        value.throwInputs[0].provenance = 'unavailable';
      },
      (value) => {
        value.throwInputs[0].provenance = 'nearby-network';
        value.throwInputs[0].sampleTick = 1;
      },
      (value) => {
        value.throwInputs.push({ ...value.throwInputs[0] });
      },
      (value) => {
        value.events[0].type = 'player_death';
      },
      (value) => {
        value.events[0].user_steamid = '1';
      },
    ];
    for (const change of changes) {
      const modified = structuredClone(original);
      change(modified);
      writeFileSync(path, gzipSync(JSON.stringify(modified)));
      assert.throws(() => validateReplayArtifacts(folder));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
