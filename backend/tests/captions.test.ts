import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { captionArtifactName, captionLimits, validateCaptionArtifact } from '../src/captions.js';
const speaker = '76561198000000001';
const manifest = {
  firstTick: 64,
  lastTick: 640,
  players: [{ id: speaker, name: 'Fixture', team: 2 }],
};
const cue = {
  id: 'caption-1',
  startTick: 128,
  endTick: 256,
  speaker,
  text: 'Recorded test speech.',
  source: 'local-transcription',
};
test('caption artifacts validate actual speakers, match time bounds, source and ordered unique cues', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-captions-'));
  const write = (cues: unknown[], status = 'ready') =>
    writeFileSync(join(folder, 'captions.json.gz'), gzipSync(JSON.stringify({ status, cues })));
  try {
    write([cue]);
    assert.equal(validateCaptionArtifact(folder, manifest).result.cues.length, 1);
    write([{ ...cue, startTick: 128.25, endTick: 256.75 }]);
    assert.equal(validateCaptionArtifact(folder, manifest).result.cues[0].endTick, 256.75);
    for (const cues of [
      [{ ...cue, speaker: 'someone-else' }],
      [{ ...cue, startTick: 1 }],
      [{ ...cue, endTick: 641 }],
      [{ ...cue, endTick: 128 }],
      [cue, cue],
      [cue, { ...cue, id: 'other', startTick: 100 }],
      [{ ...cue, source: 'imported' }],
      [{ ...cue, text: ' '.repeat(1001) }],
    ]) {
      write(cues);
      assert.throws(() => validateCaptionArtifact(folder, manifest));
    }
    write([], 'unavailable');
    assert.equal(validateCaptionArtifact(folder, manifest).result.status, 'unavailable');
    write([cue], 'unavailable');
    assert.throws(() => validateCaptionArtifact(folder, manifest));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
test('caption artifacts reject symlinks, gzip expansion bombs and arbitrary persistent filenames', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-caption-bounds-'));
  try {
    const secret = join(folder, 'outside');
    writeFileSync(secret, 'private');
    symlinkSync(secret, join(folder, 'captions.json.gz'));
    assert.throws(() => validateCaptionArtifact(folder, manifest));
    rmSync(join(folder, 'captions.json.gz'));
    writeFileSync(
      join(folder, 'captions.json.gz'),
      gzipSync(Buffer.alloc(captionLimits.bytes + 1, 65)),
    );
    assert.throws(() => validateCaptionArtifact(folder, manifest));
    assert.equal(
      captionArtifactName(`captions-${'a'.repeat(32)}.json.gz`),
      `captions-${'a'.repeat(32)}.json.gz`,
    );
    for (const name of [
      '../replay.db',
      '/etc/passwd',
      'captions.json.gz',
      `captions-${'A'.repeat(32)}.json.gz`,
    ])
      assert.throws(() => captionArtifactName(name));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
