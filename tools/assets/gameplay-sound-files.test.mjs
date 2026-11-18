import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectGameplayAudio, gameplayAudioLimits } from '../../shared/gameplay-sound-files.mjs';

function pcm() {
  const bytes = new Uint8Array(1644),
    view = new DataView(bytes.buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 1636, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, 1600, true);
  return bytes;
}

test('universal PCM inspector preserves nonzero typed-array/Buffer offsets and accepts genuine ArrayBuffer input without copying', () => {
  const original = pcm(),
    expected = {
      mime: 'audio/wav',
      extension: 'wav',
      durationMs: 100,
      sampleRate: 8000,
      channels: 1,
      decodedBytes: 3200,
    };
  assert.deepEqual(inspectGameplayAudio(original), expected);
  assert.deepEqual(inspectGameplayAudio(original.buffer), expected);
  const storage = new Uint8Array(original.length + 34);
  storage.fill(0xff);
  storage.set(original, 17);
  assert.deepEqual(inspectGameplayAudio(storage.subarray(17, 17 + original.length)), expected);
  const pooled = Buffer.alloc(original.length + 18, 0xee);
  pooled.set(original, 9);
  assert.deepEqual(inspectGameplayAudio(pooled.subarray(9, 9 + original.length)), expected);
  Object.defineProperty(original, 'byteLength', {
    get() {
      throw Error('User property must not be read');
    },
  });
  Object.defineProperty(original, 'buffer', {
    get() {
      throw Error('User property must not be read');
    },
  });
  assert.deepEqual(inspectGameplayAudio(original), expected);
});

test('PCM inspector rejects malicious array-like/proxy/iterable inputs before consulting their allocation hints', () => {
  let touched = false;
  const malicious = {
    get length() {
      touched = true;
      return 2 ** 40;
    },
    get byteLength() {
      touched = true;
      return 2 ** 40;
    },
    [Symbol.iterator]() {
      touched = true;
      throw Error('must not iterate');
    },
  };
  for (const input of [
    malicious,
    [],
    { buffer: pcm().buffer },
    new Uint16Array(100),
    new DataView(pcm().buffer),
    'RIFF',
    null,
    undefined,
    new Proxy(pcm(), {}),
    new Proxy(pcm().buffer, {}),
  ])
    assert.throws(() => inspectGameplayAudio(input));
  assert.equal(touched, false);
  assert.throws(() => inspectGameplayAudio(new Uint8Array(gameplayAudioLimits.bytes + 1)), /size/);
  if (typeof SharedArrayBuffer !== 'undefined')
    assert.throws(() => inspectGameplayAudio(new Uint8Array(new SharedArrayBuffer(1644))));
});

test('one strict PCM policy rejects extended format chunks, high-depth samples and forged bounds in every environment', () => {
  const bits = pcm();
  new DataView(bits.buffer).setUint16(34, 24, true);
  assert.throws(() => inspectGameplayAudio(bits), /encoding/);
  const extended = pcm();
  new DataView(extended.buffer).setUint32(16, 18, true);
  assert.throws(() => inspectGameplayAudio(extended), /format/);
  const truncated = pcm();
  new DataView(truncated.buffer).setUint32(40, 0xffffffff, true);
  assert.throws(() => inspectGameplayAudio(truncated), /Truncated/);
});
