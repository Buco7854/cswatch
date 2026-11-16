import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { PlaybackManifest } from '../../shared/playback.js';
import type { CaptionCue } from '../../shared/communications.js';
import { captionCueSchema } from './replay.js';

export const captionLimits = { bytes: 2 * 1024 ** 2, cues: 20000 } as const;
export function captionArtifactName(value: unknown) {
  if (typeof value !== 'string' || !/^captions-[a-f0-9]{32}\.json\.gz$/.test(value))
    throw new Error('Invalid caption artifact name');
  return value;
}
export type CaptionEnvelope = { status: 'ready' | 'partial' | 'unavailable'; cues: CaptionCue[] };
export const captionEnvelopeSchema = z
  .object({
    status: z.enum(['ready', 'partial', 'unavailable']),
    cues: z
      .array(
        captionCueSchema.extend({
          id: z.string().min(1).max(80),
          text: z
            .string()
            .min(1)
            .max(1000)
            .refine((value) => value.trim().length > 0),
          source: z.literal('local-transcription'),
        }),
      )
      .max(captionLimits.cues),
  })
  .strict();

/** The native/model child cannot choose arbitrary speakers, paths, time bounds or output size. */
export function validateCaptionArtifact(
  folder: string,
  manifest: Pick<PlaybackManifest, 'firstTick' | 'lastTick' | 'players'>,
): { result: CaptionEnvelope; bytes: number } {
  const path = join(folder, 'captions.json.gz'),
    info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > captionLimits.bytes)
    throw new Error('Invalid caption artifact');
  const decoded = gunzipSync(readFileSync(path), { maxOutputLength: captionLimits.bytes });
  const result = captionEnvelopeSchema.parse(JSON.parse(decoded.toString('utf8')));
  if (result.status === 'unavailable' && result.cues.length)
    throw new Error('Contradictory caption status');
  const speakers = new Set(manifest.players.map((player) => player.id)),
    ids = new Set<string>();
  for (const [index, cue] of result.cues.entries()) {
    if (
      ids.has(cue.id) ||
      cue.startTick < manifest.firstTick ||
      cue.endTick > manifest.lastTick ||
      cue.startTick >= cue.endTick ||
      (index > 0 && cue.startTick < result.cues[index - 1].startTick) ||
      (cue.speaker !== null && !speakers.has(cue.speaker))
    )
      throw new Error('Invalid caption cue');
    ids.add(cue.id);
  }
  return { result, bytes: info.size };
}
