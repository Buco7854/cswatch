import {
  lstatSync,
  readFileSync,
  opendirSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type {
  Playback,
  PlaybackManifest,
  PlaybackChunk,
  Grenade,
  Frame,
} from '../../shared/playback.js';
import { opusDuration } from './voice-packets.js';
import { isRecordedUtilityThrow } from './player-input.js';
import { crosshairCodePattern } from './crosshairs.js';
import { gameplaySoundRegistry } from './gameplay-sound-registry.js';
import { gameplaySoundLimits } from './gameplay-sounds.js';
import { mapIdentitySchema } from './map-identity.js';
import { validSmokeTracks } from './smoke-state-wire.js';
import type { SmokeTrack } from '../../shared/smoke-state.mjs';
import { recordedReloadTickLimit } from './parser-fields.js';
import {
  ItemArtifactValidator,
  ItemSliceIndex,
  itemSampleSchema,
  itemChunkSampleLimit,
} from './item-state-replay.js';

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
const objectiveDeadline = z
  .number()
  .finite()
  .min(0)
  .max(64 * 60 * 360);
const objectiveDuration = z.number().finite().positive().max(10800);
const objectiveActor = z.string().regex(/^\d{1,20}$/);
const objectiveBase = { tick, entity: z.string().min(1).max(80), present: z.boolean() };
export const objectiveSampleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...objectiveBase,
      kind: z.literal('plant'),
      arming: z.boolean().optional(),
      actor: objectiveActor.optional(),
      endTick: objectiveDeadline.optional(),
    })
    .strict(),
  z
    .object({
      ...objectiveBase,
      kind: z.literal('bomb'),
      ticking: z.boolean().optional(),
      beingDefused: z.boolean().optional(),
      defused: z.boolean().optional(),
      exploded: z.boolean().optional(),
      actor: objectiveActor.optional(),
      site: z.union([z.literal(0), z.literal(1)]).optional(),
      endTick: objectiveDeadline.optional(),
      duration: objectiveDuration.optional(),
      defuseEndTick: objectiveDeadline.optional(),
      defuseDuration: objectiveDuration.optional(),
    })
    .strict(),
]);
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
const matchClockSchema = z
  .object({
    kind: z.enum(['round', 'freeze', 'timeout', 'warmup']),
    startTick: objectiveDeadline.optional(),
    endTick: objectiveDeadline.optional(),
    paused: z.boolean().optional(),
    pausedAtTick: objectiveDeadline.optional(),
  })
  .strict();
export const matchStateSampleSchema = z
  .object({
    tick,
    ctScore: z.number().int().min(0).max(10000).optional(),
    tScore: z.number().int().min(0).max(10000).optional(),
    roundNumber: z.number().int().min(1).max(10000).optional(),
    roundNumberSource: z.enum(['round-start', 'completed-counter']).optional(),
    roundsPlayed: z.number().int().min(0).max(10000).optional(),
    overtime: z.number().int().min(0).max(10000).optional(),
    gamePhase: z.number().int().min(0).max(255).optional(),
    phase: z
      .enum([
        'warmup',
        'freeze',
        'live',
        'timeout',
        'technical',
        'paused',
        'round-end',
        'intermission',
        'game-over',
      ])
      .optional(),
    clock: matchClockSchema.optional(),
  })
  .strict();
const throwInputBase = {
  eventIndex: z.number().int().min(0).max(99999),
  tick,
  actorId: z.string().regex(/^\d{1,20}$/),
};
export const throwInputSnapshotSchema = z.discriminatedUnion('provenance', [
  z.object({ ...throwInputBase, provenance: z.literal('unavailable') }).strict(),
  z
    .object({
      ...throwInputBase,
      provenance: z.enum(['event-usercmd', 'event-network', 'nearby-network']),
      sampleTick: tick,
      input,
    })
    .strict(),
]);
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
    reloadStarted: tick.optional(),
    duck: z.number().finite().optional(),
    flash: z.number().finite().optional(),
    helmet: z.boolean().optional(),
    defuser: z.boolean().optional(),
    scoped: z.boolean().optional(),
    scopeFov: z.number().int().min(5).max(89).optional(),
    eyeOffset: z
      .union([
        z.tuple([z.number().min(1).max(96)]),
        z.tuple([
          z.number().min(-32).max(32),
          z.number().min(-32).max(32),
          z.number().min(1).max(96),
        ]),
      ])
      .optional(),
    defusing: z.boolean().optional(),
    equipmentValue: z.number().int().min(0).max(1000000000).optional(),
    startMoney: z.number().int().min(0).max(1000000000).optional(),
    spentThisRound: z.number().int().min(0).max(1000000000).optional(),
    inventory: z.array(z.string().max(80)).max(64).optional(),
    input: input.optional(),
    stats: z
      .object({
        kills: z.number().int().min(0).max(1000000000).optional(),
        deaths: z.number().int().min(0).max(1000000000).optional(),
        assists: z.number().int().min(0).max(1000000000).optional(),
        headshotKills: z.number().int().min(0).max(1000000000).optional(),
        damage: z.number().int().min(0).max(1000000000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const grenade = z
  .object({ id: z.string().max(100), kind: z.string().max(100), points: z.array(point).max(5000) })
  .strict();
const frame = z
  .object({ tick, players: z.array(position).min(1).max(128) })
  .strict()
  .refine(({ tick, players }) =>
    players.every(
      (player) =>
        player.reloadStarted === undefined ||
        (player.alive &&
          player.reloadStarted <= tick &&
          tick - player.reloadStarted < recordedReloadTickLimit),
    ),
  );
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
export const gameplaySoundCueSchema = z
  .object({
    id: z.string().min(1).max(100),
    tick: mediaTick,
    endTick: mediaTick.optional(),
    soundId: z.string().max(60),
    category: z.enum(['weapon', 'footstep', 'reload', 'utility', 'objective', 'round']),
    eventName: z.string().min(1).max(128).optional(),
    evidence: z.enum(['game-event', 'network-sound']),
    selection: z.enum(['representative', 'recorded']),
    actor: speaker.optional(),
    position: z.object({ x: coordinate, y: coordinate, z: coordinate }).strict().optional(),
    volume: z.number().finite().min(0).max(1).optional(),
    pitch: z.number().finite().min(0.25).max(4).optional(),
  })
  .strict()
  .refine(
    (cue) =>
      Object.hasOwn(gameplaySoundRegistry.items, cue.soundId) &&
      gameplaySoundRegistry.items[cue.soundId].category === cue.category,
    'Unknown sound or category',
  );
const soundCoverage = z.enum(['available', 'partial', 'unavailable']);
const gameplaySoundInfoSchema = z
  .object({
    coverage: z
      .object({
        weapon: soundCoverage,
        footstep: soundCoverage,
        reload: soundCoverage,
        utility: soundCoverage,
        objective: soundCoverage,
        round: soundCoverage,
      })
      .strict(),
    truncated: z.boolean(),
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
    mapIdentity: mapIdentitySchema.optional(),
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
    smokeTracks: z.custom<SmokeTrack[]>().optional(),
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
    gameplaySounds: gameplaySoundInfoSchema.optional(),
    objectives: z
      .object({ samples: z.array(objectiveSampleSchema).max(10000), complete: z.boolean() })
      .strict()
      .optional(),
    matchState: z
      .object({ complete: z.boolean(), samples: z.array(matchStateSampleSchema).max(10000) })
      .strict()
      .optional(),
    crosshairs: z
      .object({
        samples: z
          .array(
            z
              .object({
                tick,
                actor: z.string().regex(/^\d{1,20}$/),
                code: z.string().max(64).regex(crosshairCodePattern).nullable(),
              })
              .strict(),
          )
          .max(10000),
        complete: z.boolean(),
      })
      .strict()
      .optional(),
    itemState: z
      .object({
        complete: z.boolean(),
        coverage: z
          .object({ dropped: z.boolean(), planted: z.boolean(), projectile: z.boolean() })
          .strict()
          .optional(),
      })
      .strict()
      .refine(
        (info) => !info.coverage || info.complete === Object.values(info.coverage).every(Boolean),
      )
      .optional(),
    eventAvailability: z
      .object({ player_death: z.boolean(), player_hurt: z.boolean() })
      .strict()
      .optional(),
    throwInputs: z.array(throwInputSnapshotSchema).max(10000).optional(),
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
    sounds: z.array(gameplaySoundCueSchema).max(gameplaySoundLimits.chunkSamples).optional(),
    itemSamples: z.array(itemSampleSchema).max(itemChunkSampleLimit).optional(),
  })
  .strict();

function* grenadeSlice(paths: Grenade[], start: number, end: number): Generator<Grenade> {
  for (const path of paths) {
    if (!path.points.length || path.points[0].tick > end || path.points.at(-1)!.tick < start)
      continue;
    const first = path.points.findIndex((p) => p.tick >= start);
    const after = path.points.findIndex((p) => p.tick > end);
    yield {
      ...path,
      points: path.points.slice(Math.max(0, first - 1), after < 0 ? undefined : after + 1),
    };
  }
}

const replayJSON = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? String(item) : item));

/** Preceding samples support movement trails only. Their canonical chunk keeps
 * all metadata and is loaded whenever playback seeks into that earlier time. */
function trailFrame(frame: Frame): Frame {
  return {
    tick: frame.tick,
    players: frame.players.map(({ id, x, y, z, yaw, pitch, health, team, alive, weapon }) => ({
      id,
      x,
      y,
      z,
      yaw,
      pitch,
      health,
      team,
      alive,
      weapon,
    })),
  };
}

/** Each adjacent chunk shares its boundary frame, preserving interpolation across seeks. */
export async function writeReplay(folder: string, data: Playback): Promise<void> {
  const written: string[] = [];
  try {
    await writeReplayCore(folder, data, written);
  } catch (error) {
    if (
      data.sounds === undefined ||
      !(error instanceof Error) ||
      ![
        'Replay output limit',
        'Stored replay limit',
        'Replay has too many chunks',
        'Replay metadata limit',
      ].includes(error.message)
    )
      throw error;
    // Optional audio must not make an otherwise valid long replay unavailable.
    // Remove only files created by this invocation, preserving all primary data on the retry.
    for (const path of written) unlinkSync(path);
    const unavailable = 'unavailable' as const;
    await writeReplayCore(
      folder,
      {
        ...data,
        sounds: [],
        gameplaySounds: {
          coverage: {
            weapon: unavailable,
            footstep: unavailable,
            reload: unavailable,
            utility: unavailable,
            objective: unavailable,
            round: unavailable,
          },
          truncated: true,
        },
      },
      [],
    );
  }
}
async function writeReplayCore(folder: string, data: Playback, written: string[]): Promise<void> {
  if (!data.frames.length) throw new Error('No replay frames');
  const { version: _version, frames, grenades, voice, sounds, itemSamples, ...metadata } = data;
  const items = new ItemSliceIndex(itemSamples || []);
  if (frames.length > replayLimits.chunks * replayLimits.chunkFrames + 1)
    throw new Error('Replay has too many chunks');
  // Count one frame at a time, retaining only small numeric prefix sums. A rich
  // frame must not force a speculative many-megabyte chunk string allocation.
  const frameBytes = new Float64Array(frames.length + 1);
  const trailBytes = new Float64Array(frames.length + 1);
  for (let index = 0; index < frames.length; index++) {
    const bytes = Buffer.byteLength(replayJSON(frames[index]));
    if (bytes > replayLimits.chunkBytes) throw new Error('Replay output limit');
    frameBytes[index + 1] = frameBytes[index] + bytes + 1;
    trailBytes[index + 1] =
      trailBytes[index] + Buffer.byteLength(replayJSON(trailFrame(frames[index]))) + 1;
    if (frameBytes[index + 1] - 1 > replayLimits.totalBytes) throw new Error('Replay output limit');
  }
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
  for (let offset = 0, index = 0; offset < frames.length; index++) {
    if (index >= replayLimits.chunks) throw new Error('Replay has too many chunks');
    const contextStart = Math.max(0, offset - replayLimits.contextFrames);
    const context = frames.slice(contextStart, offset).map(trailFrame);
    const hasVoice = Boolean(voice?.length);
    const hasSounds = sounds !== undefined;
    const hasItems = itemSamples !== undefined;
    const itemsAt = items.from(frames[contextStart].tick);
    const overhead = Buffer.byteLength(
      replayJSON({
        version: 2,
        index,
        frames: [],
        grenades: [],
        ...(hasVoice ? { voice: [] } : {}),
        ...(hasSounds ? { sounds: [] } : {}),
        ...(hasItems ? { itemSamples: [] } : {}),
      }),
    );
    const candidate = (end: number) => {
      let bytes =
        overhead +
        trailBytes[offset] -
        trailBytes[contextStart] +
        frameBytes[end + 1] -
        frameBytes[offset] -
        1;
      if (bytes > replayLimits.chunkBytes) return null;
      const startTick = frames[contextStart].tick,
        endTick = frames[end].tick;
      const paths: Grenade[] = [];
      for (const path of grenadeSlice(grenades || [], startTick, endTick)) {
        bytes += Buffer.byteLength(replayJSON(path)) + (paths.length ? 1 : 0);
        if (bytes > replayLimits.chunkBytes) return null;
        paths.push(path);
      }
      const packets: NonNullable<Playback['voice']> = [];
      for (const packet of voice || []) {
        if (packet.tick < Math.max(0, startTick - 128) || packet.tick > endTick + 64) continue;
        bytes += Buffer.byteLength(replayJSON(packet)) + (packets.length ? 1 : 0);
        if (bytes > replayLimits.chunkBytes) return null;
        packets.push(packet);
      }
      const soundSlice = (sounds || []).filter(
        (cue) => cue.tick >= startTick && cue.tick <= endTick,
      );
      if (soundSlice.length > gameplaySoundLimits.chunkSamples) return null;
      for (const [i, cue] of soundSlice.entries()) {
        bytes += Buffer.byteLength(replayJSON(cue)) + (i ? 1 : 0);
        if (bytes > replayLimits.chunkBytes) return null;
      }
      const itemSlice = itemsAt(endTick);
      if (itemSlice.length > itemChunkSampleLimit) return null;
      for (const [itemIndex, sample] of itemSlice.entries()) {
        bytes += Buffer.byteLength(replayJSON(sample)) + (itemIndex ? 1 : 0);
        if (bytes > replayLimits.chunkBytes) return null;
      }
      return {
        end,
        bytes,
        payload: {
          version: 2 as const,
          index,
          frames: [...context, ...frames.slice(offset, end + 1)],
          grenades: paths,
          ...(hasVoice ? { voice: packets } : {}),
          ...(hasSounds ? { sounds: soundSlice } : {}),
          ...(hasItems ? { itemSamples: itemSlice } : {}),
        },
      };
    };
    const maximum = Math.min(frames.length - 1, offset + replayLimits.chunkFrames);
    let selected = candidate(maximum);
    if (!selected) {
      // For a fixed context, frame/trajectory/voice bytes grow with the end tick.
      // Keep the complete context and choose the largest bounded forward slice.
      let low = Math.min(offset + 1, maximum),
        high = maximum - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2),
          part = candidate(middle);
        if (part) {
          selected = part;
          low = middle + 1;
        } else high = middle - 1;
      }
    }
    // Never shrink trail history or omit primary-frame metadata, media or trajectories.
    if (!selected) throw new Error('Replay output limit');
    const { payload, end } = selected;
    const part = payload.frames;
    const json = replayJSON(payload);
    const bytes = Buffer.byteLength(json);
    rawTotal += bytes;
    if (
      bytes !== selected.bytes ||
      bytes > replayLimits.chunkBytes ||
      rawTotal > replayLimits.totalBytes
    )
      throw new Error('Replay output limit');
    const compressed = gzipSync(json);
    storedTotal += compressed.length;
    if (storedTotal > replayLimits.storedBytes) throw new Error('Stored replay limit');
    writeFileSync(join(folder, 'chunks', `${index}.json.gz`), compressed, {
      mode: 0o600,
      flag: 'wx',
    });
    written.push(join(folder, 'chunks', `${index}.json.gz`));
    manifest.chunks.push({
      index,
      startTick: frames[offset].tick,
      firstFrameTick: part[0].tick,
      endTick: part.at(-1)!.tick,
      frames: part.length,
      bytes,
    });
    // The shared boundary becomes the next start; the final boundary needs no
    // singleton tail chunk, including when the complete replay has one frame.
    if (end === frames.length - 1) break;
    offset = end;
  }
  if (!validSmokeTracks(manifest.smokeTracks, manifest.lastTick)) delete manifest.smokeTracks;
  let json = replayJSON(manifest);
  if (manifest.smokeTracks && Buffer.byteLength(json) > replayLimits.manifestBytes) {
    delete manifest.smokeTracks;
    json = replayJSON(manifest);
  }
  if (Buffer.byteLength(json) > replayLimits.manifestBytes)
    throw new Error('Replay metadata limit');
  writeFileSync(join(folder, 'manifest.json.gz'), gzipSync(json), { mode: 0o600, flag: 'wx' });
  written.push(join(folder, 'manifest.json.gz'));
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
    manifest.smokeTracks !== undefined &&
    !validSmokeTracks(manifest.smokeTracks, manifest.lastTick)
  )
    throw new Error('Invalid recorded smoke bank');
  if (
    manifest.firstTick > manifest.lastTick ||
    manifest.chunks[0].startTick !== manifest.firstTick ||
    manifest.chunks.at(-1)!.endTick !== manifest.lastTick
  )
    throw new Error('Invalid replay bounds');
  if (manifest.mapIdentity && manifest.mapIdentity.map !== manifest.map)
    throw new Error('Recorded map identity does not match replay map');
  const actors = new Set(manifest.players.map((player) => player.id));
  const itemValidator = new ItemArtifactValidator();
  for (const [index, sample] of (manifest.crosshairs?.samples || []).entries()) {
    if (
      sample.tick > manifest.lastTick ||
      !actors.has(sample.actor) ||
      (index > 0 && sample.tick < manifest.crosshairs!.samples[index - 1].tick)
    )
      throw new Error('Invalid recorded crosshair identity or time');
  }
  for (const [index, sample] of (manifest.matchState?.samples || []).entries()) {
    const clock = sample.clock;
    if (
      sample.tick > manifest.lastTick ||
      (index > 0 && sample.tick < manifest.matchState!.samples[index - 1].tick) ||
      (clock?.startTick !== undefined &&
        clock.endTick !== undefined &&
        clock.startTick > clock.endTick) ||
      (clock?.pausedAtTick !== undefined &&
        (clock.paused !== true || clock.pausedAtTick > sample.tick)) ||
      (sample.roundNumberSource !== undefined && sample.roundNumber === undefined) ||
      (sample.roundNumberSource === 'completed-counter' &&
        (sample.roundsPlayed === undefined ||
          (sample.roundNumber !== sample.roundsPlayed &&
            sample.roundNumber !== sample.roundsPlayed + 1)))
    )
      throw new Error('Invalid recorded match state time');
  }
  for (const [index, snapshot] of (manifest.throwInputs || []).entries()) {
    const event = manifest.events[snapshot.eventIndex];
    if (
      !event ||
      !isRecordedUtilityThrow(event) ||
      event.tick !== snapshot.tick ||
      snapshot.tick > manifest.lastTick ||
      event.user_steamid !== snapshot.actorId ||
      !actors.has(snapshot.actorId) ||
      (index > 0 && snapshot.eventIndex <= manifest.throwInputs![index - 1].eventIndex)
    )
      throw new Error('Invalid throw input event identity or time');
    if (snapshot.provenance !== 'unavailable') {
      if (
        snapshot.sampleTick > snapshot.tick ||
        (snapshot.provenance !== 'nearby-network' && snapshot.sampleTick !== snapshot.tick) ||
        (snapshot.provenance === 'nearby-network' &&
          snapshot.tick - snapshot.sampleTick > manifest.tickRate) ||
        snapshot.input.source !== (snapshot.provenance === 'event-usercmd' ? 'usercmd' : 'network')
      )
        throw new Error('Invalid throw input provenance or time');
    }
  }
  for (const [index, sample] of (manifest.objectives?.samples || []).entries()) {
    if (
      sample.tick > manifest.lastTick ||
      (index > 0 && sample.tick < manifest.objectives!.samples[index - 1].tick) ||
      (sample.actor !== undefined && !actors.has(sample.actor))
    )
      throw new Error('Invalid objective state identity or time');
  }
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
  const soundIdentities = new Map<string, string>();
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
    if (Boolean(manifest.gameplaySounds) !== (chunk.sounds !== undefined))
      throw Error('Gameplay sound capability mismatch');
    const chunkSoundIds = new Set<string>();
    for (const [n, cue] of (chunk.sounds || []).entries()) {
      const serialized = JSON.stringify(cue),
        previous = soundIdentities.get(cue.id);
      if (
        (cue.endTick !== undefined &&
          (cue.endTick < cue.tick || cue.endTick > manifest.lastTick)) ||
        cue.tick < info.firstFrameTick ||
        cue.tick > info.endTick ||
        (cue.actor !== undefined && !actors.has(cue.actor)) ||
        (n > 0 && cue.tick < chunk.sounds![n - 1].tick) ||
        chunkSoundIds.has(cue.id) ||
        (previous !== undefined && previous !== serialized)
      )
        throw Error('Invalid gameplay sound identity or time');
      chunkSoundIds.add(cue.id);
      soundIdentities.set(cue.id, serialized);
      if (soundIdentities.size > gameplaySoundLimits.samples)
        throw Error('Gameplay sound sample limit');
    }
    if (Boolean(manifest.itemState) !== (chunk.itemSamples !== undefined))
      throw new Error('Recorded item capability mismatch');
    if (chunk.itemSamples)
      itemValidator.validate(
        chunk.itemSamples,
        info.firstFrameTick,
        info.endTick,
        manifest.lastTick,
      );
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
