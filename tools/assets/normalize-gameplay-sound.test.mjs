import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originalToneMp3 } from './fixtures/original-tone-mp3.mjs';
import {
  inspectMpegFrames,
  normalizeMpegBytes,
  normalizeGameplaySound,
} from './normalize-gameplay-sound.mjs';
import { inspectGameplayAudio, gameplayAudioLimits } from '../../shared/gameplay-sound-files.mjs';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function xingWrapper(data) {
  const first = inspectMpegFrames(data).frames[0],
    metadata = Buffer.alloc(first.length);
  data.copy(metadata, 0, 0, 4);
  metadata.write('Xing', first.tag);
  metadata.writeUInt32BE(3, first.tag + 4);
  metadata.writeUInt32BE(inspectMpegFrames(data).frames.length, first.tag + 8);
  metadata.writeUInt32BE(metadata.length + data.length, first.tag + 12);
  return Buffer.concat([metadata, data]);
}
test('genuine original MPEG tone decodes frame-by-frame to bounded PCM16 stereo with preserved frequency and mono samples', async () => {
  const result = await normalizeMpegBytes(originalToneMp3()),
    audio = inspectGameplayAudio(result.data);
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.channels, 2);
  assert.equal(audio.durationMs, (5760 / 44100) * 1000);
  assert.equal(result.metadata, 'none');
  assert.equal(result.sourceChannels, 1);
  let sine = 0,
    cosine = 0,
    otherSine = 0,
    otherCosine = 0;
  for (let i = 0; i < 2048; i++) {
    const offset = 44 + (i + 1800) * 4,
      value = result.data.readInt16LE(offset) / 32768;
    assert.equal(result.data.readInt16LE(offset + 2), result.data.readInt16LE(offset));
    sine += value * Math.sin((i * 2 * Math.PI * 440) / 44100);
    cosine += value * Math.cos((i * 2 * Math.PI * 440) / 44100);
    otherSine += value * Math.sin((i * 2 * Math.PI * 1000) / 44100);
    otherCosine += value * Math.cos((i * 2 * Math.PI * 1000) / 44100);
  }
  assert.ok(
    (Math.hypot(sine, cosine) * 2) / 2048 > 0.3,
    'Actual440Hz PCM energy must survive conversion',
  );
  assert.ok(Math.hypot(otherSine, otherCosine) < Math.hypot(sine, cosine) / 20);
});
test('validated metadata-only Xing wrapper is stripped without changing actual tone PCM and forged duration/gapless claims fail before decoding', async () => {
  const original = originalToneMp3(),
    wrapped = xingWrapper(original),
    a = await normalizeMpegBytes(original),
    b = await normalizeMpegBytes(wrapped),
    tag = inspectMpegFrames(wrapped).frames[0].tag;
  assert.equal(b.metadata, 'validated-xing-stripped');
  assert.deepEqual(b.data, a.data);
  for (const change of [
    (d) => d.writeUInt32BE(2147483647, tag + 8),
    (d) => d.writeUInt32BE(d.length + 1, tag + 12),
    (d) => d.writeUInt32BE(16, tag + 4),
    (d) => {
      d.write('LAME3.100', tag + 16);
      d.writeUIntBE(0xffffff, tag + 16 + 21, 3);
    },
  ]) {
    const corrupt = Buffer.from(wrapped);
    change(corrupt);
    assert.throws(() => inspectMpegFrames(corrupt));
  }
  const vbri = Buffer.from(original);
  vbri.write('VBRI', 36);
  assert.throws(() => inspectMpegFrames(vbri));
});
test('independent semantic bounds reject long/truncated streams, changing formats, oversized input and unknown metadata', () => {
  const original = originalToneMp3(),
    info = inspectMpegFrames(original);
  // Just over the decoded-duration bound, whatever that bound is.
  const copies =
    Math.floor(gameplayAudioLimits.durationMs / ((info.maximumSamples / info.sampleRate) * 1000)) +
    1;
  assert.throws(() =>
    inspectMpegFrames(Buffer.concat(Array.from({ length: copies }, () => original))),
  );
  assert.throws(() => inspectMpegFrames(original.subarray(0, original.length - 1)));
  const changed = Buffer.from(original);
  changed[info.frames[1].offset + 3] = 0;
  assert.throws(() => inspectMpegFrames(changed));
  assert.throws(() => inspectMpegFrames(Buffer.alloc(gameplayAudioLimits.bytes + 1)));
  assert.throws(() => inspectMpegFrames(Buffer.concat([Buffer.from('ID3'), original])));
});
test('operator normalization uses exclusive new output, preserves input and rejects links before WASM work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-audio-normalize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'original.mp3'),
    output = join(root, 'new.wav'),
    source = originalToneMp3();
  await writeFile(input, source);
  const result = await normalizeGameplaySound({ input, output });
  assert.equal(result.extension, 'wav');
  assert.deepEqual(await readFile(input), source);
  assert.equal(inspectGameplayAudio(await readFile(output)).durationMs, result.durationMs);
  await assert.rejects(normalizeGameplaySound({ input, output }), /EEXIST/);
  await assert.rejects(normalizeGameplaySound({ input, output: input }), /new WAV/);
  const linked = join(root, 'link.mp3');
  await symlink(input, linked);
  await assert.rejects(
    normalizeGameplaySound({ input: linked, output: join(root, 'not-created.wav') }),
  );
  const hard = join(root, 'hard.mp3');
  await link(input, hard);
  await assert.rejects(normalizeGameplaySound({ input: hard, output: join(root, 'hard.wav') }));
});
test('real WASM normalization runs in the required stage-only conversion child under128MiB V8 heap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-confined-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'conversion');
  await mkdir(stage, { mode: 0o700 });
  const input = join(root, 'original.mp3'),
    output = join(stage, 'normalized.wav'),
    helper = buildNetworkDeny(join(root, 'boundary'));
  await writeFile(input, originalToneMp3());
  const result = spawnSync(
    helper,
    [
      '--write-root',
      stage,
      '--',
      process.execPath,
      '--max-old-space-size=128',
      fileURLToPath(new URL('./normalize-gameplay-sound.mjs', import.meta.url)),
      '--input',
      input,
      '--output',
      output,
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: stage },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.extension, 'wav');
  assert.equal(inspectGameplayAudio(await readFile(output)).durationMs, report.durationMs);
});
