import {
  SmokeDensitySimulation,
  decodeSmokeVoxelFrame,
  decodeSmokeVoxelJournal,
  mortonDecode3,
} from 'cs2parser/browser';
import { smokeLimits, type SmokeTrack } from '../../shared/smoke-state.mjs';
import { GRID, densityField, type SmokeField } from './smoke-field.ts';

export function encodeDensity(density: Float32Array) {
  const ordered = new Uint8Array(GRID ** 3);
  if (density.length !== ordered.length) throw new Error('Smoke grid dimensions changed');
  for (let i = 0; i < ordered.length; i++) {
    if (!(density[i] > 0)) continue;
    const [x, y, z] = mortonDecode3(i);
    const sceneIndex = x + GRID * (z + GRID * (GRID - 1 - y));
    ordered[sceneIndex] = Math.round(255 * Math.min(density[i] / 50, 1));
  }
  return ordered;
}

/** The journal can be replayed from zero on backward seeks. Cache only the
 * latest pair so the maximum retained memory is independent of replay length. */
export function smokeJournal(track: SmokeTrack) {
  const encoded = Uint8Array.from(atob(track.journal), (byte) => byte.charCodeAt(0));
  if (encoded.length > smokeLimits.journalBytes) throw new Error('Smoke journal limit');
  const frames = decodeSmokeVoxelJournal(encoded);
  if (!frames.length || frames.length > smokeLimits.frames) throw new Error('Smoke frame limit');

  const ends = new Map<number, number>();
  let end = 0;
  let stoppedAt: number | undefined;
  for (const record of frames) {
    end += 4 + record.payload.length;
    ends.set(end, record.seq);
    if (stoppedAt === undefined && decodeSmokeVoxelFrame(record.payload).stopSeeding)
      stoppedAt = track.updates.find(([, offset]) => offset >= end)?.[0];
  }

  let simulation = new SmokeDensitySimulation(track.origin);
  let pair: { previous: SmokeField; current: SmokeField } | undefined;
  let pairedPrevious = -1;
  const field = () => densityField(encodeDensity(simulation.snapshot().density));
  const advance = (seq: number) => {
    while (simulation.seq < seq) simulation.step(frames[simulation.seq + 1]);
  };
  return (offset: number, previousOffset: number) => {
    const target = ends.get(offset);
    const previous = ends.get(previousOffset);
    if (previous === undefined || target === undefined || previous > target)
      throw new Error('Invalid smoke journal range');
    if (target !== simulation.seq || previous !== pairedPrevious || !pair) {
      let before: SmokeField;
      if (simulation.seq === previous && pair) {
        before = pair.current;
      } else {
        if (previous < simulation.seq) simulation = new SmokeDensitySimulation(track.origin);
        advance(previous);
        before = field();
      }
      advance(target);
      pair = { previous: before, current: previous === target ? before : field() };
      pairedPrevious = previous;
    }
    return { ...pair, stoppedAt };
  };
}
