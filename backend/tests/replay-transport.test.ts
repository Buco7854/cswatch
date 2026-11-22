import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  writeReplay,
  validateReplayArtifacts,
  replayLimits,
  manifestSchema,
  chunkSchema,
} from '../src/replay.js';
import { ReplayCache, chunkIndex, validateManifest } from '../../frontend/src/replay-cache.js';
import { frameAt, skipDeadTime } from '../../frontend/src/playback.js';
import { sample } from '../../frontend/src/sample.js';
import { indexRecordedTravel } from '../../frontend/src/recorded-motion.js';
import type { Playback, PlaybackChunk, PlaybackManifest, Frame } from '../../shared/playback.js';

function fixture(): Playback {
  return {
    ...sample,
    sample: false,
    frames: Array.from({ length: 2401 }, (_, i) => ({
      ...sample.frames[i % sample.frames.length],
      tick: i * 4,
    })),
    deadTimes: [{ start: 1900, end: 6000, kind: 'timeout' }],
  };
}
const decode = (path: string) => JSON.parse(gunzipSync(readFileSync(path)).toString());
const spatial = (frame: Frame): Frame => ({
  tick: frame.tick,
  players: frame.players.map((player) => ({
    id: player.id,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    health: player.health,
    team: player.team,
    alive: player.alive,
    weapon: player.weapon,
    flash: player.flash,
  })),
});

function richFixture(): Playback {
  const data = fixture();
  data.frames = Array.from({ length: 1401 }, (_, index) => ({
    tick: index * 4,
    players: sample.frames[0].players.map((player, actor) => ({
      ...player,
      x: 1234.567890123 + index / 7 + actor,
      y: -2345.678901234 + index / 11,
      z: 345.678901234 + actor / 13,
      yaw: 12.345678901234 + index / 17,
      pitch: 23.456789012345 + index / 19,
      armor: 100,
      money: 5400,
      ammo: 30,
      duck: 0.123456789,
      flash: 0.456789123,
      helmet: true,
      defuser: true,
      scoped: false,
      defusing: false,
      equipmentValue: 4750,
      startMoney: 8500,
      spentThisRound: 3100,
      inventory: [
        'weapon_ak47',
        'weapon_fiveseven',
        'weapon_knife',
        'weapon_flashbang',
        'weapon_flashbang',
        'weapon_smokegrenade',
        'weapon_hegrenade',
        'weapon_incgrenade',
        'weapon_molotov',
        'weapon_decoy',
        'weapon_c4',
        'weapon_taser',
      ],
      stats: { kills: 24, deaths: 12, assists: 9, headshotKills: 18, damage: 2431 },
      input: {
        source: 'usercmd',
        buttons: '18446744073709551615',
        pressedButtons: '18446744073709551615',
        releasedButtons: '18446744073709551615',
        forward: true,
        back: false,
        left: false,
        right: true,
        jump: true,
        duck: false,
        walk: false,
        attack: true,
        attack2: false,
        reload: false,
        use: false,
        mouseDx: 123,
        mouseDy: -456,
      },
    })),
  }));
  data.grenades = Array.from({ length: 8 }, (_, index) => ({
    id: `explicit-rich-path-${index}`,
    kind: 'CSmokeGrenadeProjectile',
    points: data.frames.map((frame) => ({
      tick: frame.tick,
      x: frame.tick / 7 + index,
      y: frame.tick / 11,
      z: frame.tick / 13,
    })),
  }));
  data.voice = data.frames.map((frame, index) => ({
    id: `explicit-rich-voice-${index}`,
    speaker: data.players[0].id,
    tick: frame.tick,
    opus: Buffer.from([0xf8, 0xff, 0xfe]).toString('base64'),
    sampleRate: 48000,
    channels: 1,
    durationMs: 20,
  }));
  data.crosshairs = {
    complete: true,
    samples: data.players.map((player) => ({
      tick: data.frames[0].tick,
      actor: player.id,
      code: 'CSGO-ZEw8O-KGXNu-4TTUU-VyXbD-SBCtG',
    })),
  };
  return data;
}

test('rich replay chunks adapt to decoded bytes without losing boundary, five-second context, equipment, inputs or media', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-replay-rich-'));
  try {
    const original = richFixture();
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          version: 3,
          index: 0,
          frames: original.frames.slice(0, 481),
          grenades: [],
        }),
      ) > replayLimits.chunkBytes,
      'The fixture must exercise the fixed-frame writer overflow, not only ordinary frame packing',
    );
    await writeReplay(dir, original);
    const { manifest } = validateReplayArtifacts(dir);
    assert.deepEqual(validateManifest(manifest), manifest);
    assert.deepEqual(manifest.crosshairs, original.crosshairs);
    assert.ok(
      manifest.chunks.length > Math.ceil((original.frames.length - 1) / replayLimits.chunkFrames),
    );
    for (const info of manifest.chunks) {
      const part = decode(join(dir, 'chunks', `${info.index}.json.gz`)) as PlaybackChunk;
      const offset = info.startTick / 4,
        end = info.endTick / 4;
      assert.ok(info.bytes <= replayLimits.chunkBytes);
      assert.ok(end - offset <= replayLimits.chunkFrames);
      assert.equal(
        info.firstFrameTick,
        original.frames[Math.max(0, offset - replayLimits.contextFrames)].tick,
      );
      assert.deepEqual(
        part.frames.filter((frame) => frame.tick >= info.startTick),
        original.frames.slice(offset, end + 1),
      );
      assert.deepEqual(
        part.frames.filter((frame) => frame.tick < info.startTick),
        original.frames
          .slice(Math.max(0, offset - replayLimits.contextFrames), offset)
          .map(spatial),
      );
      assert.deepEqual(
        part.voice,
        original.voice!.filter(
          (packet) =>
            packet.tick >= Math.max(0, info.firstFrameTick - 128) &&
            packet.tick <= info.endTick + 64,
        ),
      );
      assert.deepEqual(
        part.grenades.map((path) => path.id),
        original.grenades!.map((path) => path.id),
      );
      for (const path of part.grenades) {
        const expected = original.grenades!.find((item) => item.id === path.id)!;
        const first = expected.points.findIndex((point) => point.tick >= info.firstFrameTick),
          after = expected.points.findIndex((point) => point.tick > info.endTick);
        assert.deepEqual(
          path.points,
          expected.points.slice(Math.max(0, first - 1), after < 0 ? undefined : after + 1),
        );
      }
      if (offset >= 80) assert.equal(info.startTick - info.firstFrameTick, 5 * manifest.tickRate);
    }
    // The POV stride remains reproducible even when the gait bank exhausts its own budget.
    const cache = new ReplayCache({ ...manifest, gaitHistory: undefined }, async (index) =>
      decode(join(dir, 'chunks', `${index}.json.gz`)),
    );
    const fullTravel = indexRecordedTravel(
      original.frames,
      { tick: original.frames[0].tick, players: original.players.map(({ id }) => [id, 0]) },
      original.rounds,
      original.tickRate,
    )!;
    for (const info of manifest.chunks.slice(1)) {
      // Jump away first so the target must carry its own context after eviction.
      await cache.at(
        info.index < manifest.chunks.length / 2 ? manifest.lastTick : manifest.firstTick,
      );
      for (const tick of [info.startTick - 1, info.startTick, info.startTick + 1]) {
        const loaded = await cache.at(tick),
          actual = frameAt(loaded, tick),
          expected = frameAt(original, tick);
        assert.equal(actual.frame.tick, expected.frame.tick);
        assert.equal(actual.next.tick, expected.next.tick);
        assert.equal(actual.alpha, expected.alpha);
        assert.deepEqual(actual.frame, expected.frame);
        assert.deepEqual(actual.next, expected.next);
        assert.ok(loaded.strideAnchor?.players.length);
        const slice = indexRecordedTravel(
          loaded.frames,
          loaded.strideAnchor,
          loaded.rounds,
          loaded.tickRate,
        )!;
        for (const { id } of actual.frame.players)
          assert.equal(
            slice(actual.frame, actual.next, id, actual.alpha),
            fullTravel(expected.frame, expected.next, id, expected.alpha),
          );
        assert.ok(cache.size <= 3);
        assert.ok(cache.requests <= 2);
      }
      const loaded = await cache.at(info.startTick);
      assert.deepEqual(
        loaded.frames
          .filter(
            (frame) =>
              frame.tick >= info.startTick - 5 * manifest.tickRate && frame.tick <= info.startTick,
          )
          .map(spatial),
        original.frames
          .filter(
            (frame) =>
              frame.tick >= info.startTick - 5 * manifest.tickRate && frame.tick <= info.startTick,
          )
          .map(spatial),
      );
    }
    cache.close();
    const calls: number[] = [];
    const revisit = new ReplayCache(manifest, async (index) => {
      calls.push(index);
      return decode(join(dir, 'chunks', `${index}.json.gz`));
    });
    await revisit.at(manifest.firstTick);
    for (const info of manifest.chunks.slice(1)) await revisit.at(info.startTick);
    assert.ok(
      manifest.chunks.length >= 4,
      'At least four slices must evict the first canonical frame from a three-slice cache',
    );
    const before = calls.filter((index) => index === 0).length;
    const past = manifest.chunks[1].firstFrameTick;
    assert.equal(chunkIndex(manifest, past), 0);
    const canonical = frameAt(await revisit.at(past), past).frame;
    assert.equal(calls.filter((index) => index === 0).length, before + 1);
    assert.deepEqual(canonical, frameAt(original, past).frame);
    assert.deepEqual(canonical.players[0].input, original.frames[past / 4].players[0].input);
    assert.deepEqual(
      canonical.players[0].inventory,
      original.frames[past / 4].players[0].inventory,
    );
    assert.deepEqual(canonical.players[0].stats, original.frames[past / 4].players[0].stats);
    revisit.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('byte packing fails closed when one shared boundary and its complete context cannot fit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-replay-context-limit-'));
  try {
    const original = richFixture();
    const template = original.frames[0].players[0];
    const inventory = Array.from({ length: 64 }, () => 'x'.repeat(80));
    original.frames = Array.from({ length: 90 }, (_, index) => ({
      tick: index * 4,
      players: Array.from({ length: 128 }, (_, actor) => ({
        ...template,
        id: String(actor).padStart(40, '0'),
        x: 1234567.123456789,
        y: -2345678.123456789,
        z: 3456789.123456789,
        yaw: 1234567.123456789,
        pitch: 2345678.123456789,
        health: 9999.123456789,
        team: 255,
        alive: false,
        weapon: '🔧'.repeat(50),
        inventory,
      })),
    }));
    original.grenades = [];
    original.voice = [];
    assert.ok(Buffer.byteLength(JSON.stringify(original.frames[0])) < replayLimits.chunkBytes);
    await assert.rejects(writeReplay(dir, original), /Replay output limit/);
    assert.equal(
      existsSync(join(dir, 'manifest.json.gz')),
      false,
      'No complete manifest can publish truncated context',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cold seek across a chunk boundary retains flight and post-detonation samples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-combat-'));
  try {
    const original = fixture();
    // Flight starts before the five-second spatial context in chunk 1.
    const path = {
      id: '72-1456',
      kind: 'CHEGrenadeProjectile',
      points: Array.from({ length: 102 }, (_, index) => ({
        tick: 1456 + index * 4,
        x: index * 2,
        y: 0,
        z: 100,
      })),
    };
    original.grenades = [path];
    original.frames[475].players = original.frames[475].players.map((pawn) => ({
      ...pawn,
      flash: 1.03,
    }));
    // Decline the aim slice to exercise the first whole-recording fallback.
    await writeReplay(dir, original, () => null);
    const { manifest } = validateReplayArtifacts(dir);
    const chunk = decode(join(dir, 'chunks', '1.json.gz')) as PlaybackChunk;
    assert.ok(manifest.chunks[1].firstFrameTick > path.points[0].tick);
    assert.ok(manifest.chunks[1].startTick > path.points.at(-1)!.tick);
    assert.deepEqual(chunk.grenades, [path]);
    assert.equal(chunk.frames.find((frame) => frame.tick === 1900)?.players[0].flash, 1.03);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chunked transport retains exact boundary interpolation, global navigation and bounded caching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-replay-'));
  try {
    const original = fixture();
    await writeReplay(dir, original);
    const { manifest, files, bytes } = validateReplayArtifacts(dir);
    assert.equal(manifest.version, 3);
    assert.equal(manifest.chunks.length, 5);
    assert.equal(files.length, 6);
    assert.ok(bytes > 0);
    assert.deepEqual(validateManifest(manifest), manifest);
    const calls: number[] = [];
    const cache = new ReplayCache(manifest, async (i) => {
      calls.push(i);
      return decode(join(dir, 'chunks', `${i}.json.gz`));
    });
    for (const tick of [0, 1919, 1920, 1921, 5000, 9600, 80]) {
      const data = await cache.at(tick);
      const actual = frameAt(data, tick),
        expected = frameAt(original, tick);
      assert.equal(actual.frame.tick, expected.frame.tick);
      assert.equal(actual.next.tick, expected.next.tick);
      assert.equal(actual.alpha, expected.alpha);
      assert.ok(data.frames.length <= 561);
      assert.ok(cache.size <= 3);
      assert.ok(cache.requests <= 2);
    }
    assert.equal(chunkIndex(manifest, -100), 0);
    assert.equal(chunkIndex(manifest, 1e9), 4);
    assert.equal(skipDeadTime(await cache.at(1919), 1919, 'timeout', manifest.lastTick), 6000);
    const before = calls.length;
    await cache.at(84);
    assert.equal(calls.length, before);
    const cachedBeforeClose = cache.at(84);
    cache.close();
    await assert.rejects(cachedBeforeClose, { name: 'AbortError' });
    assert.equal(cache.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seeking cancels irrelevant requests and refuses chunks from a different time slice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-replay-'));
  try {
    await writeReplay(dir, fixture());
    const manifest = decode(join(dir, 'manifest.json.gz')) as PlaybackManifest;
    const pending = new Map<number, { signal: AbortSignal; resolve: (c: PlaybackChunk) => void }>();
    const cache = new ReplayCache(
      manifest,
      (i, signal) =>
        new Promise((resolve, reject) => {
          pending.set(i, { signal, resolve });
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );
    const first = cache.at(0);
    const rejection = assert.rejects(first, { name: 'AbortError' });
    const far = cache.at(8000);
    assert.equal(pending.get(0)!.signal.aborted, true);
    assert.ok(cache.requests <= 2);
    pending.get(4)!.resolve(decode(join(dir, 'chunks', '4.json.gz')));
    await far;
    await rejection;
    cache.close();
    const invalid = new ReplayCache(manifest, async () => decode(join(dir, 'chunks', '0.json.gz')));
    await assert.rejects(invalid.at(8000), /chunk is invalid/);
    invalid.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('untrusted parser output cannot publish traversal, symlinks, oversized or malformed chunks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-replay-'));
  try {
    await writeReplay(dir, fixture());
    const path = join(dir, 'chunks', '0.json.gz'),
      original = readFileSync(path);
    const malformed = decode(path);
    malformed.frames[1].tick = malformed.frames[0].tick;
    const json = JSON.stringify(malformed);
    writeFileSync(path, gzipSync(json));
    const manifestPath = join(dir, 'manifest.json.gz'),
      metadata = decode(manifestPath);
    metadata.chunks[0].bytes = Buffer.byteLength(json);
    writeFileSync(manifestPath, gzipSync(JSON.stringify(metadata)));
    assert.throws(() => validateReplayArtifacts(dir), /Unordered replay/);
    writeFileSync(path, original);
    rmSync(path);
    symlinkSync('/etc/passwd', path);
    assert.throws(() => validateReplayArtifacts(dir), /Invalid replay artifact/);
    metadata.chunks[0].index = '../outside';
    assert.throws(() => validateManifest(metadata), /metadata is invalid/);
    rmSync(path);
    writeFileSync(path, gzipSync(Buffer.alloc(4 * 1024 ** 2 + 1, 32)));
    assert.throws(() => validateReplayArtifacts(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the replay transport accepts one version and requires current coverage and chunk arrays', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-replay-wire-'));
  try {
    await writeReplay(folder, fixture());
    const { manifest } = validateReplayArtifacts(folder);
    const chunk = decode(join(folder, 'chunks', '0.json.gz'));
    for (const version of [1, 2, 4]) {
      assert.equal(manifestSchema.safeParse({ ...manifest, version }).success, false);
      assert.equal(chunkSchema.safeParse({ ...chunk, version }).success, false);
      assert.throws(() => validateManifest({ ...manifest, version: version as 3 }));
    }
    for (const key of [
      'worldBounds',
      'deadTimes',
      'warnings',
      'chat',
      'communications',
      'gameplaySounds',
      'objectives',
      'matchState',
      'crosshairs',
      'itemState',
      'eventAvailability',
      'throwInputs',
      'capabilities',
    ] as const) {
      const payload = { ...manifest, [key]: undefined };
      assert.equal(manifestSchema.safeParse(payload).success, false, key);
      assert.throws(() => validateManifest(payload as PlaybackManifest), key);
    }
    for (const key of ['voice', 'sounds', 'itemSamples']) {
      const payload = { ...chunk, [key]: undefined };
      assert.equal(chunkSchema.safeParse(payload).success, false, key);
      const cache = new ReplayCache(manifest, async () => payload);
      await assert.rejects(cache.at(manifest.firstTick), /Replay chunk is invalid/);
      cache.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
