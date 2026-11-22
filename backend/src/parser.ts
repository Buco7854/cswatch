/** Untrusted demo processing. Invoked as a disposable, time-bounded child by worker.ts. */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Decompress } from 'fzstd';
import { parseHeader, parseTicks, parseEvent, parseGrenades } from '@laihoe/demoparser2';
import type { Playback, GameEvent, Grenade } from '../../shared/playback.js';
import { validateMagic } from './demo-format.js';
import { collectColumnFrameState } from './frame-state.js';
import { writeReplay } from './replay.js';
import { playerColumns, readPlayerColumns, recordedCameraFov } from './parser-fields.js';
import { replayCapabilities } from './player-input.js';
import { readCommunications } from './communications.js';
import {
  collectThrowInputs,
  eventInputFields,
  readEventRows,
  removeEventInputExtras,
} from './throw-input.js';
import type { EventAvailability } from '../../shared/match-state.js';
import { classifyParserFailure } from './parser-failure.js';
import { recordedRoundWinner } from './rounds.js';
import { readAimSlices } from './aim-track.js';
const finite = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const round = (v: unknown) => Math.round(finite(v) * 100) / 100;
const maximumTick = 64 * 60 * 180;

/** Scope the native index away before querying detailed state. Its implicit
 * name/Steam ID columns cover every player at 64 Hz, even for one wanted prop. */
function readSampledTicks(source: string) {
  const columns = playerColumns(
    parseTicks(source, ['game_time'], undefined, undefined, true),
    maximumTick * 64,
  );
  const ticks = new Set<number>();
  let first = Infinity,
    last = -Infinity;
  for (const value of columns.tick) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
    if (value > maximumTick) throw new Error('Demo has no ticks or exceeds 3 hours');
    first = Math.min(first, value);
    last = Math.max(last, value);
    if (value % 4 === 0) ticks.add(value);
  }
  if (!Number.isFinite(first)) throw new Error('Demo has no ticks or exceeds 3 hours');
  // Keep the actual playback edges even when they are off the four-tick grid.
  ticks.add(first);
  ticks.add(last);
  const sampled = [...ticks].sort((a, b) => a - b);
  if (sampled.length > 180000) throw new Error('Frame limit');
  return sampled;
}

/** Return projected frames only, so raw native columns cannot survive through
 * the subsequent event/media passes in the outer async parser's live locals. */
function readFrames(source: string, sampled: number[]) {
  const base = [
    'X',
    'Y',
    'Z',
    'yaw',
    'pitch',
    'health',
    'team_num',
    'is_alive',
    'active_weapon_name',
    'is_freeze_period',
    'is_ct_timeout',
    'is_terrorist_timeout',
    'is_technical_timeout',
  ];
  const columns = readPlayerColumns(
    (fields) => parseTicks(source, fields, sampled, undefined, true),
    base,
    [
      [
        'armor_value',
        'balance',
        'active_weapon_ammo',
        'duck_amount',
        'flash_duration',
        'has_helmet',
        'has_defuser',
        'is_scoped',
        'is_defusing',
        'current_equip_value',
        'start_balance',
        'cash_spent_this_round',
        'inventory',
      ],
      [
        'buttons',
        'FORWARD',
        'BACK',
        'LEFT',
        'RIGHT',
        'JUMP',
        'DUCK',
        'WALK',
        'FIRE',
        'RIGHTCLICK',
        'RELOAD',
        'USE',
      ],
      [
        'usercmd_buttonstate_1',
        'usercmd_buttonstate_2',
        'usercmd_buttonstate_3',
        'usercmd_buttons_held',
        'usercmd_buttons_pressed',
        'usercmd_buttons_released',
        'usercmd_mouse_dx',
        'usercmd_mouse_dy',
      ],
      ['kills_total', 'deaths_total', 'assists_total', 'headshot_kills_total', 'damage_total'],
      ['active_weapon', 'is_in_reload'],
      [recordedCameraFov],
    ],
    sampled.length * 64,
  );
  return collectColumnFrameState(columns);
}

export async function parse(folder: string, maxExpanded: number) {
  let source = join(
    folder,
    readdirSync(folder).find((n) => n.startsWith('input.'))!,
  );
  if (!Number.isSafeInteger(maxExpanded) || maxExpanded < 1 || statSync(source).size > maxExpanded)
    throw new Error('Expanded limit exceeded');
  const expanded = join(folder, 'expanded.dem');
  if (!source.endsWith('.dem')) {
    let total = 0;
    const bound = (chunk: Uint8Array) => {
      total += chunk.length;
      if (total > maxExpanded) throw new Error('Expanded limit exceeded');
    };
    if (source.endsWith('.gz')) {
      await pipeline(
        createReadStream(source),
        createGunzip(),
        new Transform({
          transform(chunk, _, cb) {
            try {
              bound(chunk);
              cb(null, chunk);
            } catch (e) {
              cb(e as Error);
            }
          },
        }),
        createWriteStream(expanded, { mode: 0o600 }),
      );
    } else {
      const fd = openSync(expanded, 'w', 0o600);
      const decompressor = new Decompress((chunk) => {
        bound(chunk);
        writeSync(fd, chunk);
      });
      try {
        for await (const chunk of createReadStream(source, { highWaterMark: 65536 }))
          decompressor.push(chunk);
        decompressor.push(new Uint8Array(), true);
      } finally {
        closeSync(fd);
      }
    }
    source = expanded;
  }
  validateMagic(source, '.dem');
  const header = parseHeader(source),
    tickRate = 64;
  const { frames, players, deadTimes } = readFrames(source, readSampledTicks(source));
  const warnings: string[] = [];
  const events: GameEvent[] = [];
  const eventAvailability: EventAvailability = { player_death: false, player_hurt: false };
  for (const kind of [
    'player_death',
    'player_hurt',
    'weapon_fire',
    'grenade_thrown',
    'round_start',
    'round_freeze_end',
    'round_end',
    'bomb_planted',
    'bomb_beginplant',
    'bomb_abortplant',
    'bomb_begindefuse',
    'bomb_abortdefuse',
    'bomb_defused',
    'bomb_exploded',
    'smokegrenade_detonate',
    'smokegrenade_expired',
    'flashbang_detonate',
    'hegrenade_detonate',
    'inferno_startburn',
    'inferno_expire',
  ]) {
    try {
      let parsed: any[];
      if (kind === 'weapon_fire' || kind === 'grenade_thrown') {
        parsed = readEventRows(
          (fields) => parseEvent(source, kind, fields),
          [
            ['X', 'Y', 'Z'],
            eventInputFields.filter((field) => !field.startsWith('usercmd_')),
            eventInputFields.filter((field) => field.startsWith('usercmd_')),
          ],
        );
      } else if (kind === 'player_death' || kind === 'player_hurt') {
        parsed = readEventRows((fields) => parseEvent(source, kind, fields), [['team_num']]);
        eventAvailability[kind] = true;
      } else if (kind.startsWith('bomb_')) {
        try {
          parsed = parseEvent(source, kind, ['has_defuser'], ['game_time']);
        } catch {
          parsed = parseEvent(source, kind);
        }
      } else parsed = parseEvent(source, kind);
      for (const r of parsed) events.push({ ...r, type: kind, tick: r.tick });
    } catch {
      warnings.push(`Event ${kind} is unavailable.`);
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  const throwInputs = collectThrowInputs(events, players);
  removeEventInputExtras(events);
  if (!throwInputs.complete) warnings.push('Throw input metadata reached the processing limit.');
  const starts = events.filter((e) => e.type === 'round_start');
  const rounds = starts.map((e, i) => {
    const next = starts[i + 1]?.tick ?? Infinity;
    const live = events.find(
        (x) => x.type === 'round_freeze_end' && x.tick >= e.tick && x.tick < next,
      ),
      end = events.find((x) => x.type === 'round_end' && x.tick >= e.tick && x.tick < next);
    return {
      number: i + 1,
      tick: e.tick,
      liveTick: live?.tick,
      endTick: end?.tick,
      winner: recordedRoundWinner(end?.winner),
    };
  });
  if (!rounds.length)
    rounds.push({
      number: 1,
      tick: frames[0].tick,
      liveTick: undefined,
      endTick: undefined,
      winner: undefined,
    });
  const aim = readAimSlices(
    source,
    frames[0].tick,
    frames.at(-1)!.tick,
    players.map((player) => player.id),
    new Set(starts.map((event) => event.tick)),
  );
  const grenades: Grenade[] = [];
  try {
    const raw = (parseGrenades(source, undefined, false) as any[])
      .filter((row) => Number.isSafeInteger(row.tick) && row.tick >= 0 && row.tick <= 64 * 60 * 180)
      .sort((a, b) => a.tick - b.tick);
    const paths = new Map<string, Grenade>();
    for (const r of raw) {
      if (r.tick % 4 !== 0) continue;
      if (
        ![r.X ?? r.x, r.Y ?? r.y, r.Z ?? r.z].every(
          (v) => typeof v === 'number' && Number.isFinite(v),
        )
      )
        continue;
      const id = String(r.entity_id ?? r.entityid ?? r.grenade_entity_id ?? r.unique_id ?? '');
      if (!id) continue;
      let g = paths.get(id);
      if (g && r.tick - (g.points.at(-1)?.tick ?? r.tick) > 128) {
        grenades.push(g);
        paths.delete(id);
        g = undefined;
      }
      if (!g) {
        g = {
          id: id + '-' + String(r.tick),
          kind: String(r.grenade_type ?? r.name ?? 'grenade'),
          points: [],
        };
        paths.set(id, g);
      }
      if (r.tick % 4 === 0)
        g.points.push({
          tick: r.tick,
          x: round(r.X ?? r.x),
          y: round(r.Y ?? r.y),
          z: round(r.Z ?? r.z),
        });
    }
    grenades.push(...paths.values());
  } catch {
    warnings.push('Grenade trajectories are unavailable.');
  }
  const media = await readCommunications(
    source,
    tickRate,
    frames.at(-1)!.tick,
    new Set(players.map((player) => player.id)),
    events,
    frames,
  );
  warnings.push(...media.warnings);
  const data: Playback = {
    version: 1,
    map: String(header.map_name || 'unknown').slice(0, 80),
    tickRate,
    sample: false,
    players,
    frames,
    events,
    rounds,
    deadTimes,
    grenades,
    warnings,
    capabilities: replayCapabilities(frames, events),
    mapIdentity: media.mapIdentity,
    voice: media.voice,
    chat: media.chat,
    communications: media.communications,
    gameplaySounds: media.gameplaySounds,
    sounds: media.sounds,
    objectives: media.objectives,
    matchState: media.matchState,
    crosshairs: media.crosshairs,
    itemSamples: media.itemSamples,
    itemState: media.itemState,
    smokeTracks: media.smokeTracks,
    infernos: media.infernos,
    eventAvailability,
    throwInputs: throwInputs.snapshots,
  };
  await writeReplay(folder, data, true, aim);
  writeFileSync(
    join(folder, 'summary.json'),
    JSON.stringify({
      map: data.map,
      duration: (frames.at(-1)!.tick - frames[0].tick) / tickRate,
      rounds: rounds.length,
      players: data.players,
      firstTick: frames[0].tick,
      lastTick: frames.at(-1)!.tick,
      warnings,
    }),
  );
  if (existsSync(expanded)) unlinkSync(expanded);
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2])
  parse(process.argv[2], Number(process.argv[3]) * 1024 ** 2).catch((e) => {
    writeFileSync(join(process.argv[2], 'failure.txt'), JSON.stringify(classifyParserFailure(e)));
    process.exit(1);
  });
