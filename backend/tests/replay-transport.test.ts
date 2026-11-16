import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { writeReplay, validateReplayArtifacts } from '../src/replay.js';
import { ReplayCache, chunkIndex, validateManifest } from '../../frontend/src/replay-cache.js';
import { frameAt, skipDeadTime } from '../../frontend/src/playback.js';
import { sample } from '../../frontend/src/sample.js';
import type { Playback, PlaybackChunk, PlaybackManifest } from '../../shared/playback.js';

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

test('chunked transport retains exact boundary interpolation, global navigation and bounded caching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-replay-'));
  try {
    const original = fixture();
    await writeReplay(dir, original);
    const { manifest, files, bytes } = validateReplayArtifacts(dir);
    assert.equal(manifest.version, 2);
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
