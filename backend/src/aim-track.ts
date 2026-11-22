import { parseTicks } from '@laihoe/demoparser2';
import { encodeAimChunk, quantizeAim, type AimChunk, type AimSample } from './aim-track-wire.js';
import { playerColumns } from './parser-fields.js';

export type AimSlices = (start: number, end: number) => AimChunk | undefined | null;

const missing = -32768;
const duplicate = -32767;
const maxBatchTicks = 16384;
const maxBatchRows = 262144;
const retainedBytes = 32 * 1024 ** 2;
const pawnField = 'CCSPlayerController.m_hPlayerPawn';
const fields = ['yaw', 'pitch', 'is_alive', 'X', 'Y', 'Z', pawnField];

type PlayerAim = {
  angles: Int16Array;
  connected: Uint8Array;
  previous?: { tick: number; x: number; y: number; z: number; pawn: number };
};

function readBatch(
  source: string,
  start: number,
  end: number,
  origin: number,
  players: Map<string, PlayerAim>,
  query: typeof parseTicks,
) {
  const ticks = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const raw = query(source, fields, ticks, [...players.keys()], true);
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0)
    return;
  const columns = playerColumns(raw, maxBatchRows);
  if (columns.tick.length === 0) return;
  if (fields.some((field) => !columns[field])) throw new Error('Missing recorded aim columns');

  // Sort indices only. The native columns stay scoped to this batch.
  const order = Uint32Array.from(columns.tick, (_, index) => index);
  order.sort((a, b) => Number(columns.tick[a]) - Number(columns.tick[b]));
  for (const index of order) {
    const tick = columns.tick[index];
    const id = columns.steamid[index];
    if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < start || tick > end)
      throw new Error('Invalid recorded aim tick');
    const player = typeof id === 'string' ? players.get(id) : undefined;
    if (!player) continue;
    const offset = tick - origin;
    const slot = offset * 2;
    const yaw = quantizeAim(columns.yaw[index]);
    const pitch = quantizeAim(columns.pitch[index]);
    const x = columns.X[index],
      y = columns.Y[index],
      z = columns.Z[index];
    const pawn = columns[pawnField][index];
    if (player.angles[slot] !== missing) {
      player.angles[slot] = duplicate;
      player.previous = undefined;
      continue;
    }
    // Mark the row seen even when unusable, so a second row with the same
    // identity and tick cannot supply an ambiguous sample.
    player.angles[slot] = duplicate;
    if (columns.is_alive[index] !== true || yaw === undefined || pitch === undefined) continue;
    player.angles[slot] = yaw;
    player.angles[slot + 1] = pitch;
    const previous = player.previous;
    if (
      typeof x === 'number' &&
      Number.isFinite(x) &&
      typeof y === 'number' &&
      Number.isFinite(y) &&
      typeof z === 'number' &&
      Number.isFinite(z) &&
      typeof pawn === 'number' &&
      Number.isSafeInteger(pawn) &&
      pawn > 0 &&
      pawn < 0xffffffff
    ) {
      if (
        previous?.pawn === pawn &&
        previous.tick === tick - 1 &&
        Math.hypot(x - previous.x, y - previous.y, z - previous.z) <= 128
      )
        player.connected[offset] = 1;
      player.previous = { tick, x, y, z, pawn };
    } else player.previous = undefined;
  }
}

/** Optional narrow native passes. Retain only quantized angles and a continuity
 * byte per actor/tick. Never retain native arrays into another pass. */
export function readAimSlices(
  source: string,
  first: number,
  last: number,
  ids: string[],
  roundStarts: ReadonlySet<number>,
  query = parseTicks,
): AimSlices | undefined {
  const actors = ids.filter((id) => /^[1-9][0-9]{0,19}$/.test(id));
  const span = last - first + 1;
  if (!actors.length || actors.length > 128 || span * actors.length * 5 > retainedBytes) return;
  const players = new Map(
    actors.map((id): [string, PlayerAim] => [
      id,
      { angles: new Int16Array(span * 2).fill(missing), connected: new Uint8Array(span) },
    ]),
  );
  const batchTicks = Math.min(maxBatchTicks, Math.floor(maxBatchRows / players.size));
  try {
    for (let start = first; start <= last; start += batchTicks)
      readBatch(source, start, Math.min(last, start + batchTicks - 1), first, players, query);
  } catch {
    // Optional native fields can be absent on a different demo schema.
    return;
  }
  return (start, end) => {
    function* samples(player: PlayerAim): Generator<AimSample> {
      for (let tick = start; tick <= end; tick++) {
        const offset = tick - first;
        const yaw = player.angles[offset * 2];
        if (yaw === missing || yaw === duplicate) continue;
        yield [
          tick,
          yaw,
          player.angles[offset * 2 + 1],
          player.connected[offset] === 1 && !roundStarts.has(tick),
        ];
      }
    }
    return encodeAimChunk(
      start,
      end,
      new Map([...players].map(([id, player]) => [id, samples(player)])),
    );
  };
}
