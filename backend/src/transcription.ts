/** Optional, offline CPU speech recognition. Import only inside the disposable ASR child. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { OpusDecoder } from 'opus-decoder';
import { opusDuration } from './voice-packets.js';
import type { VoicePacket, CaptionCue } from '../../shared/communications.js';

const SAMPLE_RATE = 16000;
const MAX_VOICE_BYTES = 64 * 1024 ** 2;
const MAX_CUES = 10000;
type VoiceUtterance = {
  speaker: string;
  startTick: number;
  endTick: number;
  channels: 1 | 2;
  packets: VoicePacket[];
};
export type TranscriptionOptions = {
  modelDir: string;
  maxAudioSeconds?: number;
  maxWallTimeMs?: number;
  language?: string;
};
type TranscriptionResult = {
  status: 'ready' | 'partial' | 'disabled' | 'failed' | 'unavailable';
  cues: CaptionCue[];
  warnings: string[];
  processedPackets: number;
};
type Recognition = {
  text?: string;
  language?: string;
  chunks?: { text?: string; timestamp?: [number | null, number | null] }[];
};
export type SpeechRecognizer = {
  recognize(audio: Float32Array, language?: string): Promise<Recognition>;
  dispose(): Promise<void>;
};

function validPacket(packet: VoicePacket) {
  if (
    !packet ||
    typeof packet.id !== 'string' ||
    packet.id.length < 1 ||
    packet.id.length > 100 ||
    typeof packet.speaker !== 'string' ||
    !/^\d{1,20}$/.test(packet.speaker) ||
    !Number.isFinite(packet.tick) ||
    packet.tick < 0 ||
    packet.tick > 1e9 ||
    ![1, 2].includes(packet.channels) ||
    ![8000, 12000, 16000, 24000, 48000].includes(packet.sampleRate) ||
    typeof packet.opus !== 'string' ||
    packet.opus.length < 4 ||
    packet.opus.length > 10924 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.opus)
  )
    return false;
  try {
    const bytes = Buffer.from(packet.opus, 'base64');
    return (
      bytes.length <= 8192 &&
      opusDuration(bytes) === packet.durationMs &&
      (bytes[0] & 4 ? 2 : 1) === packet.channels
    );
  } catch {
    return false;
  }
}

/** Group the actual speaker timeline, preserving short silence gaps and separating simultaneous voices. */
export function groupVoicePackets(packets: VoicePacket[], tickRate: number) {
  if (!Number.isInteger(tickRate) || tickRate < 1 || tickRate > 128 || packets.length > 250000)
    throw new Error('Voice input limit.');
  const speakers = new Map<string, VoicePacket[]>();
  const ids = new Map<string, VoicePacket>();
  let bytes = 0,
    invalid = 0;
  for (const packet of packets) {
    if (!validPacket(packet)) {
      invalid++;
      continue;
    }
    const previous = ids.get(packet.id);
    if (previous) {
      if (
        previous.tick !== packet.tick ||
        previous.opus !== packet.opus ||
        previous.speaker !== packet.speaker ||
        previous.channels !== packet.channels ||
        previous.sampleRate !== packet.sampleRate
      )
        throw new Error('Conflicting voice packet.');
      continue;
    }
    ids.set(packet.id, packet);
    bytes += Buffer.byteLength(packet.opus);
    if (bytes > MAX_VOICE_BYTES) throw new Error('Voice input limit.');
    const stream = speakers.get(packet.speaker) ?? [];
    stream.push(packet);
    speakers.set(packet.speaker, stream);
    if (speakers.size > 128) throw new Error('Voice speaker limit.');
  }
  const utterances: VoiceUtterance[] = [];
  for (const [speaker, stream] of speakers) {
    stream.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
    let current: VoiceUtterance | null = null;
    for (const packet of stream) {
      const end = packet.tick + (packet.durationMs * tickRate) / 1000;
      if (
        !current ||
        (packet.tick - current.endTick) / tickRate > 0.7 ||
        (end - current.startTick) / tickRate > 30 ||
        packet.channels !== current.channels ||
        packet.sampleRate !== current.packets[0].sampleRate
      ) {
        current = {
          speaker,
          startTick: packet.tick,
          endTick: end,
          channels: packet.channels,
          packets: [],
        };
        utterances.push(current);
      }
      current.packets.push(packet);
      current.endTick = Math.max(current.endTick, end);
    }
  }
  utterances.sort((a, b) => a.startTick - b.startTick || a.speaker.localeCompare(b.speaker));
  return { utterances, invalid };
}

/** Raw Opus is decoded directly at 16 kHz; no ffmpeg, subprocess, file write or network is needed. */
export async function decodeUtterance(utterance: VoiceUtterance, tickRate: number) {
  const length = Math.ceil(((utterance.endTick - utterance.startTick) / tickRate) * SAMPLE_RATE);
  if (length < 1 || length > SAMPLE_RATE * 30 + 1) throw new Error('Utterance duration limit.');
  const decoder = new OpusDecoder({
    sampleRate: 16000,
    channels: utterance.channels,
    streamCount: 1,
    coupledStreamCount: utterance.channels === 2 ? 1 : 0,
    channelMappingTable: utterance.channels === 2 ? [0, 1] : [0],
  });
  await decoder.ready;
  const audio = new Float32Array(length);
  let invalid = 0;
  try {
    for (const packet of utterance.packets) {
      const frame = decoder.decodeFrame(Buffer.from(packet.opus, 'base64'));
      if (
        frame.errors.length ||
        frame.sampleRate !== SAMPLE_RATE ||
        frame.channelData.length !== utterance.channels ||
        !frame.samplesDecoded ||
        frame.samplesDecoded > SAMPLE_RATE * 0.12
      ) {
        invalid++;
        continue;
      }
      const offset = Math.max(
        0,
        Math.round(((packet.tick - utterance.startTick) / tickRate) * SAMPLE_RATE),
      );
      for (let i = 0; i < frame.samplesDecoded && offset + i < audio.length; i++) {
        let sum = 0;
        for (const channel of frame.channelData)
          sum += Number.isFinite(channel[i]) ? channel[i] : 0;
        audio[offset + i] = Math.max(-1, Math.min(1, sum / frame.channelData.length));
      }
    }
  } finally {
    decoder.free();
  }
  let energy = 0;
  for (const sample of audio) energy += sample * sample;
  return { audio, invalid, silent: energy / audio.length <= 1e-8 };
}

function localModelDirectory(directory: string) {
  const root = realpathSync(directory);
  let bytes = 0;
  for (const name of [
    'config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ]) {
    const info = lstatSync(join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 128 * 1024 ** 2)
      throw new Error('Invalid offline model.');
    bytes += info.size;
  }
  if (
    bytes > 200 * 1024 ** 2 ||
    lstatSync(join(root, 'config.json')).size > 65536 ||
    lstatSync(join(root, 'preprocessor_config.json')).size > 65536
  )
    throw new Error('Offline model limit.');
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  const processor = JSON.parse(readFileSync(join(root, 'preprocessor_config.json'), 'utf8'));
  if (
    config.model_type !== 'whisper' ||
    config.d_model > 512 ||
    config.decoder_layers > 6 ||
    processor.sampling_rate !== SAMPLE_RATE
  )
    throw new Error('Use a quantized Whisper tiny/base multilingual model.');
  return root;
}

async function localRecognizer(directory: string): Promise<SpeechRecognizer> {
  const root = localModelDirectory(directory);
  const { pipeline, env, Tensor } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.localModelPath = '';
  const recognizer = await pipeline('automatic-speech-recognition', root, {
    device: 'cpu',
    dtype: 'q8',
    local_files_only: true,
    use_external_data_format: false,
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential' },
  });
  async function detectLanguage(audio: Float32Array) {
    // Transformers.js currently defaults to English instead of implementing Whisper lang-ID.
    // Match OpenAI Whisper's SOT-only forward pass and restrict logits to language tokens:
    // https://github.com/openai/whisper/blob/main/whisper/decoding.py#L19
    const generation = recognizer.model.generation_config as unknown as {
      decoder_start_token_id: number;
      lang_to_id: Record<string, number>;
    };
    if (!Number.isSafeInteger(generation.decoder_start_token_id) || !generation.lang_to_id)
      throw new Error('The model does not support language detection.');
    const inputs = await recognizer.processor!(audio);
    const initial = new Tensor(
      'int64',
      BigInt64Array.of(BigInt(generation.decoder_start_token_id)),
      [1, 1],
    );
    let output: unknown;
    const release = (value: unknown) => {
      if (value instanceof Tensor) value.dispose();
      else if (value && typeof value === 'object')
        for (const item of Object.values(value)) release(item);
    };
    try {
      output = await recognizer.model({ ...inputs, decoder_input_ids: initial });
      const logits = (output as { logits?: { data: Float32Array; dims: number[] } }).logits;
      if (!logits || logits.dims.length !== 3 || logits.dims[0] !== 1 || logits.dims[1] !== 1)
        throw new Error('Language detection failed.');
      let best = '',
        score = -Infinity;
      for (const [token, index] of Object.entries(generation.lang_to_id)) {
        if (
          /^<\|[a-z]{2,3}\|>$/.test(token) &&
          Number.isInteger(index) &&
          Number.isFinite(logits.data[index]) &&
          logits.data[index] > score
        ) {
          best = token.slice(2, -2);
          score = logits.data[index];
        }
      }
      if (!best) throw new Error('Language detection failed.');
      return best;
    } finally {
      release(inputs);
      release(output);
      initial.dispose();
    }
  }
  return {
    recognize: async (audio, language) => {
      const detected = !language || language === 'auto' ? await detectLanguage(audio) : language;
      const result = await recognizer(audio, {
        task: 'transcribe',
        return_timestamps: true,
        max_new_tokens: 256,
        language: detected,
      });
      return { ...result, language: detected };
    },
    dispose: () => recognizer.dispose(),
  };
}

/** Model timestamps are approximate: clamp them to the recorded utterance, never invent words. */
export function recognitionCues(
  result: Recognition,
  utterance: VoiceUtterance,
  tickRate: number,
  language?: string,
): CaptionCue[] {
  const duration = (utterance.endTick - utterance.startTick) / tickRate;
  const chunks =
    Array.isArray(result.chunks) && result.chunks.length
      ? result.chunks.slice(0, 1000)
      : [{ text: result.text, timestamp: [0, duration] as [number, number] }];
  return chunks.flatMap((chunk) => {
    const text =
      typeof chunk.text === 'string'
        ? chunk.text
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500)
        : '';
    if (!text) return [];
    const start =
      typeof chunk.timestamp?.[0] === 'number' && Number.isFinite(chunk.timestamp[0])
        ? Math.max(0, Math.min(duration, chunk.timestamp[0]))
        : 0;
    const end =
      typeof chunk.timestamp?.[1] === 'number' && Number.isFinite(chunk.timestamp[1])
        ? Math.max(start, Math.min(duration, chunk.timestamp[1]))
        : duration;
    if (end <= start) return [];
    return [
      {
        id: '',
        speaker: utterance.speaker,
        startTick: utterance.startTick + start * tickRate,
        endTick: utterance.startTick + end * tickRate,
        text,
        source: 'local-transcription' as const,
        ...(language && language !== 'auto' ? { language } : {}),
      },
    ];
  });
}

export async function transcribeVoice(
  packets: VoicePacket[],
  tickRate: number,
  options: TranscriptionOptions,
  dependencies: {
    recognizer?: (directory: string) => Promise<SpeechRecognizer>;
    decode?: typeof decodeUtterance;
    now?: () => number;
  } = {},
): Promise<TranscriptionResult> {
  const output: TranscriptionResult = {
    status: 'ready',
    cues: [],
    warnings: [],
    processedPackets: 0,
  };
  if (!packets.length) return { ...output, status: 'unavailable' };
  if (!options.modelDir) return { ...output, status: 'disabled' };
  const maxAudio = options.maxAudioSeconds ?? 600,
    maxTime = options.maxWallTimeMs ?? 600000;
  if (
    !Number.isFinite(maxAudio) ||
    maxAudio <= 0 ||
    maxAudio > 10800 ||
    !Number.isFinite(maxTime) ||
    maxTime < 1 ||
    maxTime > 3600000
  )
    throw new Error('Transcription budget is invalid.');
  const now = dependencies.now ?? (() => performance.now()),
    started = now();
  const { utterances, invalid } = groupVoicePackets(packets, tickRate);
  let recognizer: SpeechRecognizer;
  try {
    recognizer = await (dependencies.recognizer ?? localRecognizer)(options.modelDir);
  } catch {
    return {
      ...output,
      status: 'unavailable',
      warnings: ['The offline transcription model could not be loaded.'],
    };
  }
  let seconds = 0,
    failures = 0,
    partial = invalid > 0;
  try {
    for (const [index, utterance] of utterances.entries()) {
      const duration = (utterance.endTick - utterance.startTick) / tickRate;
      if (
        now() - started >= maxTime ||
        seconds + duration > maxAudio ||
        index >= 512 ||
        output.cues.length >= MAX_CUES
      ) {
        partial = true;
        break;
      }
      try {
        const decoded = await (dependencies.decode ?? decodeUtterance)(utterance, tickRate);
        partial ||= decoded.invalid > 0;
        seconds += duration;
        output.processedPackets += utterance.packets.length;
        if (decoded.silent) continue;
        const result = await recognizer.recognize(decoded.audio, options.language);
        for (const cue of recognitionCues(
          result,
          utterance,
          tickRate,
          result.language || options.language,
        )) {
          if (output.cues.length >= MAX_CUES) {
            partial = true;
            break;
          }
          cue.id = 'asr-' + output.cues.length;
          output.cues.push(cue);
        }
      } catch {
        failures++;
        partial = true;
        if (failures >= 3) break;
      }
    }
  } finally {
    await recognizer.dispose();
  }
  output.cues.sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick);
  if (partial)
    output.warnings.push(
      'Some recorded speech could not be transcribed within the processing limits.',
    );
  output.status = failures && !output.cues.length ? 'failed' : partial ? 'partial' : 'ready';
  return output;
}
