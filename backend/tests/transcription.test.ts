import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupVoicePackets,
  decodeUtterance,
  recognitionCues,
  transcribeVoice,
  type SpeechRecognizer,
} from '../src/transcription.js';
import type { VoicePacket } from '../../shared/communications.js';

const opus = Buffer.from([0xf8, 0xff, 0xfe]).toString('base64'); // Valid 20 ms Opus DTX silence.
const speaker = '76561198000000001';
const packet = (id: string, tick: number, subject = speaker): VoicePacket => ({
  id,
  tick,
  speaker: subject,
  opus,
  sampleRate: 24000,
  channels: 1,
  durationMs: 20,
});

test('voice grouping keeps speaker streams separate, preserves short gaps and bounds utterances', () => {
  const first = packet('one', 0);
  const { utterances, invalid } = groupVoicePackets(
    [
      packet('later', 120),
      packet('two', 40),
      packet('other', 20, '76561198000000002'),
      first,
      { ...first },
    ],
    64,
  );
  assert.equal(invalid, 0);
  assert.deepEqual(
    utterances.map((group) => [group.speaker, group.startTick, group.packets.length]),
    [
      [speaker, 0, 2],
      ['76561198000000002', 20, 1],
      [speaker, 120, 1],
    ],
  );
  assert.throws(() => groupVoicePackets([first, { ...first, tick: 1 }], 64), /Conflicting/);
  assert.equal(groupVoicePackets([{ ...first, durationMs: 121 }], 64).invalid, 1);
  const long = groupVoicePackets(
    Array.from({ length: 1501 }, (_, i) => packet('p' + i, i * 1.28)),
    64,
  ).utterances;
  assert.equal(
    long.reduce((sum, group) => sum + group.packets.length, 0),
    1501,
  );
  assert.ok(long.length >= 2);
  assert.ok(long.every((group) => (group.endTick - group.startTick) / 64 <= 30));
});

test('real libopus decoding returns 16 kHz silence without a transcription hallucination', async () => {
  const utterance = groupVoicePackets(
    Array.from({ length: 10 }, (_, i) => packet('p' + i, i * 1.28)),
    64,
  ).utterances[0];
  const decoded = await decodeUtterance(utterance, 64);
  assert.equal(decoded.invalid, 0);
  assert.equal(decoded.silent, true);
  assert.ok(decoded.audio.length >= 3200 && decoded.audio.length <= 3201);
  let recognized = 0,
    disposed = 0;
  const result = await transcribeVoice(
    utterance.packets,
    64,
    { modelDir: 'explicit-unit-test-model' },
    {
      recognizer: async () => ({
        recognize: async () => {
          recognized++;
          return { text: 'Must never be generated.' };
        },
        dispose: async () => {
          disposed++;
        },
      }),
    },
  );
  assert.equal(recognized, 0);
  assert.equal(disposed, 1);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.cues, []);
});

test('caption timestamps clamp to recorded speech and preserve immutable speaker strings', () => {
  const utterance = groupVoicePackets([packet('p', 100)], 64).utterances[0];
  const cues = recognitionCues(
    {
      chunks: [
        { text: '  Test\n communication.  ', timestamp: [-1, 300] },
        { text: '', timestamp: [0, null] },
      ],
    },
    utterance,
    64,
    'fr',
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].speaker, speaker);
  assert.equal(cues[0].startTick, 100);
  assert.equal(cues[0].endTick, 101.28);
  assert.equal(cues[0].text, 'Test communication.');
  assert.equal(cues[0].source, 'local-transcription');
  assert.equal(cues[0].language, 'fr');
});

test('audio/time budgets produce partial captions, and inference failures release the model', async () => {
  const packets = [packet('first', 0), packet('second', 64), packet('third', 128)];
  let calls = 0,
    disposed = 0;
  const recognizer: SpeechRecognizer = {
    recognize: async () => {
      calls++;
      return { text: 'Explicit synthetic unit-test cue.' };
    },
    dispose: async () => {
      disposed++;
    },
  };
  const dependencies = {
    recognizer: async () => recognizer,
    decode: async () => ({ audio: Float32Array.of(0.1), invalid: 0, silent: false }),
  };
  const partial = await transcribeVoice(
    packets,
    64,
    { modelDir: 'explicit-unit-test-model', maxAudioSeconds: 0.03 },
    dependencies,
  );
  assert.equal(partial.status, 'partial');
  assert.equal(partial.cues.length, 1);
  assert.equal(calls, 1);
  assert.equal(disposed, 1);
  let clock = 0;
  const timed = await transcribeVoice(
    packets,
    64,
    { modelDir: 'explicit-unit-test-model', maxWallTimeMs: 10 },
    { ...dependencies, now: () => (clock++ ? 100 : 0) },
  );
  assert.equal(timed.status, 'partial');
  assert.deepEqual(timed.cues, []);
  assert.equal(calls, 1);
  const failed = await transcribeVoice(
    packets,
    64,
    { modelDir: 'explicit-unit-test-model' },
    {
      ...dependencies,
      recognizer: async () => ({
        ...recognizer,
        recognize: async () => {
          throw new Error('Synthetic inference failure.');
        },
      }),
    },
  );
  assert.equal(failed.status, 'failed');
  assert.equal(disposed, 3);
  assert.equal((await transcribeVoice(packets, 64, { modelDir: '' })).status, 'disabled');
  assert.equal((await transcribeVoice([], 64, { modelDir: 'unused' })).status, 'unavailable');
});

test(
  'known public-domain speech completes raw Opus → local CPU model → timed caption artifacts',
  {
    skip:
      !process.env.CSWATCH_TRANSCRIPTION_TEST_MODEL &&
      'Set CSWATCH_TRANSCRIPTION_TEST_MODEL after preparing the offline model.',
  },
  async () => {
    const { verifyTranscription } =
      await import('../../tools/transcription/verify-transcription.mjs');
    await verifyTranscription(process.env.CSWATCH_TRANSCRIPTION_TEST_MODEL!);
  },
);

test(
  'French speech transcribes in French with explicit and detected language settings',
  {
    skip:
      !process.env.CSWATCH_TRANSCRIPTION_TEST_MODEL &&
      'Set CSWATCH_TRANSCRIPTION_TEST_MODEL after preparing the offline model.',
  },
  async () => {
    const { verifyFrenchTranscription } =
      await import('../../tools/transcription/verify-transcription.mjs');
    await verifyFrenchTranscription(process.env.CSWATCH_TRANSCRIPTION_TEST_MODEL!);
  },
);
