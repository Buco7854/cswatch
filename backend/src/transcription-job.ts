/** Only the disposable, kernel-confined transcription child executes this module. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { manifestSchema, chunkSchema, replayLimits } from './replay.js';
import { transcribeVoice, type TranscriptionOptions } from './transcription.js';
import type { VoicePacket, CaptionCue } from '../../shared/communications.js';

function readJson(path: string, maximum: number) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > maximum
  )
    throw new Error('Invalid transcription input.');
  return JSON.parse(gunzipSync(readFileSync(path), { maxOutputLength: maximum }).toString('utf8'));
}

export async function runTranscriptionJob(folder: string, options: TranscriptionOptions) {
  const manifest = manifestSchema.parse(
    readJson(join(folder, 'manifest.json.gz'), replayLimits.manifestBytes),
  );
  const voice: VoicePacket[] = [];
  const seen = new Map<string, VoicePacket>();
  let bytes = 0;
  for (const [index, descriptor] of manifest.chunks.entries()) {
    if (descriptor.index !== index) throw new Error('Invalid transcription chunk order.');
    const chunk = chunkSchema.parse(
      readJson(join(folder, 'chunks', `${index}.json.gz`), replayLimits.chunkBytes),
    );
    if (chunk.index !== index) throw new Error('Invalid transcription chunk.');
    for (const packet of chunk.voice ?? []) {
      const previous = seen.get(packet.id);
      if (previous) {
        if (
          previous.opus !== packet.opus ||
          previous.tick !== packet.tick ||
          previous.speaker !== packet.speaker
        )
          throw new Error('Conflicting transcription voice packet.');
        continue;
      }
      bytes += Buffer.byteLength(packet.opus);
      if (bytes > 64 * 1024 ** 2 || voice.length >= 250000)
        throw new Error('Transcription voice input limit.');
      seen.set(packet.id, packet);
      if (packet.tick >= manifest.firstTick && packet.tick <= manifest.lastTick) voice.push(packet);
    }
  }
  const result = await transcribeVoice(voice, manifest.tickRate, options);
  if (result.status === 'failed' || result.status === 'disabled')
    throw new Error('Transcription failed.');
  let status = result.status;
  const speakers = new Set(manifest.players.map((player) => player.id));
  const cues: CaptionCue[] = [];
  let outputBytes = 0;
  for (const original of result.cues) {
    const cue: CaptionCue = {
      ...original,
      speaker: original.speaker && speakers.has(original.speaker) ? original.speaker : null,
      startTick: Math.max(manifest.firstTick, original.startTick),
      endTick: Math.min(manifest.lastTick, original.endTick),
    };
    if (cue.endTick <= cue.startTick) continue;
    outputBytes += Buffer.byteLength(JSON.stringify(cue)) + 1;
    if (outputBytes > 1500 * 1024 || cues.length >= 10000) {
      status = 'partial';
      break;
    }
    cues.push(cue);
  }
  const json = JSON.stringify({ status, cues });
  if (Buffer.byteLength(json) > 2 * 1024 ** 2) throw new Error('Transcription output limit.');
  writeFileSync(join(folder, 'captions.json.gz'), gzipSync(json), { flag: 'wx', mode: 0o600 });
  return { status, cues: cues.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !process.env.CSWATCH_TRANSCRIPTION_MODEL_DIR)
    throw new Error('Invalid transcription child configuration.');
  const seconds = Number(process.env.CSWATCH_TRANSCRIPTION_MAX_AUDIO_SECONDS || 600);
  const timeout = Number(process.env.CSWATCH_TRANSCRIPTION_TIMEOUT_MS || 600000);
  await runTranscriptionJob(resolve(process.argv[2]), {
    modelDir: process.env.CSWATCH_TRANSCRIPTION_MODEL_DIR,
    maxAudioSeconds: seconds,
    maxWallTimeMs: Math.max(1, timeout - 2000),
    language: process.env.CSWATCH_TRANSCRIPTION_LANGUAGE || 'auto',
  });
}
