import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceFrames } from '../src/voice-packets.js';

const silence = Uint8Array.from([0xf8, 0xff, 0xfe]);
const audio = {
  format: 2,
  sample_rate: 48000,
  voice_data: silence,
  num_packets: 1,
  packet_offsets: [3, 0, 0, 1341593608],
};

test('recorded Opus uses declared cumulative ends and ignores unused capacity slots', () => {
  for (const tail of [[], [0, 0, 1341593608], [1, 999999, -1], [NaN, Infinity]]) {
    const frames = voiceFrames({ ...audio, packet_offsets: [silence.length, ...tail] });
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], { data: silence, sampleRate: 48000, durationMs: 20, channels: 1 });
  }
});

test('multiple recorded packets retain exact boundaries and individual durations', () => {
  const second = Uint8Array.from([0x78, 0x01]),
    voice_data = Uint8Array.from([...silence, ...second]);
  const frames = voiceFrames({
    ...audio,
    voice_data,
    num_packets: 2,
    packet_offsets: [3, 5, 0, 4294967295],
  });
  assert.deepEqual(
    frames.map((frame) => frame.data),
    [silence, second],
  );
  assert.deepEqual(
    frames.map((frame) => frame.durationMs),
    [20, 20],
  );
  const maximum = Uint8Array.from(Array.from({ length: 128 }, () => [...silence]).flat());
  assert.equal(
    voiceFrames({
      ...audio,
      voice_data: maximum,
      num_packets: 128,
      packet_offsets: Array.from({ length: 128 }, (_, index) => (index + 1) * 3),
    }).length,
    128,
  );
});

test('absent offsets allow exactly one unframed packet and never invent multi-packet boundaries', () => {
  assert.deepEqual(voiceFrames({ format: 2, voice_data: silence }), voiceFrames(audio));
  assert.deepEqual(voiceFrames({ ...audio, packet_offsets: [] }), voiceFrames(audio));
  assert.throws(
    () => voiceFrames({ ...audio, packet_offsets: [], num_packets: 2 }),
    /Missing Opus packet boundaries/,
  );
});

test('recorded Opus rejects malformed counts, table overflow, gaps and truncated boundaries', () => {
  for (const num_packets of [0, -1, 1.5, 129, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => voiceFrames({ ...audio, num_packets }), /Invalid Opus packet count/);
  assert.throws(
    () => voiceFrames({ ...audio, num_packets: undefined }),
    /Opus packet count mismatch/,
  );
  assert.throws(() => voiceFrames({ ...audio, num_packets: 5 }), /Opus packet count mismatch/);
  assert.throws(
    () => voiceFrames({ ...audio, packet_offsets: Array(129).fill(3) }),
    /Invalid Opus packet offsets/,
  );
  for (const packet_offsets of [
    [0],
    [2],
    [4],
    [-1],
    [1.5],
    [NaN],
    [Infinity],
    [Number.MAX_SAFE_INTEGER],
  ])
    assert.throws(() => voiceFrames({ ...audio, packet_offsets }), /Invalid Opus packet offsets/);
  for (const packet_offsets of [
    [3, 3],
    [4, 3],
    [0, 3],
  ])
    assert.throws(
      () => voiceFrames({ ...audio, num_packets: 2, packet_offsets }),
      /Invalid Opus packet offsets/,
    );
});

test('valid boundaries still enforce per-frame size, rate, duration and codec limits', () => {
  assert.throws(
    () => voiceFrames({ ...audio, voice_data: Uint8Array.from([0xfb, 63]), packet_offsets: [2] }),
    /Invalid Opus duration/,
  );
  assert.throws(
    () => voiceFrames({ ...audio, sample_rate: 12345 }),
    /Unsupported voice sample rate/,
  );
  assert.throws(
    () => voiceFrames({ ...audio, voice_data: new Uint8Array(8193), packet_offsets: [8193] }),
    /Invalid Opus frame/,
  );
  assert.throws(
    () =>
      voiceFrames({
        ...audio,
        voice_data: new Uint8Array(256 * 1024 + 1),
        packet_offsets: [256 * 1024 + 1],
      }),
    /Voice packet limit/,
  );
  assert.throws(() => voiceFrames({ ...audio, format: 1 }), /Unsupported recorded voice codec/);
});
