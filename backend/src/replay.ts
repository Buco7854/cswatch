import { lstatSync, readFileSync, opendirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Playback, PlaybackManifest, PlaybackChunk, Grenade } from '../../shared/playback.js';
import { opusDuration } from './voice-packets.js';

export const replayLimits = {
  chunkFrames: 480,
  contextFrames: 80,
  chunks: 512,
  chunkBytes: 4 * 1024 ** 2,
  manifestBytes: 16 * 1024 ** 2,
  totalBytes: 512 * 1024 ** 2,
  storedBytes: 160 * 1024 ** 2,
} as const;
const tick = z
  .number()
  .int()
  .min(0)
  .max(64 * 60 * 180);
const coordinate = z.number().finite().min(-1e7).max(1e7);
const point = z.object({ tick, x: coordinate, y: coordinate, z: coordinate }).strict();
const buttonMask = z
  .string()
  .regex(/^\d{1,20}$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const input = z
  .object({
    source: z.enum(['usercmd', 'network']),
    buttons: buttonMask.optional(),
    pressedButtons: buttonMask.optional(),
    releasedButtons: buttonMask.optional(),
    forward: z.boolean().optional(),
    back: z.boolean().optional(),
    left: z.boolean().optional(),
    right: z.boolean().optional(),
    jump: z.boolean().optional(),
    duck: z.boolean().optional(),
    walk: z.boolean().optional(),
    attack: z.boolean().optional(),
    attack2: z.boolean().optional(),
    reload: z.boolean().optional(),
    use: z.boolean().optional(),
    mouseDx: z.number().int().min(-2147483648).max(2147483647).optional(),
    mouseDy: z.number().int().min(-2147483648).max(2147483647).optional(),
  })
  .strict();
const position = z
  .object({
    id: z.string().max(40),
    x: coordinate,
    y: coordinate,
    z: coordinate,
    yaw: coordinate,
    pitch: coordinate,
    health: z.number().finite().min(0).max(10000),
    team: z.number().int().min(0).max(255),
    alive: z.boolean(),
    weapon: z.string().max(100),
    armor: z.number().finite().optional(),
    money: z.number().finite().optional(),
    ammo: z.number().finite().optional(),
    duck: z.number().finite().optional(),
    flash: z.number().finite().optional(),
    helmet: z.boolean().optional(),
    defuser: z.boolean().optional(),
    scoped: z.boolean().optional(),
    defusing: z.boolean().optional(),
    equipmentValue: z.number().int().min(0).max(1000000000).optional(),
    startMoney: z.number().int().min(0).max(1000000000).optional(),
    spentThisRound: z.number().int().min(0).max(1000000000).optional(),
    inventory: z.array(z.string().max(80)).max(64).optional(),
    input: input.optional(),
  })
  .strict();
const grenade = z
  .object({ id: z.string().max(100), kind: z.string().max(100), points: z.array(point).max(5000) })
  .strict();
const frame = z.object({ tick, players: z.array(position).min(1).max(128) }).strict();
const mediaTick = z
  .number()
  .finite()
  .min(0)
  .max(64 * 60 * 180 + 128);
const speaker = z.string().regex(/^\d{1,20}$/);
export const voicePacketSchema = z
  .object({
    id: z.string().max(80),
    speaker,
    tick: mediaTick,
    opus: z
      .string()
      .min(4)
      .max(10924)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    sampleRate: z.union([
      z.literal(8000),
      z.literal(12000),
      z.literal(16000),
      z.literal(24000),
      z.literal(48000),
    ]),
    channels: z.union([z.literal(1), z.literal(2)]),
    durationMs: z.number().finite().min(2.5).max(120),
  })
  .strict()
  .superRefine((packet, context) => {
    try {
      const bytes = Buffer.from(packet.opus, 'base64');
      if (
        bytes.toString('base64') !== packet.opus ||
        opusDuration(bytes) !== packet.durationMs ||
        (bytes[0] & 4 ? 2 : 1) !== packet.channels
      )
        throw new Error();
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid recorded Opus packet' });
    }
  });
const chatMessageSchema = z
  .object({
    id: z.string().max(80),
    tick: mediaTick,
    speaker: speaker.nullable(),
    name: z.string().max(256),
    text: z.string().max(1000),
    channel: z.enum(['all', 'team', 'unknown']),
  })
  .strict();
export const captionCueSchema = z
  .object({
    id: z.string().max(80),
    startTick: mediaTick,
    endTick: mediaTick,
    speaker: speaker.nullable(),
    text: z.string().max(1000),
    source: z.enum(['local-transcription', 'imported']),
    language: z.string().max(20).optional(),
  })
  .strict();
const communicationInfoSchema = z
  .object({
    voice: z.enum(['available', 'absent', 'unsupported', 'partial']),
    chat: z.enum(['available', 'absent', 'encrypted', 'partial']),
    captions: z.enum(['disabled', 'ready', 'partial', 'failed', 'unavailable']),
    unsupportedPackets: z.number().int().min(0).max(10000000),
  })
  .strict();
const event = z
  .object({ type: z.string().max(100), tick })
  .catchall(z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]));
const descriptor = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(replayLimits.chunks - 1),
    startTick: tick,
    firstFrameTick: tick,
    endTick: tick,
    frames: z
      .number()
      .int()
      .min(1)
      .max(replayLimits.chunkFrames + replayLimits.contextFrames + 1),
    bytes: z.number().int().min(1).max(replayLimits.chunkBytes),
  })
  .strict();
export const manifestSchema = z
  .object({
    version: z.literal(2),
    map: z.string().min(1).max(80),
    tickRate: z.number().int().min(1).max(128),
    sample: z.boolean(),
    players: z
      .array(
        z
          .object({
            id: z.string().max(40),
            name: z.string().max(256),
            team: z.number().int().min(0).max(255),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    rounds: z
      .array(
        z
          .object({
            number: z.number().int().min(0).max(1000),
            tick,
            liveTick: tick.optional(),
            endTick: tick.optional(),
            winner: z.number().int().min(0).max(255).optional(),
          })
          .strict(),
      )
      .max(1000),
    events: z.array(event).max(100000),
    deadTimes: z
      .array(
        z
          .object({ start: tick, end: tick, kind: z.enum(['freeze', 'timeout', 'technical']) })
          .strict(),
      )
      .max(10000)
      .optional(),
    warnings: z.array(z.string().max(1000)).max(100).optional(),
    chat: z.array(chatMessageSchema).max(10000).optional(),
    captions: z.array(captionCueSchema).max(20000).optional(),
    communications: communicationInfoSchema.optional(),
    capabilities: z
      .object({
        economy: z.boolean(),
        equipment: z.boolean(),
        inventory: z.boolean(),
        inputButtons: z.enum(['usercmd', 'network', 'unavailable']),
        mouseInput: z.boolean(),
        utilityThrows: z.boolean(),
      })
      .strict()
      .optional(),
    worldBounds: z
      .object({
        minX: coordinate,
        minY: coordinate,
        minZ: coordinate,
        maxX: coordinate,
        maxY: coordinate,
        maxZ: coordinate,
      })
      .strict()
      .optional(),
    firstTick: tick,
    lastTick: tick,
    chunks: z.array(descriptor).min(1).max(replayLimits.chunks),
  })
  .strict();
export const chunkSchema = z
  .object({
    version: z.literal(2),
    index: z
      .number()
      .int()
      .min(0)
      .max(replayLimits.chunks - 1),
    frames: z
      .array(frame)
      .min(1)
      .max(replayLimits.chunkFrames + replayLimits.contextFrames + 1),
    grenades: z.array(grenade).max(20000),
    voice: z.array(voicePacketSchema).max(50000).optional(),
  })
  .strict();

function grenadeSlice(paths: Grenade[], start: number, end: number): Grenade[] {
  return paths.flatMap((path) => {
    if (!path.points.length || path.points[0].tick > end || path.points.at(-1)!.tick < start)
      return [];
    const first = path.points.findIndex((p) => p.tick >= start);
    const after = path.points.findIndex((p) => p.tick > end);
    return [
      {
        ...path,
        points: path.points.slice(Math.max(0, first - 1), after < 0 ? undefined : after + 1),
      },
    ];
  });
}

/** Each adjacent chunk shares its boundary frame, preserving interpolation across seeks. */
export async function writeReplay(folder: string, data: Playback): Promise<void> {
  if (!data.frames.length) throw new Error('No replay frames');
  const { version: _version, frames, grenades, voice, ...metadata } = data;
  const manifest: PlaybackManifest = {
    ...metadata,
    version: 2,
    firstTick: frames[0].tick,
    lastTick: frames.at(-1)!.tick,
    chunks: [],
  };
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  for (const frame of frames)
    for (const player of frame.players) {
      bounds.minX = Math.min(bounds.minX, player.x);
      bounds.maxX = Math.max(bounds.maxX, player.x);
      bounds.minY = Math.min(bounds.minY, player.y);
      bounds.maxY = Math.max(bounds.maxY, player.y);
      bounds.minZ = Math.min(bounds.minZ, player.z);
      bounds.maxZ = Math.max(bounds.maxZ, player.z);
    }
  manifest.worldBounds = bounds;
  mkdirSync(join(folder, 'chunks'), { recursive: true, mode: 0o700 });
  let rawTotal = 0,
    storedTotal = 0;
  for (
    let offset = 0, index = 0;
    offset < frames.length;
    offset += replayLimits.chunkFrames, index++
  ) {
    // A boundary frame already included as the previous chunk's final frame needs no singleton tail.
    if (offset === frames.length - 1 && index > 0) break;
    if (index >= replayLimits.chunks) throw new Error('Replay has too many chunks');
    const part = frames.slice(
      Math.max(0, offset - replayLimits.contextFrames),
      offset + replayLimits.chunkFrames + 1,
    );
    const payload: PlaybackChunk = {
      version: 2,
      index,
      frames: part,
      grenades: grenadeSlice(grenades || [], part[0].tick, part.at(-1)!.tick),
      ...(voice?.length
        ? {
            voice: voice.filter(
              (packet) =>
                packet.tick >= Math.max(0, part[0].tick - 128) &&
                packet.tick <= part.at(-1)!.tick + 64,
            ),
          }
        : {}),
    };
    const json = JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? String(v) : v));
    const bytes = Buffer.byteLength(json);
    rawTotal += bytes;
    if (bytes > replayLimits.chunkBytes || rawTotal > replayLimits.totalBytes)
      throw new Error('Replay output limit');
    const compressed = gzipSync(json);
    storedTotal += compressed.length;
    if (storedTotal > replayLimits.storedBytes) throw new Error('Stored replay limit');
    writeFileSync(join(folder, 'chunks', `${index}.json.gz`), compressed, {
      mode: 0o600,
      flag: 'wx',
    });
    manifest.chunks.push({
      index,
      startTick: frames[offset].tick,
      firstFrameTick: part[0].tick,
      endTick: part.at(-1)!.tick,
      frames: part.length,
      bytes,
    });
  }
  const json = JSON.stringify(manifest, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  if (Buffer.byteLength(json) > replayLimits.manifestBytes)
    throw new Error('Replay metadata limit');
  writeFileSync(join(folder, 'manifest.json.gz'), gzipSync(json), { mode: 0o600, flag: 'wx' });
}

function regularFile(path: string, limit: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit)
    throw new Error('Invalid replay artifact');
  return stat.size;
}
/** Native child output is untrusted. Validate and bound it before publishing any artifact. */
export function validateReplayArtifacts(folder: string): {
  files: string[];
  bytes: number;
  manifest: PlaybackManifest;
} {
  const files = ['manifest.json.gz'];
  let bytes = regularFile(join(folder, files[0]), replayLimits.manifestBytes);
  const decode = (path: string, max: number) =>
    gunzipSync(readFileSync(path), { maxOutputLength: max });
  const manifest = manifestSchema.parse(
    JSON.parse(decode(join(folder, files[0]), replayLimits.manifestBytes).toString('utf8')),
  );
  if (
    manifest.firstTick > manifest.lastTick ||
    manifest.chunks[0].startTick !== manifest.firstTick ||
    manifest.chunks.at(-1)!.endTick !== manifest.lastTick
  )
    throw new Error('Invalid replay bounds');
  const chunksDir = lstatSync(join(folder, 'chunks'));
  if (!chunksDir.isDirectory() || chunksDir.isSymbolicLink())
    throw new Error('Invalid replay directory');
  const directory = opendirSync(join(folder, 'chunks'));
  let count = 0;
  try {
    while (directory.readSync()) {
      if (++count > manifest.chunks.length) throw new Error('Unexpected replay files');
    }
  } finally {
    directory.closeSync();
  }
  if (count !== manifest.chunks.length) throw new Error('Missing replay files');
  let rawTotal = 0;
  for (const [i, info] of manifest.chunks.entries()) {
    if (
      info.index !== i ||
      info.firstFrameTick > info.startTick ||
      info.startTick > info.endTick ||
      (i > 0 && info.startTick !== manifest.chunks[i - 1].endTick)
    )
      throw new Error('Invalid chunk sequence');
    const path = `chunks/${i}.json.gz`;
    bytes += regularFile(join(folder, path), replayLimits.chunkBytes);
    if (bytes > replayLimits.storedBytes) throw new Error('Stored replay limit');
    const json = decode(join(folder, path), replayLimits.chunkBytes);
    rawTotal += json.byteLength;
    if (rawTotal > replayLimits.totalBytes || json.byteLength !== info.bytes)
      throw new Error('Replay size mismatch');
    const chunk = chunkSchema.parse(JSON.parse(json.toString('utf8')));
    if (
      chunk.index !== i ||
      chunk.frames.length !== info.frames ||
      chunk.frames[0].tick !== info.firstFrameTick ||
      chunk.frames.at(-1)!.tick !== info.endTick ||
      !chunk.frames.some((frame) => frame.tick === info.startTick)
    )
      throw new Error('Replay chunk mismatch');
    if (chunk.frames.some((f, n) => n > 0 && f.tick <= chunk.frames[n - 1].tick))
      throw new Error('Unordered replay frames');
    files.push(path);
  }
  return { files, bytes, manifest };
}
