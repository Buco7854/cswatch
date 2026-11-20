import { SmokeDensitySimulation, decodeSmokeVoxelJournal, mortonDecode3 } from 'cs2parser/browser';
import { smokeLimits, type SmokeTrack } from '../../shared/smoke-state.mjs';
import type { SmokeDensityRequest, SmokeDensityResult } from './smoke-render-state';

type Journal = {
  track: SmokeTrack;
  frames: { end: number; record: ReturnType<typeof decodeSmokeVoxelJournal>[number] }[];
  simulation: SmokeDensitySimulation;
  offset: number;
};
const live = new Map<string, Journal>();
const maximumCells = 4096;
const unit = 20 * 0.0254;

function prepare(track: SmokeTrack): Journal {
  const encoded = Uint8Array.from(atob(track.journal), (byte) => byte.charCodeAt(0));
  if (encoded.length > smokeLimits.journalBytes) throw new Error('Smoke journal limit');
  const frames = decodeSmokeVoxelJournal(encoded);
  if (!frames.length || frames.length > smokeLimits.frames) throw new Error('Smoke frame limit');
  let end = 0;
  return {
    track,
    frames: frames.map((record) => ({ end: (end += 4 + record.payload.length), record })),
    simulation: new SmokeDensitySimulation(track.origin),
    offset: 0,
  };
}

function densityCells(state: Journal, end: number) {
  if (end < state.offset) state.simulation = new SmokeDensitySimulation(state.track.origin);
  while (state.simulation.seq + 1 < state.frames.length) {
    const { end: offset, record } = state.frames[state.simulation.seq + 1];
    if (offset > end) break;
    state.simulation.step(record);
  }
  if (state.frames[state.simulation.seq]?.end !== end)
    throw new Error('Invalid smoke journal range');
  state.offset = end;
  const density = state.simulation.snapshot().density;
  let count = 0;
  for (const sample of density) if (sample >= 0.09) count++;
  if (count > maximumCells) throw new Error('Smoke cell limit');
  const cells = new Float32Array(count * 4);
  let cursor = 0;
  for (let index = 0; index < density.length; index++) {
    const value = density[index];
    if (!(value >= 0.09)) continue;
    const [x, y, z] = mortonDecode3(index);
    cells[cursor++] = (x - 15.5) * unit;
    cells[cursor++] = (z - 15.5) * unit;
    cells[cursor++] = (15.5 - y) * unit;
    cells[cursor++] = Math.min(1, Math.log1p(value) / Math.log1p(40));
  }
  return cells;
}

self.onmessage = ({ data }: MessageEvent<SmokeDensityRequest>) => {
  const current = new Set(data.targets.map(({ key }) => key));
  for (const key of live.keys()) if (!current.has(key)) live.delete(key);
  const result: SmokeDensityResult[] = [];
  for (const { key, track, offset, updateTick } of data.targets.slice(0, smokeLimits.active)) {
    try {
      let old = live.get(key);
      if (!old) live.set(key, (old = prepare(track)));
      result.push({ key, updateTick, cells: densityCells(old, offset) });
    } catch {
      live.delete(key);
      result.push({ key, updateTick });
    }
  }
  self.postMessage(result, {
    transfer: result.flatMap(({ cells }) => (cells ? [cells.buffer] : [])),
  });
};
