#!/usr/bin/env node
/** Offline only. Invoked in the stage-confined Node child, never by HTTP or a browser. */
import { MPEGDecoder } from 'mpg123-decoder';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import { inspectGameplayAudio, gameplayAudioLimits } from '../../shared/gameplay-sound-files.mjs';

const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const fail = () => {
  throw new Error('Unsupported or inconsistent bounded MPEG audio.');
};

/** Scan every complete Layer III frame. Duration never comes from a claimed metadata count. */
export function inspectMpegFrames(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (data.length < 24 || data.length > gameplayAudioLimits.bytes) fail();
  // ID3/iTunSMPB and unrelated containers are deliberately unsupported, not passed to WASM.
  const frames = [];
  let offset = 0,
    sampleRate,
    channels,
    version;
  while (offset < data.length) {
    if (
      frames.length >= 1000 ||
      offset + 4 > data.length ||
      data[offset] !== 255 ||
      (data[offset + 1] & 224) !== 224
    )
      fail();
    const v = (data[offset + 1] >> 3) & 3,
      layer = (data[offset + 1] >> 1) & 3,
      index = (data[offset + 2] >> 2) & 3,
      bitrateIndex = data[offset + 2] >> 4;
    if (
      v === 1 ||
      layer !== 1 ||
      index === 3 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      (data[offset + 3] & 3) === 2
    )
      fail();
    const rate = [44100, 48000, 32000][index] / (v === 3 ? 1 : v === 2 ? 2 : 4),
      channel = data[offset + 3] >> 6 === 3 ? 1 : 2;
    if (
      rate < 8000 ||
      rate > 48000 ||
      (sampleRate !== undefined && (sampleRate !== rate || channels !== channel || version !== v))
    )
      fail();
    sampleRate = rate;
    channels = channel;
    version = v;
    const bitrate = (v === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex] * 1000,
      length = Math.floor(((v === 3 ? 144 : 72) * bitrate) / rate) + ((data[offset + 2] >> 1) & 1),
      sideBytes = v === 3 ? (channel === 1 ? 17 : 32) : channel === 1 ? 9 : 17,
      crc = data[offset + 1] & 1 ? 0 : 2;
    if (length < 4 + crc + sideBytes || offset + length > data.length) fail();
    if (
      frames.length > 0 &&
      (['Xing', 'Info'].includes(
        data.toString('ascii', offset + 4 + crc + sideBytes, offset + 8 + crc + sideBytes),
      ) ||
        data.toString('ascii', offset + 36, offset + 40) === 'VBRI')
    )
      fail();
    frames.push({
      offset,
      length,
      samples: v === 3 ? 1152 : 576,
      tag: offset + 4 + crc + sideBytes,
    });
    offset += length;
  }
  if (frames.length < 2) fail();
  const first = frames[0],
    tag = data.toString('ascii', first.tag, first.tag + 4);
  // VBRI has its own, unsupported seek/duration semantics.
  if (data.toString('ascii', first.offset + 36, first.offset + 40) === 'VBRI') fail();
  let gapless = false,
    metadataFrame = false,
    delay = 0,
    padding = 0;
  if (tag === 'Xing' || tag === 'Info') {
    metadataFrame = true;
    let cursor = first.tag + 4;
    const take = (size) => {
      if (cursor + size > first.offset + first.length) fail();
      const at = cursor;
      cursor += size;
      return at;
    };
    const flags = data.readUInt32BE(take(4));
    if ((flags & ~15) !== 0 || (flags & 3) !== 3) fail();
    const declaredFrames = data.readUInt32BE(take(4)),
      declaredBytes = data.readUInt32BE(take(4));
    if (declaredFrames !== frames.length - 1 || declaredBytes !== data.length) fail();
    if (flags & 4) {
      const toc = data.subarray(take(100), cursor);
      if (toc.some((value, index) => index > 0 && value < toc[index - 1])) fail();
    }
    if (flags & 8) take(4);
    const encoder = data.toString('ascii', cursor, cursor + 9);
    if (encoder.startsWith('LAME')) {
      // Native LAME gapless values are accepted only after independent frame/byte checks.
      take(36);
      const packed = data.readUIntBE(cursor - 36 + 21, 3);
      delay = packed >>> 12;
      padding = packed & 4095;
      if (delay + padding >= (frames.length - 1) * first.samples) fail();
      gapless = true;
    } else {
      // A tag without encoder extensions may be ignored. Unknown extension formats fail closed.
      if (data.subarray(cursor, first.offset + first.length).some((value) => value !== 0)) fail();
    }
  }
  const audioFrames = metadataFrame ? frames.length - 1 : frames.length,
    maximumSamples = audioFrames * first.samples;
  if ((maximumSamples / sampleRate) * 1000 > gameplayAudioLimits.durationMs) fail();
  // Enforce PCM size independently of format claims before creating a decoder or output file.
  if (44 + maximumSamples * 2 * 2 > gameplayAudioLimits.bytes) fail();
  return {
    frames,
    sampleRate,
    sourceChannels: channels,
    maximumSamples,
    metadataFrame,
    gapless,
    delay,
    padding,
  };
}

/** Returns PCM16 stereo. mpg123's frame API duplicates mono into its two output channels. */
export async function normalizeMpegBytes(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input),
    info = inspectMpegFrames(data),
    decoder = new MPEGDecoder({ enableGapless: info.gapless }),
    pcm = Buffer.alloc(44 + info.maximumSamples * 4);
  let ready = false,
    samples = 0;
  try {
    await decoder.ready;
    ready = true;
    for (const [index, frame] of info.frames.entries()) {
      if (index === 0 && info.metadataFrame && !info.gapless) continue;
      const decoded = decoder.decodeFrame(data.subarray(frame.offset, frame.offset + frame.length));
      if (
        decoded.errors.length ||
        !Number.isSafeInteger(decoded.samplesDecoded) ||
        decoded.samplesDecoded < 0 ||
        decoded.samplesDecoded > 2304 ||
        (decoded.samplesDecoded && decoded.sampleRate !== info.sampleRate) ||
        decoded.channelData.length !== 2
      )
        fail();
      const total = samples + decoded.samplesDecoded;
      if (total > info.maximumSamples || 44 + total * 4 > gameplayAudioLimits.bytes) fail();
      for (let i = 0; i < decoded.samplesDecoded; i++)
        for (let channel = 0; channel < 2; channel++) {
          const value = decoded.channelData[channel][i];
          if (!Number.isFinite(value)) fail();
          pcm.writeInt16LE(
            Math.max(-32768, Math.min(32767, Math.round(value * (value < 0 ? 32768 : 32767)))),
            44 + (samples + i) * 4 + channel * 2,
          );
        }
      samples = total;
    }
    if (!samples) fail();
    const bytes = 44 + samples * 4;
    pcm.write('RIFF');
    pcm.writeUInt32LE(bytes - 8, 4);
    pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20);
    pcm.writeUInt16LE(2, 22);
    pcm.writeUInt32LE(info.sampleRate, 24);
    pcm.writeUInt32LE(info.sampleRate * 4, 28);
    pcm.writeUInt16LE(4, 32);
    pcm.writeUInt16LE(16, 34);
    pcm.write('data', 36);
    pcm.writeUInt32LE(samples * 4, 40);
    const output = pcm.subarray(0, bytes),
      audio = inspectGameplayAudio(output);
    return {
      data: output,
      audio,
      sourceChannels: info.sourceChannels,
      metadata: info.gapless
        ? 'validated-lame-gapless'
        : info.metadataFrame
          ? 'validated-xing-stripped'
          : 'none',
    };
  } finally {
    if (ready) decoder.free();
  }
}

/** New output only; descriptor-anchored input, never follows links or decodes unbounded input. */
export async function normalizeGameplaySound({ input, output }) {
  input = resolve(input);
  output = resolve(output);
  if (input === output || extname(output) !== '.wav')
    throw new Error('Normalization requires a new WAV output file.');
  await localDirectory(dirname(input));
  await localDirectory(dirname(output));
  const { handle, stat } = await regularFile(input, gameplayAudioLimits.bytes);
  let data;
  try {
    const before = await handle.stat({ bigint: true });
    if (stat.size < 24 || before.size !== BigInt(stat.size) || before.nlink !== 1n) fail();
    data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const part = await handle.read(data, offset, data.length - offset, offset);
      if (!part.bytesRead) fail();
      offset += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(
        (key) => after[key] !== before[key],
      )
    )
      fail();
  } finally {
    await handle.close();
  }
  let normalized;
  if (data.toString('ascii', 0, 4) === 'RIFF') {
    const audio = inspectGameplayAudio(data);
    normalized = { data, audio, metadata: 'pcm-source', sourceChannels: audio.channels };
  } else normalized = await normalizeMpegBytes(data);
  const file = await open(
    output,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(normalized.data);
  } finally {
    await file.close();
  }
  return {
    ...normalized.audio,
    bytes: normalized.data.length,
    sourceChannels: normalized.sourceChannels,
    metadata: normalized.metadata,
    sourceSha256: createHash('sha256').update(data).digest('hex'),
    sha256: createHash('sha256').update(normalized.data).digest('hex'),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { input: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.input || !values.output)
    throw new Error('Usage: --input bounded-native.mp3 --output NEW.wav');
  console.log(JSON.stringify(await normalizeGameplaySound(values)));
}
