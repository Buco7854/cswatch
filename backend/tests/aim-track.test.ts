import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  aimBoundary,
  aimChunkBytes,
  decodeAimChunk,
  encodeAimChunk,
  quantizeAim,
  sampleAim,
  type AimSample,
} from '../../shared/aim-track.mjs';
import type { Playback, PlaybackChunk } from '../../shared/playback.js';
import { ReplayCache } from '../../frontend/src/replay-cache.js';
import { playerPose, shortestAngle } from '../../frontend/src/player-pose.js';
import { readAimSlices } from '../src/aim-track.js';
import { replayLimits, validateReplayArtifacts, writeReplay } from '../src/replay.js';

const id = '76561198000000001';
const actors = new Set([id]);
const one = (samples: Iterable<AimSample>) => new Map([[id, samples]]);
const sample = (tick: number, yaw: number, pitch: number, connected: boolean): AimSample => [
  tick,
  quantizeAim(yaw)!,
  quantizeAim(pitch)!,
  connected,
];

test('aim codec wraps signed deltas, retains gaps and breaks, and interpolates only adjacent ticks', () => {
  const samples = [
    sample(25, 179.995, -20, true),
    sample(26, -179, -21, true),
    sample(28, 25, 40, true),
    sample(29, 90, 10, false),
    sample(30, 92, 12, true),
  ];
  const aim = encodeAimChunk(24, 32, one(samples));
  const track = decodeAimChunk(aim, 24, 32, actors).get(id)!;
  assert.deepEqual([...track.ticks], [25, 26, 28, 29, 30]);
  assert.deepEqual([...track.connected], [0, 1, 0, 0, 1]);
  assert.ok(Math.abs(shortestAngle(179.995, sampleAim(track, 25)!.yaw)) <= 1 / 256);
  assert.deepEqual(sampleAim(track, 25.5), { yaw: 180.49609375, pitch: -20.5 });
  assert.equal(sampleAim(track, 26.5), undefined);
  assert.equal(sampleAim(track, 27), undefined);
  assert.deepEqual(sampleAim(track, 28.5), { yaw: 25, pitch: 40 });
  assert.deepEqual(sampleAim(track, 29.5), { yaw: 91, pitch: 11 });
  assert.deepEqual(sampleAim(track, 29), { yaw: 90, pitch: 10 });
  assert.equal(sampleAim(track, 31), undefined);
  assert.equal(quantizeAim(Number.NaN), undefined);
  assert.equal(quantizeAim(361), undefined);
});

test('aim codec rejects malformed, non-canonical and oversized tracks before hydration', () => {
  const good = encodeAimChunk(0, 4, one([sample(0, 0, 0, false)]))!;
  const wire = (...bytes: number[]) => ({
    version: 1,
    tracks: [[id, btoa(String.fromCharCode(...bytes))]],
  });
  for (const malformed of [
    null,
    { ...good, version: 2 },
    { ...good, extra: true },
    { ...good, tracks: [] },
    { ...good, tracks: Array.from({ length: 129 }, () => good.tracks[0]) },
    { ...good, tracks: [...good.tracks, ...good.tracks] },
    { ...good, tracks: [['0', 'AgAA']] },
    { ...good, tracks: [['76561198000000002', 'AgAA']] },
    { ...good, tracks: [[id, 'AgA!']] },
    { ...good, tracks: [[id, ' AgAA==']] },
    { ...good, tracks: [[id, 'AgAAAQ=='.replace('AQ', 'AR')]] }, // nonzero base64 padding bits
    { ...good, tracks: [[id, 'A'.repeat(Math.ceil(aimChunkBytes / 3) * 4 + 4)]] },
    wire(0, 0, 0), // zero tick gap
    wire(3, 0, 0), // first sample cannot depend on an earlier sample
    wire(12, 0, 0), // past the declared end
    wire(2, 0, 0, 5, 0, 0), // interpolation over a gap
    wire(130, 0, 0, 0), // overlong LEB128
    wire(2, 128, 232, 2, 0), // positive angle outside the canonical half-turn
    wire(2, 128, 128, 128, 0, 0), // more than three LEB128 bytes
    wire(2, 0), // truncated triple
  ])
    assert.throws(() => decodeAimChunk(malformed, 0, 4, actors), /Invalid recorded aim/);
  assert.throws(() => encodeAimChunk(0, 4, one([sample(0, 0, 0, false), sample(0, 2, 1, true)])));
  function* oversized(): Generator<AimSample> {
    for (let tick = 0; tick < 100000; tick++) yield sample(tick, 0, 0, true);
  }
  assert.equal(encodeAimChunk(0, 99999, one(oversized())), null);
});

test('native aim batches break on death, missing rows, pawn changes, teleports and rounds', () => {
  const rows = [
    { tick: 4, alive: true, pawn: 8, x: 0 },
    { tick: 5, alive: false, pawn: 8, x: 0 },
    { tick: 6, alive: true, pawn: 8, x: 0 },
    { tick: 7, alive: true, pawn: 8, x: 1 },
    { tick: 9, alive: true, pawn: 8, x: 0 },
    { tick: 10, alive: true, pawn: 9, x: 0 },
    { tick: 11, alive: true, pawn: 9, x: 300 },
    { tick: 12, alive: true, pawn: 9, x: 301 },
    { tick: 13, alive: true, pawn: 9, x: 302 },
    { tick: 13, alive: true, pawn: 10, x: 500 },
    { tick: 14, alive: true, pawn: 10, x: 500 },
    { tick: 15, alive: true, pawn: 10, x: NaN },
    { tick: 16, alive: true, pawn: 10, x: 500 },
    { tick: 16387, alive: true, pawn: 10, x: 500 },
    { tick: 16388, alive: true, pawn: 10, x: 501 },
  ];
  const batches: number[][] = [];
  const slices = readAimSlices(
    'unused',
    4,
    16388,
    [id],
    new Set([12]),
    (_, fields, ticks, ids, soa) => {
      assert.deepEqual(ids, [id]);
      assert.equal(soa, true);
      batches.push([ticks![0], ticks!.at(-1)!]);
      const batch = [...rows].reverse().filter((row) => ticks!.includes(row.tick));
      return Object.fromEntries([
        ['tick', batch.map((row) => row.tick)],
        ['steamid', batch.map(() => id)],
        ...fields.map((field) => [
          field,
          batch.map((row) => {
            const values: Record<string, unknown> = {
              yaw: row.tick % 360,
              pitch: 0,
              is_alive: row.alive,
              X: row.x,
              Y: 0,
              Z: 0,
              'CCSPlayerController.m_hPlayerPawn': row.pawn,
            };
            return values[field];
          }),
        ]),
      ]);
    },
  );
  assert.deepEqual(batches, [
    [4, 16387],
    [16388, 16388],
  ]);
  const track = decodeAimChunk(slices!(4, 16388), 4, 16388, actors).get(id)!;
  assert.deepEqual([...track.ticks], [4, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16387, 16388]);
  assert.deepEqual([...track.connected], [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

const position = {
  id,
  x: 1,
  y: 2,
  z: 3,
  yaw: 10,
  pitch: 2,
  alive: true,
  team: 2,
  health: 100,
  weapon: 'ak47',
};

test('writer and viewer share aim samples at seams, preserve old poses, and sample 128 Hz ticks', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-aim-'));
  try {
    const seam = replayLimits.chunkFrames * 4;
    const frames = Array.from({ length: replayLimits.chunkFrames + 2 }, (_, i) => ({
      tick: i * 4,
      players: [{ ...position }],
    }));
    const replay: Playback = {
      version: 1,
      map: 'training',
      tickRate: 128,
      sample: false,
      players: [{ id, name: 'Player', team: 2 }],
      frames,
      grenades: [],
      events: [],
      rounds: [],
      deadTimes: [],
    };
    const samples = [
      sample(seam - 2, 155, 5, false),
      sample(seam - 1, 175, 6, true),
      sample(seam, -175, 8, true),
      sample(seam + 1, -165, 9, true),
    ];
    await writeReplay(folder, replay, false, (start, end) =>
      encodeAimChunk(start, end, one(samples.filter(([tick]) => tick >= start && tick <= end))),
    );
    const { manifest } = validateReplayArtifacts(folder);
    assert.equal(manifest.chunks.length, 2);
    const path = (index: number) => join(folder, 'chunks', `${index}.json.gz`);
    const read = (index: number): PlaybackChunk =>
      JSON.parse(gunzipSync(readFileSync(path(index))).toString());
    const [left, right] = [read(0), read(1)];
    const leftTrack = decodeAimChunk(left.aim, 0, seam, actors);
    const rightTrack = decodeAimChunk(right.aim, seam, seam + 4, actors);
    assert.equal(aimBoundary(leftTrack, seam), aimBoundary(rightTrack, seam));
    const cache = new ReplayCache(manifest, async (index) => read(index));
    const last = (await cache.at(seam - 1)).frames.at(-1)!.players[0];
    const rightView = await cache.at(seam);
    const first = rightView.frames.find(({ tick }) => tick === seam)!.players[0];
    const next = rightView.frames.at(-1)!.players[0];
    const timing = { fromTick: seam, nextTick: seam + 4, tickRate: 128 };
    assert.deepEqual(
      playerPose(last, undefined, 0, { ...timing, nextTick: seam }),
      playerPose(first, next, 0, timing),
    );
    assert.equal(playerPose(first, next, 0.125, timing).yaw, -170);
    assert.equal(playerPose(first, next, 0.125, timing).pitch, 8.5);
    assert.equal(playerPose(first, next, 0.75, timing).yaw, 10); // missing ticks use legacy pose
    assert.equal(playerPose(position, position, 0, timing), position); // old replay

    right.aim = encodeAimChunk(seam, seam + 4, one([sample(seam, -170, 8, false)]))!;
    const json = JSON.stringify(right);
    writeFileSync(path(1), gzipSync(json));
    manifest.chunks[1].bytes = Buffer.byteLength(json);
    writeFileSync(join(folder, 'manifest.json.gz'), gzipSync(JSON.stringify(manifest)));
    assert.throws(() => validateReplayArtifacts(folder), /Invalid recorded aim boundary/);

    const invalid = new ReplayCache(manifest, async () => ({
      ...right,
      aim: { version: 1, tracks: [[id, 'AA==']] },
    }));
    await assert.rejects(invalid.at(seam), /Invalid recorded aim track/);
    cache.close();
    invalid.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
