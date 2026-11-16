/** Public-domain JFK speech fixture; no personal demo/audio/account is used. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import OpusScript from 'opusscript';
import { writeReplay } from '../../backend/dist/replay.js';
import { runTranscriptionJob } from '../../backend/dist/transcription-job.js';
import { transcribeVoice } from '../../backend/dist/transcription.js';

const fixture = {
  url: 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/542437c29cc5273cfd29e25c77696f2b349badd7/jfk.wav',
  bytes: 1940478,
  sha256: 'aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8',
};
const fixturePath = fileURLToPath(
  new URL('../../var/transcription-fixture/jfk.wav', import.meta.url),
);

async function downloadFixture(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > limit)
    throw new Error('Speech fixture download failed.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Speech fixture download limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fixturePackets() {
  let wav;
  try {
    wav = readFileSync(fixturePath);
  } catch {
    wav = await downloadFixture(fixture.url, fixture.bytes);
  }
  if (
    wav.length !== fixture.bytes ||
    createHash('sha256').update(wav).digest('hex') !== fixture.sha256
  )
    throw new Error('Public speech fixture checksum mismatch.');
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, wav);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let format, data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4),
      size = wav.readUInt32LE(offset + 4);
    if (offset + size + 8 > wav.length) throw new Error('Invalid WAV fixture chunk.');
    if (id === 'fmt ')
      format = {
        type: wav.readUInt16LE(offset + 8),
        channels: wav.readUInt16LE(offset + 10),
        rate: wav.readUInt32LE(offset + 12),
        bits: wav.readUInt16LE(offset + 22),
      };
    if (id === 'data') data = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  assert.deepEqual(format, { type: 1, channels: 2, rate: 44100, bits: 16 });
  assert.ok(data);
  // This known 44.1 kHz stereo fixture is mixed/resampled only for the test encoder.
  // Production Opus decoding outputs 16 kHz directly through libopus.
  const count = data.length / 4,
    outputCount = Math.floor((count * 16000) / 44100);
  const mono = (index) =>
    (data.readInt16LE(Math.min(count - 1, index) * 4) +
      data.readInt16LE(Math.min(count - 1, index) * 4 + 2)) /
    65536;
  const audio = Float32Array.from({ length: outputCount }, (_, i) => {
    const position = (i * 44100) / 16000,
      start = Math.floor(position),
      alpha = position - start;
    return mono(start) * (1 - alpha) + mono(start + 1) * alpha;
  });
  return encodeAudio(audio);
}

function encodeAudio(audio) {
  const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  encoder.encoderCTL(4002, 24000);
  const packets = [];
  try {
    for (let offset = 0; offset < audio.length; offset += 320) {
      const pcm = Buffer.alloc(640);
      for (let i = 0; i < 320; i++)
        pcm.writeInt16LE(
          Math.max(-32768, Math.min(32767, Math.round((audio[offset + i] || 0) * 32768))),
          i * 2,
        );
      const opus = encoder.encode(pcm, 320);
      packets.push({
        id: 'fixture-voice-' + packets.length,
        speaker: '76561198000000001',
        tick: 128 + (offset / 16000) * 64,
        opus: opus.toString('base64'),
        sampleRate: 16000,
        channels: 1,
        durationMs: 20,
      });
    }
  } finally {
    encoder.delete();
  }
  return packets;
}

export async function verifyFrenchTranscription(modelDir) {
  const path = fileURLToPath(
    new URL('../../var/transcription-fixture/french-audio.mp3', import.meta.url),
  );
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    bytes = await downloadFixture(
      'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/542437c29cc5273cfd29e25c77696f2b349badd7/french-audio.mp3',
      99893,
    );
  }
  assert.equal(bytes.length, 99893);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '5a2493df7ae8b7ea5cb06c636df8b1a3d8990161963fa38313be9d9c01af772b',
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  const { MPEGDecoder } = await import('mpg123-decoder');
  const decoder = new MPEGDecoder();
  await decoder.ready;
  let audio;
  try {
    const result = decoder.decode(bytes);
    assert.equal(result.errors.length, 0);
    const count = result.samplesDecoded,
      size = Math.floor((count * 16000) / result.sampleRate);
    const at = (index) =>
      result.channelData.reduce((sum, channel) => sum + channel[Math.min(count - 1, index)], 0) /
      result.channelData.length;
    audio = Float32Array.from({ length: size }, (_, index) => {
      const point = (index * result.sampleRate) / 16000,
        first = Math.floor(point),
        alpha = point - first;
      return at(first) * (1 - alpha) + at(first + 1) * alpha;
    });
  } finally {
    decoder.free();
  }
  const packets = encodeAudio(audio);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Offline French inference attempted a network request.');
  };
  try {
    for (const language of ['fr', 'auto']) {
      const result = await transcribeVoice(packets, 64, {
        modelDir: resolve(modelDir),
        language,
        maxAudioSeconds: 30,
        maxWallTimeMs: 120000,
      });
      assert.equal(result.status, 'ready');
      const text = result.cues.map((cue) => cue.text).join(' ');
      assert.match(text, /adore/i);
      assert.match(text, /d[eé]teste/i);
      assert.ok(result.cues.every((cue) => cue.language === 'fr'));
      console.log(
        JSON.stringify({
          fixture: 'French documentation audio',
          language,
          detected: result.cues[0].language,
          text,
        }),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export function fixtureReplay(voice) {
  const player = {
    id: '76561198000000001',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    health: 100,
    team: 3,
    alive: true,
    weapon: 'knife',
  };
  return {
    version: 1,
    map: 'de_mirage',
    sample: true,
    tickRate: 64,
    players: [{ id: player.id, name: 'Public-domain speech fixture', team: 3 }],
    rounds: [{ number: 1, tick: 0, liveTick: 0, endTick: 960 }],
    events: [],
    frames: Array.from({ length: 241 }, (_, i) => ({ tick: i * 4, players: [player] })),
    grenades: [],
    voice,
  };
}

export async function verifyTranscription(modelDir, retainedJob) {
  const packets = await fixturePackets();
  const folder = retainedJob
    ? resolve(retainedJob)
    : mkdtempSync(join(tmpdir(), 'cswatch-asr-verify-'));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    await writeReplay(folder, fixtureReplay(packets));
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    globalThis.fetch = async () => {
      networkRequests++;
      throw new Error('Offline inference attempted a network request.');
    };
    const started = performance.now();
    try {
      await runTranscriptionJob(folder, {
        modelDir: resolve(modelDir),
        maxAudioSeconds: 30,
        maxWallTimeMs: 120000,
        language: 'auto',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const result = JSON.parse(
      gunzipSync(readFileSync(join(folder, 'captions.json.gz'))).toString('utf8'),
    );
    assert.equal(result.status, 'ready');
    assert.equal(networkRequests, 0);
    assert.ok(result.cues.length > 0);
    const text = result.cues.map((cue) => cue.text).join(' ');
    assert.match(text, /fellow Americans/i);
    assert.match(text, /country/i);
    assert.ok(
      result.cues.every(
        (cue) =>
          cue.speaker === '76561198000000001' &&
          cue.source === 'local-transcription' &&
          cue.language === 'en' &&
          cue.startTick >= 128 &&
          cue.endTick <= 128 + packets.length * 1.28,
      ),
    );
    const verification = {
      seconds: Math.round((performance.now() - started) / 10) / 100,
      packets: packets.length,
      cues: result.cues.length,
      networkRequests,
      text,
    };
    console.log(JSON.stringify(verification));
    return verification;
  } finally {
    if (!retainedJob) rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    ![2, 4].includes(args.length) ||
    args[0] !== '--model' ||
    (args.length === 4 && args[2] !== '--keep-job')
  )
    throw new Error(
      'Usage: node tools/transcription/verify-transcription.mjs --model /path/to/whisper-tiny [--keep-job /tmp/empty-asr-fixture-job]',
    );
  await verifyTranscription(args[1], args[3]);
}
