/** Untrusted demo processing. Invoked as a disposable, time-bounded child by worker.ts. */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Decompress } from 'fzstd';
import { parseHeader, parseTicks, parseEvent, parseGrenades } from '@laihoe/demoparser2';
import type {
  Playback,
  Frame,
  Position,
  GameEvent,
  DeadTime,
  Grenade,
} from '../../shared/playback.js';
import { validateMagic } from './ingestion.js';
const finite = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const round = (v: unknown) => Math.round(finite(v) * 100) / 100;
export async function parse(folder: string, maxExpanded: number) {
  let source = join(
    folder,
    readdirSync(folder).find((n) => n.startsWith('input.'))!,
  );
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
  // Index is only one property. Native parsing stays outside the API event loop.
  const index = parseTicks(source, ['game_time']) as Record<string, any>[];
  const ticks = [...new Set(index.map((r) => r.tick as number))].sort((a, b) => a - b);
  if (!ticks.length || ticks.at(-1)! > 64 * 60 * 180)
    throw new Error('Demo has no ticks or exceeds 3 hours');
  const sampled = ticks.filter((t) => t % 4 === 0);
  if (sampled.length > 180000) throw new Error('Frame limit');
  const optional = [
    'armor_value',
    'balance',
    'active_weapon_ammo',
    'duck_amount',
    'flash_duration',
  ];
  let rows: Record<string, any>[];
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
  const warnings: string[] = [];
  try {
    rows = parseTicks(source, [...base, ...optional], sampled);
  } catch {
    rows = parseTicks(source, base, sampled);
    warnings.push('Equipment detail is unavailable in this demo.');
  }
  const roster = new Map<string, { id: string; name: string; team: number }>(),
    frames: Frame[] = [],
    deadTimes: DeadTime[] = [];
  let previous = -1,
    frame: Frame | undefined,
    segment: DeadTime | undefined;
  for (const r of rows) {
    if (![r.X, r.Y, r.Z].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    if (r.tick !== previous) {
      previous = r.tick;
      frame = { tick: r.tick, players: [] };
      frames.push(frame);
      const kind = r.is_technical_timeout
        ? 'technical'
        : r.is_ct_timeout || r.is_terrorist_timeout
          ? 'timeout'
          : r.is_freeze_period
            ? 'freeze'
            : null;
      if (segment && kind !== segment.kind) {
        segment.end = r.tick;
        deadTimes.push(segment);
        segment = undefined;
      }
      if (kind && !segment) segment = { start: r.tick, end: r.tick, kind };
    }
    const id = String(r.steamid);
    roster.set(id, { id, name: String(r.name || 'Player').slice(0, 80), team: finite(r.team_num) });
    const p: Position = {
      id,
      x: round(r.X),
      y: round(r.Y),
      z: round(r.Z),
      yaw: round(r.yaw),
      pitch: round(r.pitch),
      health: finite(r.health),
      team: finite(r.team_num),
      alive: Boolean(r.is_alive),
      weapon: String(r.active_weapon_name || '').slice(0, 50),
    };
    if (r.armor_value !== undefined) p.armor = finite(r.armor_value);
    if (r.balance !== undefined) p.money = finite(r.balance);
    if (r.active_weapon_ammo !== undefined) p.ammo = finite(r.active_weapon_ammo);
    if (r.duck_amount !== undefined) p.duck = round(r.duck_amount);
    if (r.flash_duration !== undefined) p.flash = round(r.flash_duration);
    frame!.players.push(p);
  }
  if (segment) {
    segment.end = frames.at(-1)!.tick;
    deadTimes.push(segment);
  }
  if (!frames.length || roster.size > 64) throw new Error('Invalid roster');
  // Some native versions do not promise row ordering. Keep grouping stable.
  frames.sort((a, b) => a.tick - b.tick);
  const events: GameEvent[] = [];
  for (const kind of [
    'player_death',
    'player_hurt',
    'weapon_fire',
    'round_start',
    'round_freeze_end',
    'round_end',
    'bomb_planted',
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
      for (const r of parseEvent(source, kind) as any[])
        events.push({ ...r, type: kind, tick: r.tick });
    } catch {
      warnings.push(`Event ${kind} is unavailable.`);
    }
  }
  events.sort((a, b) => a.tick - b.tick);
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
      winner: end?.winner,
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
  const grenades: Grenade[] = [];
  try {
    const raw = parseGrenades(source, undefined, false) as any[];
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
  const data: Playback = {
    version: 1,
    map: String(header.map_name || 'unknown').slice(0, 80),
    tickRate,
    sample: false,
    players: [...roster.values()],
    frames,
    events,
    rounds,
    deadTimes,
    grenades,
    warnings,
  };
  const serialized = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  // Bound client memory as well as server output. Long demos fail honestly rather than crashing mobile browsers.
  if (Buffer.byteLength(serialized) > 200 * 1024 ** 2)
    throw new Error('Playback output exceeds 200MB');
  const { Readable } = await import('node:stream');
  await pipeline(
    Readable.from([serialized]),
    createGzip(),
    createWriteStream(join(folder, 'playback.tmp'), { mode: 0o600 }),
  );
  renameSync(join(folder, 'playback.tmp'), join(folder, 'playback.json.gz'));
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
    writeFileSync(join(process.argv[2], 'failure.txt'), String(e?.name || 'ParserError'));
    process.exit(1);
  });
